import fs from 'fs';
import { CLN_REST_URL, CLN_RUNE_PATH, LN_MAX_FEE_PERCENT, LN_PAY_RETRY_FOR, MSATS_PER_SAT } from './config.js';

let RUNE;
try {
  RUNE = fs.readFileSync(CLN_RUNE_PATH, 'utf8').trim();
} catch (e) {
  console.error('Failed to read Admin Rune:', e.message);
  process.exit(1);
}

export async function clnCall(method, params = {}) {
  const res = await fetch(`${CLN_REST_URL}/v1/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', rune: RUNE },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`CLN ${method} ${res.status} ${await res.text()}`);
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json;
}

export async function findInvoice(paymentHashHex) {
  const res = await clnCall('listinvoices', { payment_hash: paymentHashHex });
  return res.invoices?.[0] || null;
}

export async function fetchPayPreimage(paymentHashHex) {
  try {
    const res = await clnCall('listpays', { payment_hash: paymentHashHex });
    const pays = Array.isArray(res.pays) ? res.pays : [];
    const completed = pays.find((pay) => ['complete', 'completed', 'paid', 'succeeded'].includes(pay.status));
    if (!completed) return null;
    return completed.payment_preimage || completed.preimage || null;
  } catch (err) {
    return null;
  }
}

export async function payInvoice(bolt11) {
  const payload = { bolt11, retry_for: LN_PAY_RETRY_FOR };
  if (Number.isFinite(LN_MAX_FEE_PERCENT) && LN_MAX_FEE_PERCENT >= 0) payload.maxfeepercent = LN_MAX_FEE_PERCENT;
  return clnCall('pay', payload);
}

