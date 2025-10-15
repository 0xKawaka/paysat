import { MSATS_PER_SAT } from './config.js';
import { findInvoice, fetchPayPreimage, payInvoice } from './cln.js';
import { decodeBolt11Strict } from './invoices.js';
import { sanitizePayResult, parseMsat } from './utils.js';
import { loadEscrowFromStorage } from './starknet.js';
import {
  recordPaymentRequest,
  recordInvoiceDetails,
  recordLightningSuccess,
  recordLightningFailure,
  markPaymentInflight,
  markPaymentAlreadyClaimed,
  recordPaymentError,
} from './localStoreHelpers.js';
import { requestClaim } from './operatorTransactionsClient.js';

const inflightHashes = new Set();
const processedHashes = new Set();

export async function processPaymentRequest(paymentHashHex, _transactionHash, opts = {}) {
  const locked = await loadEscrowFromStorage(paymentHashHex);
  recordPaymentRequest({
    paymentHash: paymentHashHex,
    locked,
    bolt11: opts?.bolt11,
    transactionHash: _transactionHash,
  });
  try {
    const result = await processEscrowPayment(locked, opts);
    return {
      status: result.status,
      locked_event: {
        user: locked.user,
        amount: locked.amount.toString(),
        expires_at: locked.expiresAt.toString(),
        locked_at: locked.lockedAt.toString(),
        block_number: locked.blockNumber,
        starknet_tx_hash: locked.txHash,
      },
      invoice: result.invoice,
      lightning: result.lightning,
      starknet: result.starknet,
    };
  } catch (err) {
    if (!err?._paymentLogged) recordPaymentError(paymentHashHex, err);
    throw err;
  }
}

