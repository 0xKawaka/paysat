import { MSATS_PER_SAT } from './config.js';

export const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

export function normalizeStarknet(addr) {
  if (typeof addr !== 'string') return null;
  const a = addr.trim().toLowerCase();
  if (!a.startsWith('0x')) return null;
  if (!/^0x[0-9a-f]{1,66}$/.test(a)) return null;
  return a;
}

export function normalizeHex(value) {
  if (typeof value === 'string') return value.startsWith('0x') ? value : `0x${value}`;
  const hex = BigInt(value).toString(16);
  return `0x${hex}`;
}

export function normalizePaymentHash(value) {
  if (typeof value !== 'string') throw new Error('payment_hash must be a hex string');
  let normalized = value.trim().toLowerCase();
  if (normalized.startsWith('0x')) normalized = normalized.slice(2);
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error('payment_hash must be 32-byte hex');
  return normalized;
}

export function parseMsat(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') {
    const match = value.match(/^(\d+)(msat)?$/i);
    if (!match) return null;
    return BigInt(match[1]);
  }
  return null;
}

export function parseSatsValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') {
    const match = value.match(/^(\d+)(sat|sats)?$/i);
    if (match) return BigInt(match[1]);
    const digits = value.match(/[0-9]+/g);
    if (digits && digits.length > 0) return BigInt(digits.join(''));
  }
  return null;
}

export const UINT128 = 2n ** 128n;
export function u256ToBigInt(low, high) {
  return BigInt(low) + BigInt(high) * UINT128;
}
export function u256ToHex(low, high) {
  const value = u256ToBigInt(low, high);
  return value.toString(16).padStart(64, '0');
}

export function paymentHashToU256Parts(paymentHashHexNoPrefix) {
  const hex = paymentHashHexNoPrefix.toLowerCase();
  const hi = `0x${hex.slice(0, 32)}`;
  const lo = `0x${hex.slice(32)}`;
  return { low: lo, high: hi };
}

export function toBigIntAmount(amount) {
  if (typeof amount === 'bigint') return amount;
  if (amount && typeof amount === 'object') {
    const low = amount.low ?? amount?.value?.low;
    const high = amount.high ?? amount?.value?.high;
    if (low !== undefined && high !== undefined) return u256ToBigInt(low, high);
  }
  if (typeof amount === 'number' && Number.isFinite(amount)) return BigInt(amount);
  if (typeof amount === 'string' && amount) return BigInt(amount);
  return 0n;
}

export function phaseIsLocked(phase) {
  if (phase === null || phase === undefined) return false;
  if (typeof phase === 'object') {
    const v = phase.variant;
    if (typeof v === 'string') return v === 'Locked';
    if (v && typeof v === 'object') {
      if (Object.prototype.hasOwnProperty.call(v, 'Locked')) return v.Locked !== undefined;
      const only = Object.keys(v)[0];
      return only === 'Locked';
    }
    if (Object.prototype.hasOwnProperty.call(phase, 'Locked')) return phase.Locked !== undefined;
  }
  if (typeof phase === 'string') {
    const p = phase.toLowerCase();
    if (p === 'locked') return true;
    if (p.startsWith('0x')) { try { return BigInt(p) === 1n; } catch { return false; } }
    const n = Number(phase);
    return Number.isFinite(n) && n === 1;
  }
  if (typeof phase === 'number') return phase === 1;
  if (typeof phase === 'bigint') return phase === 1n;
  return false;
}

export function hexToByteArrayStruct(hex) {
  if (hex === undefined || hex === null) {
    throw new Error('hexToByteArrayStruct: preimage is required');
  }

  let buffer;

  if (typeof hex === 'string') {
    let normalized = hex.trim().toLowerCase();
    if (normalized.startsWith('0x')) normalized = normalized.slice(2);
    if (normalized.length % 2 !== 0) normalized = `0${normalized}`;
    if (!/^[0-9a-f]*$/.test(normalized)) {
      throw new Error('hexToByteArrayStruct: preimage must be hex-encoded');
    }
    buffer = Buffer.from(normalized, 'hex');
  } else if (Buffer.isBuffer(hex)) {
    buffer = Buffer.from(hex);
  } else if (hex instanceof Uint8Array || ArrayBuffer.isView(hex)) {
    buffer = Buffer.from(hex.buffer, hex.byteOffset, hex.byteLength);
  } else if (Array.isArray(hex)) {
    buffer = Buffer.from(hex);
  } else {
    throw new Error('hexToByteArrayStruct: unsupported preimage type');
  }

  const chunkSize = 31;
  const data = [];
  let offset = 0;
  while (offset + chunkSize <= buffer.length) {
    const chunk = buffer.subarray(offset, offset + chunkSize);
    data.push(`0x${chunk.toString('hex')}`);
    offset += chunkSize;
  }
  const remainder = buffer.subarray(offset);
  const pending_word = remainder.length ? `0x${remainder.toString('hex')}` : '0x0';
  const pending_word_len = remainder.length;
  return { data, pending_word, pending_word_len };
}

export function sanitizePayResult(payResult) {
  if (!payResult || typeof payResult !== 'object') return null;
  const msat = parseMsat(payResult.amount_msat);
  const msatSent = parseMsat(payResult.amount_sent_msat);
  const toSats = (v) => (v === null ? null : (v / MSATS_PER_SAT).toString());
  return {
    status: payResult.status || payResult.result || null,
    amount_sats: toSats(msat),
    amount_sent_sats: toSats(msatSent),
    payment_hash: payResult.payment_hash || null,
    payment_preimage: payResult.payment_preimage || payResult.preimage || null,
    created_at: payResult.created_at || null,
  };
}
