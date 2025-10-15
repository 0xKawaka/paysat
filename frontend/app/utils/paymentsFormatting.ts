import type { HistoryRecord, InvoiceRecord } from "../services/payments";

const STATUS_COLORS: Record<string, string> = {
  claimed: "#047857",
  awaiting_claim: "#2563eb",
  claim_queued: "#2563eb",
  lightning_failed: "#b91c1c",
  claim_failed: "#b91c1c",
  error: "#b91c1c",
  received: "#0f172a",
  processing: "#0f172a",
  paid: "#047857",
  unpaid: "#0f172a",
  pending: "#0f172a",
  credited: "#047857",
  expired: "#b91c1c",
  cancelled: "#b91c1c",
  canceled: "#b91c1c",
};

const INVOICE_STATUS_ALIASES: Record<string, string> = {
  unpaid: "pending",
  unknown: "pending",
};

export function formatSatsValue(value?: string | null, opts?: { prefix?: string }): string {
  if (!value) return "—";
  const normalized = String(value);
  if (!/^\d+$/.test(normalized)) return normalized;
  let result = "";
  let group = 0;
  for (let i = normalized.length - 1; i >= 0; i -= 1) {
    result = normalized[i] + result;
    group += 1;
    if (group === 3 && i !== 0) {
      result = `,${result}`;
      group = 0;
    }
  }
  const formatted = `${result} sats`;
  if (opts?.prefix) {
    return `${opts.prefix}${formatted}`;
  }
  return formatted;
}

export function formatPaymentUpdatedAt(updatedAt?: number): string {
  if (!updatedAt) return "";
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return "";
  const iso = date.toISOString();
  return iso.replace("T", " ").slice(0, 16);
}

function normalizeTimestampForDisplay(value?: number | null): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value >= 1e12) return Math.floor(value);
  if (value > 0) return Math.floor(value * 1000);
  return null;
}

function getInvoiceDisplayTimestamp(invoice: InvoiceRecord): number | null {
  const paidAt = normalizeTimestampForDisplay(invoice.paid_at ?? null);
  if (paidAt) return paidAt;
  return normalizeTimestampForDisplay(invoice.created_at ?? null);
}

export function getHistoryDisplayTimestamp(record: HistoryRecord): number | null {
  if (record.kind === "invoice") {
    return getInvoiceDisplayTimestamp(record.invoice);
  }
  return normalizeTimestampForDisplay(record.updated_at ?? null);
}

function titleForStatus(raw: string): string {
  const base = INVOICE_STATUS_ALIASES[raw] || raw;
  return base.replace(/_/g, " ");
}

function resolveInvoiceStatus(invoice: InvoiceRecord): string {
  const creditStatus = invoice.credit?.status;
  if (creditStatus === "credited") return "credited";
  if (invoice.status) return String(invoice.status);
  if (creditStatus) return String(creditStatus);
  return "unknown";
}

export function getHistoryStatus(record: HistoryRecord): {
  raw: string;
  label: string;
  color: string;
} {
  if (record.kind === "invoice") {
    const status = resolveInvoiceStatus(record.invoice);
    const normalized = status.toLowerCase();
    const labelPart = titleForStatus(normalized) || "received";
    const color = STATUS_COLORS[normalized] || "#334155";
    const fullLabel = labelPart ? `received · ${labelPart}` : "received";
    return { raw: normalized, label: fullLabel, color };
  }

  const payment = record.payment;
  const rawStatus =
    payment.status ?? payment.lightning?.status ?? payment.starknet?.status ?? "unknown";
  const normalized = String(rawStatus);
  const labelPart = normalized.replace(/_/g, " ");
  const color = STATUS_COLORS[normalized] || "#334155";
  const fullLabel = labelPart ? `sent · ${labelPart}` : "sent";
  return { raw: normalized, label: fullLabel, color };
}

function msatsToSats(value: string | number | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const rawValue = typeof value === "number" ? value.toString() : String(value);
  const trimmed = rawValue.trim().toLowerCase().endsWith("msat")
    ? rawValue.trim().slice(0, -4)
    : rawValue.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  try {
    const result = (BigInt(trimmed) / 1000n).toString();
    return result;
  } catch {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return null;
    return Math.floor(parsed / 1000).toString();
  }
}

export function getHistoryAmount(record: HistoryRecord): string | null {
  if (record.kind === "invoice") {
    const invoice = record.invoice;
    if (invoice.amount_sats) return String(invoice.amount_sats);
    if (invoice.credit?.amount_sats) return invoice.credit.amount_sats;
    return msatsToSats(invoice.amount_msat);
  }

  const payment = record.payment;
  return (
    payment.invoice?.amount_sats ??
    payment.lightning?.amount_sats ??
    payment.escrow?.amount_sats ??
    null
  );
}

export function getHistoryIdentifier(record: HistoryRecord): string {
  if (record.kind === "invoice") {
    if (record.invoice.label) return `Invoice label: ${record.invoice.label}`;
    if (record.invoice.bolt11) return `Invoice: ${record.invoice.bolt11.slice(0, 44)}…`;
    return "Invoice";
  }

  const payment = record.payment;
  if (payment.payment_hash) return payment.payment_hash;
  if (payment.payment_hash_no_prefix) return `0x${payment.payment_hash_no_prefix}`;
  return "";
}
