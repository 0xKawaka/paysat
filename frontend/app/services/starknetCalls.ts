import { uint256, type Call, type AccountInterface, type ProviderInterface } from "starknet";
import { BTC_TOKEN_ADDRESS } from "../config/constants";

const DEFAULT_MAX_FEE = 100_000_000_000_000n;

const normalizeHex = (hex: string): string =>
  hex.startsWith("0x") ? hex : `0x${hex}`;

const getExecutionFailure = (receipt: any) => {
  const executionStatus = receipt?.execution_status || receipt?.status;
  const finalityStatus = receipt?.finality_status;
  const accepted =
    executionStatus === "SUCCEEDED" ||
    executionStatus === "ACCEPTED_ON_L2" ||
    executionStatus === "ACCEPTED_ON_L1" ||
    finalityStatus === "ACCEPTED_ON_L2" ||
    finalityStatus === "ACCEPTED_ON_L1";
  return accepted ? null : executionStatus || finalityStatus || "unknown";
};

export const formatLockForLnPaymentCalls = (
  escrowContractAddress: string,
  payerAddress: string,
  amountSats: bigint,
  paymentHashHex: string,
): Call[] => {
  const amount = uint256.bnToUint256(amountSats);
  const paymentHash = uint256.bnToUint256(BigInt(normalizeHex(paymentHashHex)));

  const approveCall: Call = {
    contractAddress: BTC_TOKEN_ADDRESS,
    entrypoint: "approve",
    calldata: [
      escrowContractAddress,
      amount.low,
      amount.high,
    ],
  } as Call;

  const lockCall: Call = {
    contractAddress: escrowContractAddress,
    entrypoint: "lock_for_ln_payment",
    calldata: [
      payerAddress,
      amount.low,
      amount.high,
      paymentHash.low,
      paymentHash.high,
    ],
  } as Call;

  return [approveCall, lockCall];
};

export type ExecuteAndWaitOptions = {
  maxFee?: bigint;
  onSent?: (txHash: string) => void;
};

export type ExecuteAndWaitResult = {
  transactionHash: string;
  receipt: any;
};

export const executeCallsAndWait = async (
  account: AccountInterface & { address: string },
  provider: ProviderInterface,
  calls: Call[],
  { maxFee = DEFAULT_MAX_FEE, onSent }: ExecuteAndWaitOptions = {},
): Promise<ExecuteAndWaitResult> => {
  // Ensure account is deployed before executing any calls
  const isDeployed = await (async () => {
    try {
      await provider.getClassAt(account.address);
      return true;
    } catch {
      return false;
    }
  })();

  if (!isDeployed) {
    // Try to auto-deploy a standard account (defaults to ArgentX for mainnet/sepolia, devnet variant otherwise)
    const signer = (account as any)?.signer;
    if (!signer || typeof signer.getPubKey !== "function") {
      throw new Error("Account is not deployed and signer is unavailable to deploy it");
    }

    const pubKey: string = await signer.getPubKey();
    // Detect chain to select class hash + constructor format
    let chainId: string;
    try {
      chainId = await provider.getChainId();
    } catch {
      chainId = "unknown";
    }

    const isSepolia = chainId === "0x534e5f5345504f4c4941"; // SN_SEPOLIA
    const isMainnet = chainId === "0x534e5f4d41494e"; // SN_MAIN

    const ARGENTX_CLASS_HASH =
      "0x01a736d6ed154502257f02b1ccdf4d9d1089f80811cd6acad48e6b6a9d1f2003";
    const DEVNET_CLASS_HASH =
      "0x02b31e19e45c06f29234e06e2ee98a9966479ba3067f8785ed972794fdb0065c";

    const useArgentX = isSepolia || isMainnet;
    const classHash = useArgentX ? ARGENTX_CLASS_HASH : DEVNET_CLASS_HASH;
    const constructorCalldata = useArgentX ? [pubKey, "0x0"] : [pubKey];

    // Deploy the account at the expected address
    const deployPayload = {
      classHash,
      constructorCalldata,
      addressSalt: pubKey,
      contractAddress: account.address,
    } as const;

    // Let starknet.js select the right tx version and resource bounds.
    // Passing partial V2-style details on a V3 chain causes
    // `missing field 'L1_DATA_GAS'` errors. Avoid providing details here.
    const { transaction_hash: deployHash } = await (account as any).deployAccount(
      deployPayload,
    );

    const deployReceipt = await provider.waitForTransaction(deployHash);
    const deployFailure = getExecutionFailure(deployReceipt);
    if (deployFailure) {
      const err = new Error(`Account deployment failed: ${deployFailure}`);
      (err as any).receipt = deployReceipt;
      throw err;
    }
  }

  // Don't pass partial tx details to avoid V3 resource bounds errors like
  // "missing field 'L1_DATA_GAS'". Let starknet.js choose the right version.
  const { transaction_hash } = await account.execute(calls);
  if (onSent) onSent(transaction_hash);

  const receipt = await provider.waitForTransaction(transaction_hash);
  const failureReason = getExecutionFailure(receipt);
  if (failureReason) {
    const error = new Error(`Starknet transaction failed: ${failureReason}`);
    (error as any).receipt = receipt;
    throw error;
  }

  return { transactionHash: transaction_hash, receipt };
};

export const DEFAULT_STARKNET_MAX_FEE = DEFAULT_MAX_FEE;
