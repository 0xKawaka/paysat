import 'dotenv/config';
import express from 'express';

import { nowIso } from './lib/config.js';
import {
  bootstrapOperator,
  claimOnStarknet,
  transferBtcFromOperator,
} from './lib/starknet.js';
import { normalizePaymentHash } from './lib/utils.js';

const PORT = Number(process.env.OPERATOR_SERVICE_PORT || 8090);
const HOST = process.env.OPERATOR_SERVICE_HOST || '0.0.0.0';

let readyPromise;
let readyState;

async function ensureReady() {
  if (!readyPromise) {
    readyPromise = bootstrapOperator().then((state) => {
      readyState = state;
      return state;
    }).catch((err) => {
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
}

const app = express();
app.use(express.json({ limit: '512kb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', ready: Boolean(readyState) });
});

app.post('/claim', async (req, res) => {
  const { payment_hash, paymentHash, preimage_hex, preimageHex } = req.body || {};
  const rawPaymentHash = payment_hash || paymentHash;
  const rawPreimage = preimage_hex || preimageHex;

  if (!rawPaymentHash || typeof rawPaymentHash !== 'string') {
    return res.status(400).json({ error: 'invalid_payment_hash', message: 'payment_hash is required' });
  }
  if (!rawPreimage || typeof rawPreimage !== 'string') {
    return res.status(400).json({ error: 'invalid_preimage', message: 'preimage_hex is required' });
  }

  let normalizedHash;
  try {
    normalizedHash = normalizePaymentHash(rawPaymentHash);
  } catch (err) {
    return res.status(400).json({ error: 'invalid_payment_hash', message: err?.message || String(err) });
  }

  try {
    const { escrowWithSigner } = await ensureReady();
    const result = await claimOnStarknet(normalizedHash, rawPreimage, escrowWithSigner);
    return res.json({ status: 'claimed', tx_hash: result?.txHash });
  } catch (err) {
    console.error(nowIso(), 'Claim request failed', normalizedHash, err?.message || err);
    return res.status(500).json({ error: 'claim_failed', message: err?.message || 'Failed to execute claim' });
  }
});

app.post('/transfer', async (req, res) => {
  const { recipient_address, recipientAddress, amount_sats, amountSats } = req.body || {};
  const target = recipient_address || recipientAddress;
  const amount = amount_sats ?? amountSats;

  if (!target || typeof target !== 'string') {
    return res.status(400).json({ error: 'invalid_recipient', message: 'recipient_address is required' });
  }
  if (amount === undefined || amount === null) {
    return res.status(400).json({ error: 'invalid_amount', message: 'amount_sats is required' });
  }

  try {
    await ensureReady();
    const { txHash, amountUnits } = await transferBtcFromOperator(target, amount);
    return res.json({ status: 'sent', tx_hash: txHash, amount_units: amountUnits.toString() });
  } catch (err) {
    console.error(nowIso(), 'Transfer request failed', target, err?.message || err);
    return res.status(500).json({ error: 'transfer_failed', message: err?.message || 'Failed to execute transfer' });
  }
});

app.listen(PORT, HOST, () => {
  console.log(nowIso(), `Operator service listening on http://${HOST}:${PORT}`);
});
