import lightBolt11 from 'light-bolt11-decoder';
import { MSATS_PER_SAT } from './config.js';

export function parseNumericValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string') {
    const m = value.match(/^(\d+)(msat)?$/i);
    if (m) return BigInt(m[1]);
    const digits = value.match(/[0-9]+/g);
    if (digits) return BigInt(digits.join(''));
    return null;
  }
  if (typeof value === 'object') {
    const r = value;
    if (r && typeof r === 'object') {
      if (Object.prototype.hasOwnProperty.call(r, 'amount')) return parseNumericValue(r.amount);
      if (Object.prototype.hasOwnProperty.call(r, 'value')) return parseNumericValue(r.value);
    }
  }
  return null;
}

export function decodeBolt11Strict(bolt11) {
  if (typeof bolt11 !== 'string' || !bolt11.trim()) {
    throw new Error('BOLT11 invoice is required');
  }
  let decoded;
  try {
    decoded = lightBolt11.decode(bolt11.trim());
  } catch (err) {
    throw new Error('Unable to decode BOLT11 invoice');
  }
  const paymentHashNo0x = decoded?.payment_hash ? String(decoded.payment_hash).toLowerCase() : null;
  if (!paymentHashNo0x || !/^[0-9a-f]{64}$/.test(paymentHashNo0x)) {
    throw new Error('BOLT11 is missing a valid payment hash');
  }
  let amountMsat = null;
  if (Array.isArray(decoded?.sections)) {
    const amountSection = decoded.sections.find((s) => s?.name === 'amount');
    if (amountSection?.value !== undefined) amountMsat = parseNumericValue(amountSection.value);
  }
  if (amountMsat === null) {
    const cands = [decoded?.millisatoshis, decoded?.milliSatoshis, decoded?.miliSatoshis, decoded?.msatoshi, decoded?.msatoshis, decoded?.msat, decoded?.amount_msat, decoded?.amountMsat];
    for (const c of cands) { const parsed = parseNumericValue(c); if (parsed !== null) { amountMsat = parsed; break; } }
  }
  if (amountMsat === null || amountMsat <= 0n) throw new Error('BOLT11 invoice is missing an amount');
  if (amountMsat % MSATS_PER_SAT !== 0n) throw new Error('Invoice amount must resolve to whole sats');
  return { paymentHashNo0x, amountSats: amountMsat / MSATS_PER_SAT };
}

