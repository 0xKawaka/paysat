const DEFAULT_BASE_URL = process.env.OPERATOR_SERVICE_URL || 'http://127.0.0.1:8090';

function buildUrl(pathname) {
  const base = DEFAULT_BASE_URL.endsWith('/') ? DEFAULT_BASE_URL.slice(0, -1) : DEFAULT_BASE_URL;
  return `${base}${pathname}`;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function requestClaim(paymentHashHex, preimageHex) {
  const payload = {
    payment_hash: typeof paymentHashHex === 'string' ? paymentHashHex : String(paymentHashHex),
    preimage_hex: typeof preimageHex === 'string' ? preimageHex : String(preimageHex),
  };
  const response = await fetch(buildUrl('/claim'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await parseJsonResponse(response);
  if (!response.ok) {
    const message = json?.message || json?.error || `Claim service error (${response.status})`;
    const err = new Error(message);
    err.status = response.status;
    err.details = json;
    throw err;
  }
  return json;
}

export async function requestTransfer({ recipientAddress, amountSats }) {
  const payload = {
    recipient_address: recipientAddress,
    amount_sats: typeof amountSats === 'bigint' ? amountSats.toString() : String(amountSats),
  };
  const response = await fetch(buildUrl('/transfer'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await parseJsonResponse(response);
  if (!response.ok) {
    const message = json?.message || json?.error || `Transfer service error (${response.status})`;
    const err = new Error(message);
    err.status = response.status;
    err.details = json;
    throw err;
  }
  return json;
}
