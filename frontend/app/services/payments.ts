export type PaymentRecord = {
  payment_hash: string;
  payment_hash_no_prefix?: string;
  status?: string;
  created_at?: number;
  created_at_iso?: string;
  updated_at?: number;
  updated_at_iso?: string;
  escrow?: {
    user?: string | null;
    amount_sats?: string | null;
    expires_at?: string | null;
    locked_at?: string | null;
    block_number?: number | null;
    starknet_tx_hash?: string | null;
  };
  invoice?: {
    label?: string | null;
    status?: string | null;
    amount_sats?: string | null;
    bolt11?: string | null;
    source?: string | null;
    updated_at?: number;
    updated_at_iso?: string;
  } | null;
  lightning?: {
    status?: string | null;
    invoice_status?: string | null;
    amount_sats?: string | null;
    payment_preimage?: string | null;
    pay_result?: unknown;
    completed_at?: number;
    completed_at_iso?: string;
    failed_at?: number;
    failed_at_iso?: string;
    error?: unknown;
    updated_at_iso?: string;
  } | null;
  starknet?: {
    status?: string | null;
    queued_at?: number;
    queued_at_iso?: string;
    claimed_at?: number;
    claimed_at_iso?: string;
    tx_hash?: string | null;
    failed_at?: number;
    failed_at_iso?: string;
    error?: unknown;
  } | null;
  request?: {
    received_at?: number;
    received_at_iso?: string;
    bolt11?: string | null;
    transaction_hash?: string | null;
  } | null;
  history?: Array<Record<string, unknown>>;
};

export type InvoiceRecord = {
  label: string;
  user_id_b64?: string | null;
  credit_address?: string | null;
  nonce_b64?: string | null;
  amount_sats?: string | number | null;
  amount_msat?: string | number | null;
  bolt11?: string | null;
  status?: string | null;
  created_at?: number | null;
  paid_at?: number | null;
  updated_at?: number | null;
  updated_at_iso?: string | null;
  monitor?: {
    last_checked_at?: number | null;
    last_checked_at_iso?: string | null;
    last_error?: unknown;
    cln_status?: string | null;
  } | null;
  credit?: {
    status?: string | null;
    attempts?: number | null;
    amount_sats?: string | null;
    amount_units?: string | null;
    tx_hash?: string | null;
    last_error?: unknown;
    credited_at?: number | null;
    credited_at_iso?: string | null;
    last_attempt_at?: number | null;
    last_attempt_at_iso?: string | null;
  } | null;
  [key: string]: unknown;
};

type BaseHistoryRecord = {
  id: string;
  kind: 'payment' | 'invoice';
  direction: 'sent' | 'received';
  updated_at?: number; // milliseconds since epoch
};

export type PaymentHistoryRecord = BaseHistoryRecord & {
  kind: 'payment';
  direction: 'sent';
  payment: PaymentRecord;
};

export type InvoiceHistoryRecord = BaseHistoryRecord & {
  kind: 'invoice';
  direction: 'received';
  invoice: InvoiceRecord;
};

export type HistoryRecord = PaymentHistoryRecord | InvoiceHistoryRecord;

const API_BASE = process.env.EXPO_PUBLIC_APP_API_URL;

function normalizeApiBase(): string {
  if (!API_BASE) {
    throw new Error('Backend API URL is not configured.');
  }
  return API_BASE.replace(/\/$/, '');
}

export async function fetchPaymentsByAddress(address: string): Promise<PaymentRecord[]> {
  if (!address) return [];

  const base = normalizeApiBase();
  const endpoint = `${base}/payments/${encodeURIComponent(address)}`;

  const response = await fetch(endpoint);
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const message = (payload && (payload.error || payload.message)) || 'Unable to fetch payments.';
    throw new Error(message);
  }

  const payload = (await response.json().catch(() => null)) as
    | { payments?: PaymentRecord[] }
    | null;
  if (!payload || !Array.isArray(payload.payments)) {
    return [];
  }

  return [...payload.payments]
    .filter((item): item is PaymentRecord => !!item && typeof item === 'object')
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
}