export async function processEscrowPayment(locked, { bolt11 } = {}) {
  const paymentHashHex = locked.paymentHashHex;

  if (processedHashes.has(paymentHashHex)) {
    markPaymentAlreadyClaimed(paymentHashHex);
    return { status: 'already_claimed', invoice: null, lightning: { status: 'skipped', reason: 'already_claimed' }, starknet: { status: 'skipped' } };
  }
  if (inflightHashes.has(paymentHashHex)) {
    const e = new Error('Payment processing already in progress for this hash');
    e.status = 409; e.code = 'payment_inflight';
    throw e;
  }

  inflightHashes.add(paymentHashHex);
  markPaymentInflight(paymentHashHex);
  try {
    let invoice = await findInvoice(paymentHashHex);
    const usingExternalInvoice = !invoice && typeof bolt11 === 'string' && bolt11.length > 0;
    if (!invoice && !usingExternalInvoice) {
      const e = new Error('Invoice not found for payment hash');
      e.status = 404; e.code = 'invoice_not_found';
      recordLightningFailure(paymentHashHex, e);
      e._paymentLogged = true;
      throw e;
    }

    // Determine invoice amount and enforce hash match
    let invoiceAmount = null;
    if (invoice) {
      const invoiceMsat = parseMsat(invoice.amount_msat) ?? parseMsat(invoice.amount_received_msat) ?? parseMsat(invoice.paid_msat);
      if (invoiceMsat !== null) {
        if (invoiceMsat % MSATS_PER_SAT !== 0n) {
          const e = new Error('Invoice amount must resolve to whole sats'); e.status = 409; e.code = 'fractional_sats'; throw e;
        }
        invoiceAmount = invoiceMsat / MSATS_PER_SAT;
      } else {
        const satCandidates = [invoice.amount_sats, invoice.amount_sat];
        for (const v of satCandidates) { if (v !== null && v !== undefined) { try { invoiceAmount = BigInt(String(v)); break; } catch {} } }
      }
      if (invoiceAmount === null) { const e = new Error('Invoice does not report an amount'); e.status = 409; e.code = 'invoice_missing_amount'; throw e; }
    } else {
      const decoded = decodeBolt11Strict(bolt11);
      if (decoded.paymentHashNo0x !== paymentHashHex) {
        const e = new Error('BOLT11 payment hash does not match locked hash'); e.status = 409; e.code = 'hash_mismatch'; e.details = { locked_hash: paymentHashHex, bolt11_hash: decoded.paymentHashNo0x }; throw e;
      }
      invoiceAmount = decoded.amountSats;
    }

    if (invoiceAmount !== locked.amount) {
      const e = new Error('Locked amount does not match invoice amount'); e.status = 409; e.code = 'amount_mismatch'; e.details = { locked_amount: locked.amount.toString(), invoice_amount: invoiceAmount.toString() }; throw e;
    }

    if (invoice) {
      const invoiceBolt11 = invoice.bolt11 || invoice.payreq || null;
      recordInvoiceDetails(paymentHashHex, {
        label: invoice.label ?? null,
        status: invoice.status ?? null,
        amount_sats: invoiceAmount.toString(),
        bolt11: invoiceBolt11,
        source: 'cln',
      });
    } else {
      recordInvoiceDetails(paymentHashHex, {
        status: 'paid',
        amount_sats: invoiceAmount.toString(),
        bolt11,
        source: 'external',
      });
    }

    const alreadyPaid = invoice ? (invoice.status === 'paid' || invoice.status === 'complete') : false;
    let preimageHex = invoice ? (invoice.payment_preimage || invoice.preimage || null) : null;
    let payResult = null;
    let lightningStatus = alreadyPaid ? 'already_paid' : 'paid';

    if (!alreadyPaid) {
      const payTarget = invoice ? (invoice.bolt11 || invoice.payreq) : bolt11;
      try {
        payResult = await payInvoice(payTarget);
      } catch (err) {
        recordLightningFailure(paymentHashHex, err);
        if (err && typeof err === 'object') err._paymentLogged = true;
        throw err;
      }
      // Post-pay invariants
      try {
        const paidHash = String(payResult?.payment_hash || '').toLowerCase();
        if (paidHash && paidHash !== paymentHashHex) { const e = new Error('Paid invoice hash differs from locked hash'); e.status = 502; e.code = 'lightning_payment_hash_mismatch'; e.details = { locked_hash: paymentHashHex, paid_hash: paidHash }; throw e; }
        const paidMsat = parseMsat(payResult?.amount_msat);
        if (paidMsat !== null) {
          const expectedMsat = locked.amount * MSATS_PER_SAT;
          if (paidMsat !== expectedMsat) { const e = new Error('Paid msats differ from locked amount'); e.status = 502; e.code = 'lightning_payment_amount_mismatch'; e.details = { expected_msat: expectedMsat.toString(), paid_msat: paidMsat.toString() }; throw e; }
        }
      } catch (err) {
        recordLightningFailure(paymentHashHex, err);
        if (err && typeof err === 'object') err._paymentLogged = true;
        throw err;
      }
      preimageHex = payResult.payment_preimage || payResult.preimage || preimageHex;
    }

    if (!preimageHex) {
      try {
        preimageHex = await fetchPayPreimage(paymentHashHex);
      } catch (err) {
        recordLightningFailure(paymentHashHex, err);
        if (err && typeof err === 'object') err._paymentLogged = true;
        throw err;
      }
    }
    if (!preimageHex) {
      const e = new Error('Unable to retrieve payment preimage from CLN'); e.status = 502; e.code = 'missing_preimage';
      recordLightningFailure(paymentHashHex, e);
      e._paymentLogged = true;
      throw e;
    }

    const sanitizedPayResult = sanitizePayResult(payResult);
    const invoiceStatus = alreadyPaid ? (invoice?.status ?? 'paid') : 'paid';
    recordLightningSuccess(paymentHashHex, {
      invoice_status: invoiceStatus,
      amount_sats: invoiceAmount.toString(),
      payment_preimage: preimageHex,
      pay_result: sanitizedPayResult,
      already_paid: alreadyPaid,
    });

    let claimResult = null;
    try {
      claimResult = await requestClaim(paymentHashHex, preimageHex);
    } catch (err) {
      // requestClaim already records failure via operator service; surface error upstream
      throw err;
    }

    processedHashes.add(paymentHashHex);
    const starknetStatus = claimResult?.status || 'claimed';
    const starknetTxHash = claimResult?.tx_hash || null;

    return {
      status: starknetStatus,
      invoice: invoice ? { label: invoice.label, status: invoiceStatus, amount_sats: invoiceAmount.toString() } : { label: 'external', status: 'paid', amount_sats: invoiceAmount.toString() },
      lightning: { status: lightningStatus, invoice_status: invoiceStatus, amount_sats: invoiceAmount.toString(), payment_preimage: preimageHex, pay_result: sanitizedPayResult },
      starknet: { status: starknetStatus, tx_hash: starknetTxHash },
    };
  } catch (err) {
    if (!err?._paymentLogged) {
      recordLightningFailure(paymentHashHex, err);
      if (err && typeof err === 'object') err._paymentLogged = true;
    }
    throw err;
  } finally {
    inflightHashes.delete(paymentHashHex);
  }
}
