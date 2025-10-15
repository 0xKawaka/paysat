import { withDB, getDB } from './localStore.js';

function now() {
  const at = Date.now();
  return { at, at_iso: new Date(at).toISOString() };
}

function ensureHistory(entry) {
  if (!Array.isArray(entry.history)) entry.history = [];
  return entry.history;
}

function touch(entry) {
  const { at, at_iso } = now();
  entry.updated_at = at;
  entry.updated_at_iso = at_iso;
  return { at, at_iso };
}

function ensureEntry(db, paymentHash) {
  db.payments ||= {};
  const key = paymentHash.toLowerCase();
  let entry = db.payments[key];
  if (!entry) {
    const { at, at_iso } = now();
    entry = {
      payment_hash: paymentHash.startsWith('0x') ? paymentHash : `0x${paymentHash}`,
      payment_hash_no_prefix: paymentHash.startsWith('0x') ? paymentHash.slice(2) : paymentHash,
      created_at: at,
      created_at_iso: at_iso,
      updated_at: at,
      updated_at_iso: at_iso,
      status: 'created',
      history: [],
    };
    db.payments[key] = entry;
  }
  return entry;
}

function pushHistory(entry, event, data = {}) {
  if (!event) return;
  const { at, at_iso } = now();
  ensureHistory(entry).push({ event, at, at_iso, ...data });
}

function mutatePayment(paymentHash, mutator, historyEvent, historyData) {
  return withDB((db) => {
    const entry = ensureEntry(db, paymentHash);
    mutator(entry);
    pushHistory(entry, historyEvent, historyData);
    touch(entry);
    return entry;
  });
}

function setInvoiceDetails(entry, details) {
  const invoice = { ...(entry.invoice || {}) };
  if (details.label !== undefined) invoice.label = details.label;
  if (details.status !== undefined) invoice.status = details.status;
  if (details.amount_sats !== undefined && details.amount_sats !== null) invoice.amount_sats = details.amount_sats;
  if (details.bolt11 !== undefined && details.bolt11 !== null) invoice.bolt11 = details.bolt11;
  if (details.source !== undefined) invoice.source = details.source;
  const { at, at_iso } = now();
  invoice.updated_at = at;
  invoice.updated_at_iso = at_iso;
  entry.invoice = invoice;
}

function ensureLightning(entry) {
  if (!entry.lightning || typeof entry.lightning !== 'object') entry.lightning = {};
  return entry.lightning;
}

function ensureStarknet(entry) {
  if (!entry.starknet || typeof entry.starknet !== 'object') entry.starknet = {};
  return entry.starknet;
}

function serializeError(err) {
  if (!err) return null;
  if (typeof err === 'string') return { message: err };
  const plain = {
    message: err.message || String(err),
  };
  if (err.code !== undefined) plain.code = err.code;
  if (err.status !== undefined) plain.status = err.status;
  if (err.details !== undefined) plain.details = err.details;
  if (err.stack) {
    const [firstLine] = String(err.stack).split('\n');
    plain.stack = firstLine;
  }
  return plain;
}

function clonePaymentEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return JSON.parse(JSON.stringify(entry));
}

function cloneInvoiceEntry(label, entry) {
  if (!entry || typeof entry !== 'object') return null;
  const clone = JSON.parse(JSON.stringify(entry));
  if (label && !clone.label) clone.label = label;
  return clone;
}

export function recordPaymentRequest({ paymentHash, locked, bolt11, transactionHash }) {
  const normalizedHash = paymentHash.startsWith('0x') ? paymentHash.slice(2) : paymentHash;
  const bolt11Value = bolt11 || null;
  const lockedAmount = locked?.amount !== undefined && locked?.amount !== null ? String(locked.amount) : null;
  return mutatePayment(
    normalizedHash,
    (entry) => {
      const { at, at_iso } = now();
      entry.status = 'received';
      entry.request = {
        received_at: at,
        received_at_iso: at_iso,
        bolt11: bolt11Value,
        transaction_hash: transactionHash || null,
      };
      entry.escrow = {
        user: locked?.user || null,
        amount_sats: lockedAmount,
        expires_at: locked?.expiresAt !== undefined && locked?.expiresAt !== null ? String(locked.expiresAt) : null,
        locked_at: locked?.lockedAt !== undefined && locked?.lockedAt !== null ? String(locked.lockedAt) : null,
        block_number: locked?.blockNumber ?? null,
        starknet_tx_hash: locked?.txHash ?? null,
      };
      const lightning = ensureLightning(entry);
      lightning.status = 'pending';
      lightning.error = null;
      lightning.updated_at_iso = at_iso;
      if (bolt11Value && !lightning.bolt11) lightning.bolt11 = bolt11Value;
      const starknet = ensureStarknet(entry);
      starknet.status = starknet.status || 'pending';
    },
    'payment_requested',
    { amount_sats: lockedAmount, bolt11_present: Boolean(bolt11Value) }
  );
}

