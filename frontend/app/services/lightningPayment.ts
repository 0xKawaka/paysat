import lightBolt11 from "light-bolt11-decoder";
import type { AccountInterface, ProviderInterface } from "starknet";
import {
  executeCallsAndWait,
  formatLockForLnPaymentCalls,
} from "./starknetCalls";

const MSATS_PER_SAT = 1000n;

type NumericValue = bigint | number | string | null | undefined;

const parseNumericValue = (value: NumericValue): bigint | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string") {
    const digits = value.match(/[0-9]+/g);
    if (!digits) return null;
    return BigInt(digits.join(""));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.amount !== undefined) return parseNumericValue(record.amount as NumericValue);
    if (record.value !== undefined) return parseNumericValue(record.value as NumericValue);
  }
  return null;
};

export type ParsedInvoice = {
  raw: string;
  amountSats: bigint;
  paymentHash: string;
  description?: string;
  expiresAt?: number;
  payee?: string;
};

export const parseLightningInvoice = (invoice: string): ParsedInvoice => {
  const trimmed = invoice.trim();
  if (!trimmed) {
    throw new Error("Invoice is empty");
  }

  const decoded: any = lightBolt11.decode(trimmed);

  let amountMsat: bigint | null = null;
  if (Array.isArray(decoded?.sections)) {
    const amountSection = decoded.sections.find((section: any) => section?.name === "amount");
    if (amountSection?.value !== undefined) {
      const parsed = parseNumericValue(amountSection.value as NumericValue);
      if (parsed !== null) {
        amountMsat = parsed;
      }
    }
  }

  if (amountMsat === null) {
    const msCandidates = [
      decoded?.millisatoshis,
      decoded?.milliSatoshis,
      decoded?.miliSatoshis,
      decoded?.msatoshi,
      decoded?.msatoshis,
      decoded?.msat,
      decoded?.amount_msat,
      decoded?.amountMsat,
    ];

    for (const candidate of msCandidates) {
      const parsed = parseNumericValue(candidate as NumericValue);
      if (parsed !== null) {
        amountMsat = parsed;
        break;
      }
    }
  }

  if (amountMsat === null || amountMsat <= 0n) {
    throw new Error("Invoice is missing a payment amount");
  }
  if (amountMsat % MSATS_PER_SAT !== 0n) {
    throw new Error("Invoice amount has fractional sats (msats); unsupported in this flow");
  }

  const amountSats = amountMsat / MSATS_PER_SAT;

  const paymentHashValue = decoded?.payment_hash;
  const paymentHash = paymentHashValue ? String(paymentHashValue).toLowerCase() : undefined;
  if (!paymentHash || !/^[0-9a-f]{64}$/.test(paymentHash)) {
    throw new Error("Invoice is missing a payment hash");
  }

  const description = typeof decoded?.description === "string" ? decoded.description : undefined;

  let expiresAt: number | undefined;
  let timestampSeconds: bigint | null = null;
  if (Array.isArray(decoded?.sections)) {
    const tsSection = decoded.sections.find((section: any) => section?.name === "timestamp");
    if (tsSection?.value !== undefined) {
      const parsedTs = parseNumericValue(tsSection.value as NumericValue);
      if (parsedTs !== null) {
        timestampSeconds = parsedTs;
      }
    }
  }

  const expirySecondsRaw =
    typeof decoded?.expiry === "number" ? BigInt(decoded.expiry) : null;

  if (timestampSeconds !== null) {
    const expiryTotal = expirySecondsRaw !== null ? timestampSeconds + expirySecondsRaw : timestampSeconds;
    if (expiryTotal > 0) {
      const maybeNumber = Number(expiryTotal);
      if (Number.isFinite(maybeNumber)) {
        expiresAt = maybeNumber;
      }
    }
  }

  return {
    raw: trimmed,
    amountSats,
    paymentHash,
    description,
    expiresAt,
    payee:
      decoded?.payee ||
      decoded?.payeeNodeKey ||
      decoded?.payee_pub_key ||
      undefined,
  };
};

export type LockLightningPaymentOptions = {
  account: AccountInterface & { address: string };
  provider: ProviderInterface;
  parsedInvoice: ParsedInvoice;
  escrowContractAddress: string;
  maxFee?: bigint;
  onTransactionSent?: (txHash: string) => void;
};

export type LockLightningPaymentResult = {
  transactionHash: string;
  receipt: any;
};

const DEFAULT_MAX_FEE = 100_000_000_000_000n;

export const lockLightningPayment = async ({
  account,
  provider,
  parsedInvoice,
  escrowContractAddress,
  maxFee = DEFAULT_MAX_FEE,
  onTransactionSent,
}: LockLightningPaymentOptions): Promise<LockLightningPaymentResult> => {
  if (!escrowContractAddress) {
    throw new Error("Escrow contract address is required");
  }

  const calls = formatLockForLnPaymentCalls(
    escrowContractAddress,
    account.address,
    parsedInvoice.amountSats,
    `0x${parsedInvoice.paymentHash}`,
  );

  const { transactionHash, receipt } = await executeCallsAndWait(
    account,
    provider,
    calls,
    { maxFee, onSent: onTransactionSent },
  );

  return { transactionHash, receipt };
};
