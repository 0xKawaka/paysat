import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Account, Contract, RpcProvider, CallData, uint256 } from 'starknet';
import {
  STARKNET_ESCROW_ADDRESS,
  STARKNET_OPERATOR_PK,
  STARKNET_RPC_URL,
  STARKNET_BTC_ADDRESS,
  STARKNET_BTC_DECIMALS,
  nowIso,
} from './config.js';
import {
  hexToByteArrayStruct,
  paymentHashToU256Parts,
  phaseIsLocked,
  toBigIntAmount,
  normalizeHex,
  normalizeStarknet,
  parseSatsValue,
} from './utils.js';
import {
  markStarknetClaimQueued,
  markStarknetClaimSuccess,
  markStarknetClaimFailure,
} from './localStoreHelpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ESCROW_ABI_PATH = path.resolve(__dirname, '../abi/EscrowVault.json');

let ESCROW_ABI;
try {
  const parsed = JSON.parse(fs.readFileSync(ESCROW_ABI_PATH, 'utf8'));
  ESCROW_ABI = parsed.abi || parsed;
} catch (err) {
  console.error('Failed to load EscrowVault ABI:', err.message || err);
  process.exit(1);
}

export const provider = new RpcProvider({ nodeUrl: STARKNET_RPC_URL });
export const escrowContract = new Contract(ESCROW_ABI, STARKNET_ESCROW_ADDRESS, provider);

const SAT_DECIMALS = 8n;
const TOKEN_DECIMALS = BigInt(STARKNET_BTC_DECIMALS);
const SAT_TO_TOKEN_SCALE = 10n ** (TOKEN_DECIMALS - SAT_DECIMALS);

let operatorAccountRef;
let nonceState = { next: null };
let nonceMutex = Promise.resolve();

function setOperatorAccount(account) {
  if (account && typeof account.execute === 'function') {
    operatorAccountRef = account;
  }
}

function getOperatorAccount() {
  if (!operatorAccountRef) {
    throw new Error('Operator account not initialised');
  }
  return operatorAccountRef;
}

function toHexNonce(value) {
  const hex = value.toString(16);
  return `0x${hex}`;
}

function isNonceSyncError(err) {
  const message = String(err?.message || '').toLowerCase();
  if (!message.includes('nonce')) return false;
  return (
    message.includes('low') ||
    message.includes('used') ||
    message.includes('already') ||
    message.includes('invalid') ||
    message.includes('out of order')
  );
}

async function withNonce(description, fn) {
  const run = async () => {
    const account = getOperatorAccount();
    if (nonceState.next === null) {
      const chainNonce = await account.getNonce();
      nonceState.next = BigInt(chainNonce);
      console.log(nowIso(), 'Synced operator nonce', nonceState.next.toString());
    }
    const nonceToUse = nonceState.next;
    nonceState.next += 1n;
    try {
      return await fn(account, nonceToUse);
    } catch (err) {
      if (isNonceSyncError(err)) {
        console.warn(nowIso(), 'Nonce desync detected, resetting cache', description, err?.message || err);
        nonceState.next = null;
      }
      throw err;
    }
  };
  nonceMutex = nonceMutex.then(run, run);
  return nonceMutex;
}

export async function bootstrapOperator() {
  const config = await escrowContract.get_config();
  const operatorAddress = normalizeHex(config.protocol_operator).toLowerCase();
  const operatorAccount = new Account(provider, operatorAddress, STARKNET_OPERATOR_PK);
  const escrowWithSigner = new Contract(ESCROW_ABI, STARKNET_ESCROW_ADDRESS, operatorAccount);
  setOperatorAccount(operatorAccount);
  nonceState.next = null;
  console.log(nowIso(), 'Operator payments initialised for operator', operatorAccount.address);
  return { operatorAccount, escrowWithSigner };
}

