'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getCashiPaymentStatus } = require('../cashi-client');

const ORDER = 'KR-test-123';
const KEY = 'test-cashi-key';
function fixture(status, checkout, checkoutHttpStatus = 200) {
  const calls = [];
  return {
    calls,
    options: {
      apiKey: KEY,
      fetchImpl: async (url, options) => {
        calls.push(url);
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal instanceof AbortSignal);
        if (url === `https://cashi.id/api/check-status/${ORDER}`) {
          assert.equal(options.headers['x-api-key'], KEY);
          return Response.json(status);
        }
        assert.equal(url, `https://cashi.id/api/checkout/${ORDER}`);
        assert.equal(options.headers, undefined);
        return Response.json(checkout, { status: checkoutHttpStatus });
      },
    },
  };
}

test('documented status amount is used directly, including a unique payment amount', async () => {
  const f = fixture({ success: true, status: 'SETTLED', amount: 50078, order_id: ORDER });
  assert.deepEqual(await getCashiPaymentStatus(ORDER, f.options), {
    orderId: ORDER, status: 'SETTLED', amount: 50078, amountSource: 'check-status',
  });
  assert.equal(f.calls.length, 1);
});

test('live Cashi response without amount uses the settled checkout gross total, not merchant net', async () => {
  const f = fixture({ success: true, status: 'SETTLED', provider_tx_id: null, is_final: true }, {
    success: true, data: { order_id: ORDER, status: 'SETTLED', amount: '4000.00', total_amount: 4000, net_amount: '3972.00' },
  });
  const result = await getCashiPaymentStatus(ORDER, f.options);
  assert.equal(result.amount, 4000);
  assert.equal(result.amountSource, 'checkout');
  assert.equal(f.calls.length, 2);
});

test('checkout amount supports numeric strings when total_amount is absent', async () => {
  const f = fixture({ success: true, status: 'SETTLED', amount: null }, {
    success: true, data: { order_id: ORDER, status: 'SETTLED', amount: '4000.00' },
  });
  assert.equal((await getCashiPaymentStatus(ORDER, f.options)).amount, 4000);
});

test('pending payments never use checkout to claim settlement', async () => {
  const f = fixture({ success: true, status: 'PENDING' });
  assert.equal((await getCashiPaymentStatus(ORDER, f.options)).status, 'PENDING');
  assert.equal(f.calls.length, 1);
});

test('a reported zero or underpayment is retained for rejection, never replaced with checkout amount', async () => {
  for (const amount of [0, 3999]) {
    const f = fixture({ success: true, status: 'SETTLED', amount });
    assert.equal((await getCashiPaymentStatus(ORDER, f.options)).amount, amount);
    assert.equal(f.calls.length, 1);
  }
});

test('amount missing from both responses remains unknown', async () => {
  const f = fixture({ success: true, status: 'SETTLED' }, {
    success: true, data: { order_id: ORDER, status: 'SETTLED' },
  });
  assert.equal((await getCashiPaymentStatus(ORDER, f.options)).amount, undefined);
});

test('mismatched order, unsettled checkout, invalid amount and unavailable gateway fail closed', async () => {
  const status = { success: true, status: 'SETTLED' };
  for (const [f, error] of [
    [fixture({ ...status, amount: 4000, order_id: 'other' }), /Nomor order/],
    [fixture(status, { success: true, data: { order_id: 'other', status: 'SETTLED', total_amount: 4000 } }), /Nomor order/],
    [fixture(status, { success: true, data: { order_id: ORDER, status: 'PENDING', total_amount: 4000 } }), /Status detail/],
    [fixture(status, { success: true, data: { order_id: ORDER, status: 'SETTLED', total_amount: 'invalid', amount: 4000 } }), /nominal/],
    [fixture(status, { success: false }, 503), /HTTP 503/],
    [fixture({ success: false, status: 'SETTLED', amount: 4000 }), /check-status gagal/],
  ]) await assert.rejects(getCashiPaymentStatus(ORDER, f.options), error);
  for (const amount of [true, {}, [], -1, 'Infinity', 'Rp4.000']) {
    const f = fixture({ ...status, amount });
    await assert.rejects(getCashiPaymentStatus(ORDER, f.options), /nominal/);
    assert.equal(f.calls.length, 1);
  }
});

test('network errors leave the payment unverified', async () => {
  await assert.rejects(getCashiPaymentStatus(ORDER, {
    apiKey: KEY, fetchImpl: async () => { throw new Error('network unavailable'); },
  }), /network unavailable/);
});