export function recordInvoiceDetails(paymentHash, { label, status, amount_sats, bolt11, source }) {
  const normalizedHash = paymentHash.startsWith('0x') ? paymentHash.slice(2) : paymentHash;
  return mutatePayment(
    normalizedHash,
    (entry) => {
      setInvoiceDetails(entry, { label, status, amount_sats, bolt11, source });
      const lightning = ensureLightning(entry);
      if (status !== undefined && status !== null) lightning.invoice_status = status;
      if (amount_sats !== undefined && amount_sats !== null) lightning.amount_sats = amount_sats;
      if (bolt11 && !lightning.bolt11) lightning.bolt11 = bolt11;
    },
    'invoice_attached',
    { label: label ?? null, status: status ?? null }
  );
}

export function recordLightningSuccess(paymentHash, { invoice_status, amount_sats, payment_preimage, pay_result, already_paid }) {
  const normalizedHash = paymentHash.startsWith('0x') ? paymentHash.slice(2) : paymentHash;
  const lightningStatus = already_paid ? 'already_paid' : 'paid';
  return mutatePayment(
    normalizedHash,
    (entry) => {
      entry.status = entry.status === 'claimed' ? 'claimed' : 'awaiting_claim';
      setInvoiceDetails(entry, {
        status: invoice_status ?? entry.invoice?.status ?? null,
        amount_sats: amount_sats ?? entry.invoice?.amount_sats ?? null,
      });
      const lightning = ensureLightning(entry);
      const { at, at_iso } = now();
      lightning.status = lightningStatus;
      lightning.completed_at = at;
      lightning.completed_at_iso = at_iso;
      if (invoice_status !== undefined) lightning.invoice_status = invoice_status;
      if (amount_sats !== undefined) lightning.amount_sats = amount_sats;
      lightning.payment_preimage = payment_preimage || lightning.payment_preimage || null;
      lightning.pay_result = pay_result || lightning.pay_result || null;
      lightning.error = null;
      lightning.updated_at_iso = at_iso;
    },
    'lightning_succeeded',
    { status: lightningStatus, invoice_status: invoice_status ?? null }
  );
}

export function recordLightningFailure(paymentHash, error) {
  const normalizedHash = paymentHash.startsWith('0x') ? paymentHash.slice(2) : paymentHash;
  const serialized = serializeError(error);
  return mutatePayment(
    normalizedHash,
    (entry) => {
      if (entry.status !== 'claimed') entry.status = 'lightning_failed';
      const lightning = ensureLightning(entry);
      const { at, at_iso } = now();
      lightning.status = 'failed';
      lightning.failed_at = at;
      lightning.failed_at_iso = at_iso;
      lightning.error = serialized;
      lightning.updated_at_iso = at_iso;
    },
    'lightning_failed',
    serialized ? { message: serialized.message || null, code: serialized.code ?? null } : { message: null }
  );
}

export function markPaymentInflight(paymentHash) {
  const normalizedHash = paymentHash.startsWith('0x') ? paymentHash.slice(2) : paymentHash;
  return mutatePayment(
    normalizedHash,
    (entry) => {
      entry.status = entry.status || 'processing';
      ensureLightning(entry).status = 'pending';
    },
    'processing_inflight',
    {}
  );
}

