import 'dotenv/config';
import fs from 'fs';

// Constants
export const MSATS_PER_SAT = 1000n;

// Environment configuration
export const CLN_REST_URL = process.env.CLN_REST_URL;
export const CLN_RUNE_PATH = process.env.CLN_RUNE_PATH;
export const TAG_SECRET = Buffer.from(process.env.TAG_SECRET || '', 'utf8');
export const DATA_FILE = process.env.DATA_FILE || './payments.json';
export const PORT = process.env.PORT || 8080;

export const STARKNET_ESCROW_ADDRESS = process.env.STARKNET_ESCROW_ADDRESS;
export const STARKNET_OPERATOR_PK = process.env.STARKNET_OPERATOR_PK;
export const STARKNET_RPC_URL = process.env.STARKNET_RPC_URL;
export const STARKNET_BTC_ADDRESS = process.env.STARKNET_BTC_ADRS;
const DEFAULT_BTC_DECIMALS = 8;
export const STARKNET_BTC_DECIMALS = process.env.STARKNET_BTC_DECIMALS !== undefined
  ? Number(process.env.STARKNET_BTC_DECIMALS)
  : DEFAULT_BTC_DECIMALS;

export const LN_MAX_FEE_PERCENT = process.env.LN_MAX_FEE_PERCENT
  ? Number(process.env.LN_MAX_FEE_PERCENT)
  : 0.5;
export const LN_PAY_RETRY_FOR = process.env.LN_PAY_RETRY_FOR
  ? Number(process.env.LN_PAY_RETRY_FOR)
  : 30;

export const nowIso = () => new Date().toISOString();

// Validation
if (!CLN_REST_URL || !CLN_RUNE_PATH || TAG_SECRET.length < 16) {
  console.error('Set CLN_REST_URL, CLN_RUNE_PATH, TAG_SECRET (>=16 chars) in .env');
  process.exit(1);
}
if (!STARKNET_ESCROW_ADDRESS || !/^0x[0-9a-fA-F]{1,66}$/.test(STARKNET_ESCROW_ADDRESS)) {
  console.error('Missing or invalid STARKNET_ESCROW_ADDRESS in environment');
  process.exit(1);
}
if (!STARKNET_OPERATOR_PK || !/^0x[0-9a-fA-F]+$/.test(STARKNET_OPERATOR_PK)) {
  console.error('Missing or invalid STARKNET_OPERATOR_PK in environment');
  process.exit(1);
}
if (!STARKNET_RPC_URL) {
  console.error('Missing STARKNET_RPC_URL in environment');
  process.exit(1);
}
if (!STARKNET_BTC_ADDRESS || !/^0x[0-9a-fA-F]{1,66}$/.test(STARKNET_BTC_ADDRESS)) {
  console.error('Missing or invalid STARKNET_BTC_ADRS in environment');
  process.exit(1);
}
if (!Number.isInteger(STARKNET_BTC_DECIMALS) || STARKNET_BTC_DECIMALS < 8 || STARKNET_BTC_DECIMALS > 77) {
  console.error('STARKNET_BTC_DECIMALS must be an integer between 8 and 77');
  process.exit(1);
}

export function readRune() {
  try {
    return fs.readFileSync(CLN_RUNE_PATH, 'utf8').trim();
  } catch (e) {
    console.error('Failed to read Admin Rune:', e.message);
    process.exit(1);
  }
}