export async function loadEscrowFromStorage(paymentHashHexNoPrefix) {
  const hashU256 = paymentHashToU256Parts(paymentHashHexNoPrefix);
  const pos = await escrowContract.get_escrow(hashU256);
  if (!phaseIsLocked(pos?.phase)) throw new Error('Escrow position not found or not in Locked phase');
  const user = normalizeHex(pos.user).toLowerCase();
  const amount = toBigIntAmount(pos.amount);
  const expiresAt = BigInt(pos.expires_at ?? 0);
  const lockedAt = BigInt(pos.locked_at ?? 0);
  return { user, hash: hashU256, paymentHashHex: paymentHashHexNoPrefix, amount, expiresAt, lockedAt, blockNumber: null, txHash: null };
}

export async function claimOnStarknet(paymentHashHexNoPrefix, preimageHex, escrowWithSigner) {
  const account = escrowWithSigner?.providerOrAccount || operatorAccountRef;
  if (!account || typeof account.execute !== 'function') {
    throw new Error('Operator account unavailable for claim');
  }
  setOperatorAccount(account);

  const locked = await loadEscrowFromStorage(paymentHashHexNoPrefix);
  markStarknetClaimQueued(paymentHashHexNoPrefix);

  const byteArray = hexToByteArrayStruct(preimageHex);
  if (!locked?.hash || locked.hash.low === undefined || locked.hash.high === undefined) {
    throw new Error('Escrow hash is missing low/high parts');
  }

  const compiledInput = [locked.hash, byteArray];
  const calldata = CallData.compile(compiledInput);
  Object.defineProperty(calldata, '__compiled__', { value: true, enumerable: false });

  const call = {
    contractAddress: STARKNET_ESCROW_ADDRESS,
    entrypoint: 'claim',
    calldata,
  };

  try {
    const submitResult = await withNonce(`claim:${paymentHashHexNoPrefix}`, async (account, nonce) => {
      const response = await account.execute(call, { nonce: toHexNonce(nonce) });
      const tx = response?.transaction_hash || response;
      console.log(nowIso(), 'Claim transaction sent', paymentHashHexNoPrefix, tx);
      return { txHash: tx };
    });

    await provider.waitForTransaction(submitResult.txHash);
    console.log(nowIso(), 'Claim confirmed', paymentHashHexNoPrefix);
    markStarknetClaimSuccess(paymentHashHexNoPrefix, submitResult.txHash);

    return { txHash: submitResult.txHash, paymentHashHex: paymentHashHexNoPrefix };
  } catch (err) {
    markStarknetClaimFailure(paymentHashHexNoPrefix, err);
    throw err;
  }
}

export function satsToTokenUnits(amountSats) {
  const sats = parseSatsValue(amountSats);
  if (sats === null) throw new Error('Unable to parse sat amount for transfer');
  if (sats <= 0n) throw new Error('Token transfer amount must be positive');
  return sats * SAT_TO_TOKEN_SCALE;
}

export async function transferBtcFromOperator(recipientAddress, amountSats, operatorAccount) {
  if (operatorAccount) setOperatorAccount(operatorAccount);
  if (!operatorAccountRef && !operatorAccount) {
    await bootstrapOperator();
  }
  const account = operatorAccount || getOperatorAccount();

  const normalizedRecipient = normalizeStarknet(recipientAddress);
  if (!normalizedRecipient) throw new Error('Recipient Starknet address is invalid');

  const amountUnits = satsToTokenUnits(amountSats);
  if (amountUnits <= 0n) throw new Error('Transfer amount must be positive');

  const amountU256 = uint256.bnToUint256(amountUnits);
  const call = {
    contractAddress: STARKNET_BTC_ADDRESS,
    entrypoint: 'transfer',
    calldata: [
      normalizedRecipient,
      amountU256.low.toString(),
      amountU256.high.toString(),
    ],
  };

  const submitResult = await withNonce(`transfer:${normalizedRecipient}`, async (accountRef, nonce) => {
    const response = await accountRef.execute(call, { nonce: toHexNonce(nonce) });
    const tx = response?.transaction_hash || response;
    console.log(nowIso(), 'Starknet BTC transfer sent', normalizedRecipient, amountUnits.toString(), tx);
    return { txHash: tx };
  });

  await provider.waitForTransaction(submitResult.txHash);
  console.log(nowIso(), 'Starknet BTC transfer confirmed', normalizedRecipient, submitResult.txHash);

  return { txHash: submitResult.txHash, amountUnits };
}
