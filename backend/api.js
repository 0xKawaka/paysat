import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';

import { decodeBolt11Strict } from './lib/invoices.js';
import { b64url, normalizeStarknet, normalizePaymentHash } from './lib/utils.js';
import { DATA_FILE, PORT, TAG_SECRET, MSATS_PER_SAT, nowIso } from './lib/config.js';
import { getDB, saveDB, reloadDB } from './lib/localStore.js';
import { clnCall } from './lib/cln.js';
import { processPaymentRequest } from './lib/paymentProcessor.js';
import { listPaymentsByStarknetAddress, listInvoicesByStarknetAddress } from './lib/localStoreHelpers.js';

class ProcessingError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// ---------- FILE "DB" (single-process) ----------
const DB = getDB();

// ---------- APP ----------// ---------- APP ----------
const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());

// POST /invoice  -> get-or-create user_id by Starknet address, create BOLT11
app.post('/invoice', async (req, res) => {
  try {
    reloadDB();
    const { starknet_address, amount_sat, ttl_seconds = 600, private_desc = false } = req.body || {};
    const addr = normalizeStarknet(starknet_address);
    if (!addr) throw new Error('invalid starknet_address (expect 0x-prefixed hex)');
    if (amount_sat === undefined || amount_sat === null) throw new Error('amount_sat is required');

    let amountSatBigInt;
    try {
      if (typeof amount_sat === 'bigint') amountSatBigInt = amount_sat;
      else if (typeof amount_sat === 'number') { if (!Number.isInteger(amount_sat)) throw 0; amountSatBigInt = BigInt(amount_sat); }
      else if (typeof amount_sat === 'string') { const t = amount_sat.trim(); if (!/^\d+$/.test(t)) throw 0; amountSatBigInt = BigInt(t); }
      else throw 0;
    } catch {
      throw new Error('amount_sat must be a positive integer value');
    }
    if (amountSatBigInt <= 0n) throw new Error('amount_sat must be greater than zero');

    // Get-or-create random user_id for this address
    let user_id_b64;
    if (DB.addresses[addr]?.user_id_b64) user_id_b64 = DB.addresses[addr].user_id_b64;
    else {
      const user_id = crypto.randomBytes(32);
      user_id_b64 = b64url(user_id);
      DB.users[user_id_b64] = { created_at: Date.now() };
      DB.addresses[addr] = { user_id_b64, added_at: Date.now(), active: 1 };
      saveDB();
    }
    const user_id = Buffer.from(user_id_b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((user_id_b64.length + 3) % 4), 'base64');

    const version = Buffer.from([1]);
    const nonce = crypto.randomBytes(12);
    const nonce_b64 = b64url(nonce);
    if (DB.nonces[nonce_b64]) throw new Error('nonce collision (very unlikely)—retry');
    const tag = crypto.createHmac('sha256', TAG_SECRET).update(Buffer.concat([version, user_id, nonce])).digest();
    const blob = Buffer.concat([version, user_id, nonce, tag]);

    const label = `inv-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const amountSatString = amountSatBigInt.toString();
    const params = { amount_msat: `${amountSatString}sat`, label, description: `starknet:${b64url(blob)}`, expiry: ttl_seconds, ...(private_desc ? { deschashonly: true } : {}) };

    const out = await clnCall('invoice', params);

    DB.invoices[label] = { user_id_b64, credit_address: addr, nonce_b64, amount_sats: amountSatString, bolt11: out.bolt11, status: 'unpaid', created_at: Date.now(), paid_at: null };
    DB.nonces[nonce_b64] = label;
    saveDB();

    res.json({ label, bolt11: out.bolt11, expires_at: out.expires_at, desc_visible_to_payer: !private_desc });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// POST /pay -> operator processes a payment claim by reading escrow state from storage
app.post('/pay', async (req, res) => {
  const { payment_hash, paymentHash, invoice_hash, invoiceHash, transaction_hash, transactionHash, bolt11 } = req.body || {};
  const paymentHashInput = payment_hash || paymentHash || invoice_hash || invoiceHash;
  const transactionHashInput = transaction_hash || transactionHash; // optional (for client indexing)

  if (!bolt11 && !paymentHashInput) return res.status(400).json({ error: 'missing_bolt11_or_hash', message: 'Provide bolt11 invoice or payment_hash' });

  try {
    let normalizedPaymentHash;
    if (typeof bolt11 === 'string' && bolt11.trim()) {
      const decoded = decodeBolt11Strict(bolt11);
      normalizedPaymentHash = normalizePaymentHash(decoded.paymentHashNo0x);
    } else {
      normalizedPaymentHash = normalizePaymentHash(paymentHashInput);
    }

    const result = await processPaymentRequest(normalizedPaymentHash, transactionHashInput, { bolt11: typeof bolt11 === 'string' ? bolt11 : undefined });

    const status = result?.lightning?.status || result.status || 'unknown';
    const proof = result?.lightning?.payment_preimage
      ? { lightning_preimage: result.lightning.payment_preimage, payment_hash: `0x${normalizedPaymentHash}` }
      : undefined;
    return res.json({ status, ...(proof ? { proof } : {}) });
  } catch (err) {
    const status = err?.status || 500;
    const code = err?.code || 'internal_error';
    const message = err?.message || 'Unexpected error processing payment';
    const details = err?.details ? { details: err.details } : {};
    if (status >= 500) console.error(nowIso(), 'Error during /pay', err);
    return res.status(status).json({ error: code, message, ...details });
  }
});

// No verification endpoint: response includes universal proof (preimage + payment hash)

app.get('/payments/:starknet_address', (req, res) => {
  try {
    const normalized = normalizeStarknet(req.params.starknet_address);
    if (!normalized) {
      return res.status(400).json({ error: 'invalid_starknet_address', message: 'Provide a valid 0x-prefixed Starknet address' });
    }
    reloadDB();
    const payments = listPaymentsByStarknetAddress(normalized);
    return res.json({ starknet_address: normalized, payments });
  } catch (err) {
    console.error(nowIso(), 'Failed to list payments', err);
    return res.status(500).json({ error: 'internal_error', message: 'Unable to retrieve payments' });
  }
});

app.get('/invoices/user/:starknet_address', (req, res) => {
  try {
    const normalized = normalizeStarknet(req.params.starknet_address);
    if (!normalized) {
      return res.status(400).json({ error: 'invalid_starknet_address', message: 'Provide a valid 0x-prefixed Starknet address' });
    }
    reloadDB();
    const invoices = listInvoicesByStarknetAddress(normalized);
    return res.json({ starknet_address: normalized, invoices });
  } catch (err) {
    console.error(nowIso(), 'Failed to list invoices', err);
    return res.status(500).json({ error: 'internal_error', message: 'Unable to retrieve invoices' });
  }
});

// GET /invoice/:label -> check status (and persist 'paid' timestamp)
app.get('/invoice/:label', async (req, res) => {
  try {
    reloadDB();
    const label = req.params.label;
    const local = DB.invoices[label];
    if (!local) return res.status(404).json({ error: 'not found' });

    const out = await clnCall('listinvoices', { label });
    const inv = out.invoices?.[0];
    if (!inv) return res.status(404).json({ error: 'not found on CLN' });

    if (inv.status === 'paid' && local.status !== 'paid') {
      local.status = 'paid';
      local.paid_at = inv.paid_at || Math.floor(Date.now() / 1000);
      saveDB();
    }

    let amountSatsResponse = null;
    if (inv.amount_msat !== undefined && inv.amount_msat !== null) {
      try { const ms = BigInt(inv.amount_msat); amountSatsResponse = (ms / MSATS_PER_SAT).toString(); } catch {}
    }
    if (!amountSatsResponse) {
      if (local.amount_sats !== undefined && local.amount_sats !== null) amountSatsResponse = String(local.amount_sats);
      else if (local.amount_msat !== undefined && local.amount_msat !== null) amountSatsResponse = String(Math.floor(Number(local.amount_msat) / 1000));
    }
    if (amountSatsResponse) {
      if (local.amount_sats !== amountSatsResponse) { local.amount_sats = amountSatsResponse; if (local.amount_msat !== undefined) delete local.amount_msat; saveDB(); }
    }

    res.json({ label: inv.label, status: inv.status, amount_sats: amountSatsResponse, paid_at: inv.paid_at || local.paid_at, payment_hash: inv.payment_hash });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => console.log(`API listening on http://localhost:${PORT}; data -> ${DATA_FILE}`));