function normalizeInvoiceAmount(value?: string | number | null): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.floor(value).toString() : null;
  if (typeof value === 'string') return value;
  return null;
}

function normalizeTimestamp(value?: number | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value >= 1e12) return Math.floor(value);
  if (value > 0) return Math.floor(value * 1000);
  return null;
}

function resolveInvoiceUpdatedAt(invoice: InvoiceRecord): number | null {
  const candidates = [
    normalizeTimestamp(invoice.updated_at as number | undefined),
    normalizeTimestamp(invoice.paid_at),
    normalizeTimestamp(invoice.credit?.credited_at ?? null),
    normalizeTimestamp(invoice.monitor?.last_checked_at ?? null),
    normalizeTimestamp(invoice.created_at),
  ];
  for (const candidate of candidates) {
    if (candidate) return candidate;
  }
  return null;
}

function resolvePaymentUpdatedAt(payment: PaymentRecord): number | null {
  const candidates = [
    payment.updated_at,
    payment.lightning?.completed_at,
    payment.lightning?.failed_at,
    payment.created_at,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return null;
}

export async function fetchInvoicesByAddress(address: string): Promise<InvoiceRecord[]> {
  if (!address) return [];

  const base = normalizeApiBase();
  const endpoint = `${base}/invoices/user/${encodeURIComponent(address)}`;

  const response = await fetch(endpoint);
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const message = (payload && (payload.error || payload.message)) || 'Unable to fetch invoices.';
    throw new Error(message);
  }

  const payload = (await response.json().catch(() => null)) as
    | { invoices?: InvoiceRecord[] }
    | null;
  if (!payload || !Array.isArray(payload.invoices)) {
    return [];
  }

  return payload.invoices
    .filter((item): item is InvoiceRecord => !!item && typeof item === 'object')
    .map((item, index) => {
      const fallbackLabel = item.bolt11 ? `invoice-${index}` : `invoice-${index}`;
      const normalizedLabel =
        typeof item.label === 'string' && item.label
          ? item.label
          : fallbackLabel;

      const normalized: InvoiceRecord = {
        ...item,
        label: normalizedLabel,
      };
      if (normalized.amount_sats !== undefined) {
        normalized.amount_sats = normalizeInvoiceAmount(normalized.amount_sats);
      }
      if (normalized.amount_msat !== undefined) {
        normalized.amount_msat = normalizeInvoiceAmount(normalized.amount_msat);
      }
      return normalized;
    });
}

function mapPaymentsToHistory(payments: PaymentRecord[]): PaymentHistoryRecord[] {
  return payments.map((payment, index) => {
    const id =
      payment.payment_hash ||
      (payment.payment_hash_no_prefix ? `0x${payment.payment_hash_no_prefix}` : `payment-${index}`);
    const updatedAt = resolvePaymentUpdatedAt(payment) ?? undefined;
    return {
      id,
      kind: 'payment',
      direction: 'sent',
      updated_at: updatedAt,
      payment,
    };
  });
}

function mapInvoicesToHistory(invoices: InvoiceRecord[]): InvoiceHistoryRecord[] {
  return invoices.map((invoice, index) => {
    const id = invoice.label || invoice.bolt11 || `invoice-${index}`;
    const updatedAt = resolveInvoiceUpdatedAt(invoice) ?? undefined;
    return {
      id,
      kind: 'invoice',
      direction: 'received',
      updated_at: updatedAt,
      invoice,
    };
  });
}

export async function fetchPaymentHistoryByAddress(address: string): Promise<HistoryRecord[]> {
  if (!address) return [];

  const [payments, invoices] = await Promise.all([
    fetchPaymentsByAddress(address),
    fetchInvoicesByAddress(address),
  ]);

  const history = [...mapPaymentsToHistory(payments), ...mapInvoicesToHistory(invoices)];

  return history.sort((a, b) => {
    const aTs = a.updated_at ?? 0;
    const bTs = b.updated_at ?? 0;
    return bTs - aTs;
  });
}
