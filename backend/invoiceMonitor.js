import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';

import { MSATS_PER_SAT, nowIso } from './lib/config.js';
import { clnCall } from './lib/cln.js';
import { getDB, reloadDB, withDB } from './lib/localStore.js';
import { requestTransfer } from './lib/operatorTransactionsClient.js';
import { parseMsat, parseSatsValue, normalizeStarknet } from './lib/utils.js';
import { serializeError } from './lib/localStoreHelpers.js';

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_RETRY_DELAY_MS = 60_000;
const DEFAULT_STALE_PROCESSING_MS = 5 * 60_000;

const POLL_INTERVAL_MS = resolvePositiveNumber(
  process.env.INVOICE_MONITOR_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
);
const RETRY_DELAY_MS = resolvePositiveNumber(
  process.env.INVOICE_MONITOR_RETRY_MS,
  DEFAULT_RETRY_DELAY_MS,
);
const STALE_PROCESSING_MS = resolvePositiveNumber(
  process.env.INVOICE_MONITOR_STALE_MS,
  DEFAULT_STALE_PROCESSING_MS,
);

function resolvePositiveNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureMonitorMeta(invoice, timestamp = Date.now()) {
  if (!invoice.monitor || typeof invoice.monitor !== 'object') invoice.monitor = {};
  const monitor = invoice.monitor;
  monitor.last_checked_at = timestamp;
  monitor.last_checked_at_iso = new Date(timestamp).toISOString();
  return monitor;
}

function ensureCreditMeta(invoice) {
  if (!invoice.credit || typeof invoice.credit !== 'object') {
    invoice.credit = { status: 'pending', attempts: 0 };
  }
  if (typeof invoice.credit.attempts !== 'number') invoice.credit.attempts = 0;
  return invoice.credit;
}

function resolveInvoiceAmountSats(invoice) {
  if (invoice.amount_sats !== undefined && invoice.amount_sats !== null) {
    const parsed = parseSatsValue(String(invoice.amount_sats));
    if (parsed !== null) return parsed;
  }
  if (invoice.amount_msat !== undefined && invoice.amount_msat !== null) {
    const parsedMsat = parseMsat(String(invoice.amount_msat));
    if (parsedMsat !== null) return parsedMsat / MSATS_PER_SAT;
  }
  return null;
}

function shouldDelayRetry(credit, now = Date.now()) {
  if (!credit || typeof credit !== 'object') return false;
  if (credit.status !== 'failed') return false;
  if (!credit.next_retry_at) return false;
  return now < credit.next_retry_at;
}

function resetStuckProcessing(credit, now = Date.now()) {
  if (!credit || credit.status !== 'processing') return;
  const lastAttempt = credit.last_attempt_at || 0;
  if (now - lastAttempt > STALE_PROCESSING_MS) {
    credit.status = 'pending';
    credit.last_error = {
      message: 'Recovered from stale processing state',
      code: 'stale_processing',
    };
  }
}

function updateInvoice(label, mutator) {
  return withDB((db) => {
    db.invoices ||= {};
    const invoice = db.invoices[label];
    if (!invoice) return null;
    return mutator(invoice, db);
  });
}

function loadInvoicesSnapshot() {
  reloadDB();
  const db = getDB();
  const entries = db?.invoices ? Object.entries(db.invoices) : [];
  return entries.map(([label, invoice]) => [label, clone(invoice)]);
}

async function refreshInvoiceFromCln(label) {
  const startedAt = Date.now();
  try {
    const response = await clnCall('listinvoices', { label });
    const remote = response?.invoices?.[0] || null;
    const result = updateInvoice(label, (invoice) => {
      const monitor = ensureMonitorMeta(invoice, startedAt);
      if (!remote) {
        monitor.last_error = { message: 'Invoice not found on CLN', code: 'not_found' };
        monitor.cln_status = null;
        return { invoice: clone(invoice), remote: null };
      }

      monitor.last_error = null;
      monitor.cln_status = remote.status || null;
      monitor.cln_updated_at = monitor.last_checked_at;

      if (remote.status && invoice.status !== remote.status) {
        invoice.status = remote.status;
      }
      if (remote.payment_hash) {
        const hash = remote.payment_hash.toLowerCase();
        invoice.payment_hash = hash;
      }
      if (remote.paid_at) {
        invoice.paid_at = remote.paid_at;
      }

      const amountMsatCandidates = [
        remote.amount_received_msat,
        remote.amount_msat,
        remote.paid_msat,
      ];
      for (const candidate of amountMsatCandidates) {
        const parsed = parseMsat(candidate);
        if (parsed !== null) {
          invoice.amount_msat = parsed.toString();
          invoice.amount_sats = (parsed / MSATS_PER_SAT).toString();
          break;
        }
      }

      if (!invoice.amount_sats && remote.amount_satoshis !== undefined) {
        const parsed = parseSatsValue(remote.amount_satoshis);
        if (parsed !== null) invoice.amount_sats = parsed.toString();
      }

      return { invoice: clone(invoice), remote };
    });
    return result || { invoice: null, remote: null };
  } catch (err) {
    const result = updateInvoice(label, (invoice) => {
      const monitor = ensureMonitorMeta(invoice, startedAt);
      monitor.last_error = serializeError(err) || { message: err.message || String(err) };
      monitor.cln_status = monitor.cln_status || null;
      return { invoice: clone(invoice), remote: null };
    });
    return result || { invoice: null, remote: null };
  }
}