export function markPaymentAlreadyClaimed(paymentHash) {
  const normalizedHash = paymentHash.startsWith('0x') ? paymentHash.slice(2) : paymentHash;
  return mutatePayment(
    normalizedHash,
    (entry) => {
      entry.status = 'claimed';
      const starknet = ensureStarknet(entry);
      if (!starknet.status || starknet.status === 'pending') starknet.status = 'claimed';
    },
    'already_claimed',
    {}
  );
}

export function recordPaymentError(paymentHash, error) {
  const normalizedHash = paymentHash.startsWith('0x') ? paymentHash.slice(2) : paymentHash;
  const serialized = serializeError(error);
  return mutatePayment(
    normalizedHash,
    (entry) => {
      if (!['claimed', 'claim_failed', 'lightning_failed'].includes(entry.status)) {
        entry.status = 'error';
      }
      const lightning = ensureLightning(entry);
      if (!lightning.status) lightning.status = 'pending';
      lightning.error = serialized;
      ensureStarknet(entry);
    },
    'processing_error',
    serialized ? { message: serialized.message || null, code: serialized.code ?? null } : { message: null }
  );
}

export function markStarknetClaimQueued(paymentHash) {
  const normalizedHash = paymentHash.startsWith('0x') ? paymentHash.slice(2) : paymentHash;
  return mutatePayment(
    normalizedHash,
    (entry) => {
      if (entry.status !== 'claimed') entry.status = 'claim_queued';
      const starknet = ensureStarknet(entry);
      const { at, at_iso } = now();
      starknet.status = 'claim_queued';
      starknet.queued_at = at;
      starknet.queued_at_iso = at_iso;
    },
    'claim_queued',
    {}
  );
}

export function markStarknetClaimSuccess(paymentHash, txHash) {
  const normalizedHash = paymentHash.startsWith('0x') ? paymentHash.slice(2) : paymentHash;
  return mutatePayment(
    normalizedHash,
    (entry) => {
      entry.status = 'claimed';
      const starknet = ensureStarknet(entry);
      const { at, at_iso } = now();
      starknet.status = 'claimed';
      starknet.claimed_at = at;
      starknet.claimed_at_iso = at_iso;
      starknet.tx_hash = txHash || starknet.tx_hash || null;
    },
    'claim_confirmed',
    { tx_hash: txHash || null }
  );
}

export function markStarknetClaimFailure(paymentHash, error) {
  const normalizedHash = paymentHash.startsWith('0x') ? paymentHash.slice(2) : paymentHash;
  const serialized = serializeError(error);
  return mutatePayment(
    normalizedHash,
    (entry) => {
      if (entry.status !== 'claimed') entry.status = 'claim_failed';
      const starknet = ensureStarknet(entry);
      const { at, at_iso } = now();
      starknet.status = 'claim_failed';
      starknet.failed_at = at;
      starknet.failed_at_iso = at_iso;
      starknet.error = serialized;
    },
    'claim_failed',
    serialized ? { message: serialized.message || null, code: serialized.code ?? null } : { message: null }
  );
}

export function listPaymentsByStarknetAddress(starknetAddress) {
  if (typeof starknetAddress !== 'string') return [];
  const normalized = starknetAddress.trim().toLowerCase();
  if (!/^0x[0-9a-f]{1,66}$/.test(normalized)) return [];

  const db = getDB();
  const payments = db?.payments || {};
  return Object.values(payments)
    .filter((entry) => entry?.escrow?.user && entry.escrow.user.toLowerCase() === normalized)
    .map((entry) => clonePaymentEntry(entry))
    .filter(Boolean);
}

export function listInvoicesByStarknetAddress(starknetAddress) {
  if (typeof starknetAddress !== 'string') return [];
  const normalized = starknetAddress.trim().toLowerCase();
  if (!/^0x[0-9a-f]{1,66}$/.test(normalized)) return [];

  const db = getDB();
  const addressEntry = db?.addresses?.[normalized];
  const userId = addressEntry?.user_id_b64;
  if (!userId) return [];

  const invoices = db?.invoices || {};
  return Object.entries(invoices)
    .filter(([, invoice]) => invoice?.user_id_b64 === userId)
    .map(([label, invoice]) => cloneInvoiceEntry(label, invoice))
    .filter(Boolean);
}

export { serializeError };
