'use strict';

// Some Cashi providers omit amount from check-status. In that case, read the
// transaction used by Cashi's own /pay/:orderId page, after the authenticated
// status request confirms settlement. Never substitute the local package price.
function hasCashiAmount(amount) {
  return amount !== undefined && amount !== null && !(typeof amount === 'string' && !amount.trim());
}

function validateAmount(amount) {
  if (!hasCashiAmount(amount)) return undefined;
  if (!['number', 'string'].includes(typeof amount) || !Number.isFinite(Number(amount)) || Number(amount) < 0) {
    throw new Error('Cashi mengirim nominal pembayaran yang tidak valid.');
  }
  return Number(amount);
}

async function getCashiPaymentStatus(orderId, { apiKey = process.env.CASHI_API_KEY, fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) throw new Error('CASHI_API_KEY belum dikonfigurasi.');
  const id = String(orderId || '');
  if (!id) throw new Error('Nomor order Cashi kosong.');

  const get = async (endpoint, authenticated) => {
    const response = await fetchImpl(`https://cashi.id/api/${endpoint}/${encodeURIComponent(id)}`, {
      ...(authenticated ? { headers: { 'x-api-key': apiKey } } : {}),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    const result = await response.json();
    if (!response.ok || result?.success !== true) throw new Error(`Cashi ${endpoint} gagal (HTTP ${response.status}).`);
    return result;
  };

  const result = await get('check-status', true);
  if (result.order_id !== undefined && String(result.order_id) !== id) {
    throw new Error('Nomor order pada status Cashi tidak cocok.');
  }
  const status = String(result.status || 'UNKNOWN').toUpperCase();
  let amount = validateAmount(result.amount);
  let amountSource = amount === undefined ? null : 'check-status';

  if (status === 'SETTLED' && amount === undefined) {
    const checkout = (await get('checkout', false)).data;
    // Checkout is supplementary evidence: its order and settlement must agree
    // with the authenticated status response before its gross total can be used.
    if (!checkout || String(checkout.order_id || '') !== id) {
      throw new Error('Nomor order pada detail pembayaran Cashi tidak cocok.');
    }
    if (String(checkout.status || '').toUpperCase() !== 'SETTLED') {
      throw new Error('Status detail pembayaran Cashi belum cocok. Silakan Refresh status lagi.');
    }
    amount = validateAmount(hasCashiAmount(checkout.total_amount) ? checkout.total_amount : checkout.amount);
    if (amount !== undefined) amountSource = 'checkout';
  }

  return { orderId: id, status, amount, amountSource };
}

module.exports = { getCashiPaymentStatus, hasCashiAmount };