async function attemptCredit(label, invoiceSnapshot) {
  const context = updateInvoice(label, (invoice) => {
    const now = Date.now();
    const credit = ensureCreditMeta(invoice);
    resetStuckProcessing(credit, now);

    if (credit.status === 'credited') {
      return { proceed: false, reason: 'already_credited', invoice: clone(invoice) };
    }
    if (shouldDelayRetry(credit, now)) {
      return { proceed: false, reason: 'retry_wait', invoice: clone(invoice) };
    }

    const recipient = normalizeStarknet(invoice.credit_address);
    if (!recipient) {
      credit.status = 'failed';
      credit.last_error = { message: 'Invalid credit address', code: 'invalid_address' };
      credit.next_retry_at = now + RETRY_DELAY_MS;
      return { proceed: false, reason: 'invalid_address', invoice: clone(invoice) };
    }

    const amountSats = resolveInvoiceAmountSats(invoice);
    if (amountSats === null || amountSats <= 0n) {
      credit.status = 'failed';
      credit.last_error = { message: 'Missing invoice amount', code: 'missing_amount' };
      credit.next_retry_at = now + RETRY_DELAY_MS;
      return { proceed: false, reason: 'missing_amount', invoice: clone(invoice) };
    }

    credit.status = 'processing';
    credit.attempts += 1;
    credit.last_error = null;
    credit.last_attempt_at = now;
    credit.last_attempt_at_iso = new Date(now).toISOString();
    credit.amount_sats = amountSats.toString();
    delete credit.next_retry_at;
    delete credit.next_retry_at_iso;

    return {
      proceed: true,
      recipient,
      amountSats,
      invoice: clone(invoice),
    };
  });

  if (!context || !context.proceed) return context?.invoice || invoiceSnapshot;

  try {
    const transferResult = await requestTransfer({
      recipientAddress: context.recipient,
      amountSats: context.amountSats.toString(),
    });
    const txHash = transferResult?.tx_hash ?? null;
    const amountUnits = transferResult?.amount_units ?? null;
    updateInvoice(label, (invoice) => {
      const credit = ensureCreditMeta(invoice);
      const now = Date.now();
      credit.status = 'credited';
      credit.tx_hash = txHash;
      credit.amount_units = amountUnits ?? credit.amount_units ?? null;
      credit.last_error = null;
      credit.credited_at = now;
      credit.credited_at_iso = new Date(now).toISOString();
      delete credit.next_retry_at;
      delete credit.next_retry_at_iso;
      return clone(invoice);
    });
    console.log(nowIso(), 'Invoice credited', label, context.recipient, context.amountSats.toString());
  } catch (err) {
    const serialized = serializeError(err) || { message: err.message || String(err) };
    updateInvoice(label, (invoice) => {
      const credit = ensureCreditMeta(invoice);
      credit.status = 'failed';
      credit.last_error = serialized;
      const retryAt = Date.now() + RETRY_DELAY_MS;
      credit.next_retry_at = retryAt;
      credit.next_retry_at_iso = new Date(retryAt).toISOString();
      return clone(invoice);
    });
    console.error(nowIso(), 'Failed to credit invoice', label, serialized.message);
  }

  return context.invoice;
}

async function processInvoice(label, invoiceSnapshot) {
  let current = invoiceSnapshot;
  if (!current) return;

  if (current.status !== 'paid') {
    const refreshed = await refreshInvoiceFromCln(label);
    current = refreshed.invoice || current;
    if (!current || current.status !== 'paid') return;
  }

  await attemptCredit(label, current);
}

async function processAllInvoices() {
  const invoices = loadInvoicesSnapshot();
  for (const [label, invoice] of invoices) {
    await processInvoice(label, invoice);
  }
}

async function main() {
  console.log(nowIso(), 'Invoice monitor starting');
  while (true) {
    try {
      await processAllInvoices();
    } catch (err) {
      console.error(nowIso(), 'Invoice monitor iteration failed', err?.message || err);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error(nowIso(), 'Invoice monitor terminated', err?.message || err);
  process.exit(1);
});
