'use strict';

const crypto = require('crypto');
const TESTIMONIAL_CHAT_ID = '@galaxy_testi';
const CLAIM_TIMEOUT_MS = 60_000;

function maskedName(profile = {}) {
  const word = String(profile.firstName || profile.username || '').normalize('NFKC').match(/[\p{L}\p{N}]+/u)?.[0] || '';
  const chars = Array.from(word);
  return `${chars.slice(0, Math.max(0, Math.min(2, chars.length - 1))).join('')}***`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
const rupiah = value => `Rp${Number(value).toLocaleString('id-ID', { maximumFractionDigits: 2 })}`;

function paymentTestimonialText(order, profile) {
  if (order?.status !== 'SETTLED' || !Number.isFinite(order.paidAmount) || order.paidAmount <= 0) {
    throw new Error('Testimonial requires a settled payment with a verified amount');
  }
  let product;
  if (order.kind === 'credits') product = `Paket ${Number(order.credits).toLocaleString('id-ID')} Kredit Token`;
  else if (order.kind === 'unlimited') {
    const hours = Number(order.hours);
    const duration = hours >= 24 && hours % 24 === 0 ? `${hours / 24} hari` : `${hours} jam`;
    product = `${String(order.name || 'Paket Unlimited').slice(0, 120)} — ${duration}`;
  } else product = `Top Up Saldo ${rupiah(order.amount)}`;
  return [
    '\u{2705} <b>Pembayaran Berhasil!</b>', '',
    `User: <b>${escapeHtml(maskedName(profile))}</b>`,
    `Membeli: <b>${escapeHtml(product)}</b>`,
    `Total dibayar: <b>${rupiah(order.paidAmount)}</b>`,
  ].join('\n');
}

// Called inside the settlement's existing file lock and commit. No retroactive
// scan of past payments: only new, verified settlements receive a queue marker.
function queuePaymentTestimonial(order) {
  if (order.paymentTestimonial || order.status !== 'SETTLED' || !Number.isFinite(order.paidAmount) || order.paidAmount <= 0) return;
  order.paymentTestimonial = { status: 'pending', attempts: 0, nextAttemptAt: 0 };
}

function testimonialDue(order, now = Date.now()) {
  const state = order?.paymentTestimonial;
  return order?.status === 'SETTLED' && Boolean(state && (
    (state.status === 'pending' && Number(state.nextAttemptAt || 0) <= now)
    || (state.status === 'sending' && Number(state.claimedAt) + CLAIM_TIMEOUT_MS <= now)
  ));
}

// The database caller holds the order lock. A stale claim may already have
// reached Telegram: do not resend automatically and risk a duplicate post.
function claimPaymentTestimonial(order, profile, now = Date.now()) {
  if (!testimonialDue(order, now)) return null;
  const state = order.paymentTestimonial;
  if (state.status === 'sending') {
    Object.assign(state, { status: 'uncertain', error: 'Previous sender stopped before recording the result' });
    return null;
  }
  const text = paymentTestimonialText(order, profile);
  Object.assign(state, { status: 'sending', claim: crypto.randomBytes(12).toString('hex'), claimedAt: now, attempts: state.attempts + 1 });
  return { orderId: order.orderId, claim: state.claim, attempts: state.attempts, text };
}

function completePaymentTestimonial(order, claim, outcome, now = Date.now()) {
  const state = order?.paymentTestimonial;
  if (!state || state.status !== 'sending' || state.claim !== claim) return false;
  if (outcome.status === 'sent') {
    Object.assign(state, { status: 'sent', messageId: outcome.messageId, sentAt: now });
    delete state.error;
  } else if (outcome.status === 'retry') {
    Object.assign(state, { status: 'pending', nextAttemptAt: now + Math.max(1000, outcome.retryAfterMs || 60_000), error: outcome.error });
  } else Object.assign(state, { status: 'uncertain', error: outcome.error || 'Telegram delivery result unknown' });
  delete state.claim;
  return true;
}

function createPaymentTestimonialWorker({ sources, token = process.env.TELEGRAM_BOT_TOKEN, fetchImpl = globalThis.fetch, logger = console, now = Date.now }) {
  let busy = false;
  let timer;
  const flush = async () => {
    if (!token || busy) return false;
    busy = true;
    try {
      const jobs = sources.flatMap(source => source.list(now()).map(orderId => ({ source, orderId })));
      for (const { source, orderId } of jobs) {
        const job = source.claim(orderId, now());
        if (!job) continue;
        let outcome;
        try {
          const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: TESTIMONIAL_CHAT_ID, text: job.text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
            signal: AbortSignal.timeout(15_000), redirect: 'error',
          });
          const data = await response.json();
          if (response.ok && data.ok === true && Number.isSafeInteger(data.result?.message_id)) {
            outcome = { status: 'sent', messageId: data.result.message_id };
          } else if (data.ok === false && Number(data.error_code) >= 400 && Number(data.error_code) < 500) {
            // Explicit Telegram rejection: nothing was sent, so a retry is safe.
            const backoff = Math.min(30 * 60_000, 60_000 * 2 ** Math.min(job.attempts - 1, 5));
            const retryAfter = Number(data.parameters?.retry_after) || 0;
            outcome = { status: 'retry', retryAfterMs: Math.max(backoff, retryAfter * 1000 + 1000), error: `Telegram rejected message (${data.error_code})` };
          } else outcome = { status: 'uncertain', error: `Telegram delivery could not be confirmed (HTTP ${response.status})` };
        } catch (_) {
          // A timeout/disconnect can happen after Telegram accepted the message.
          outcome = { status: 'uncertain', error: 'Telegram connection ended without a confirmed delivery result' };
        }
        source.complete(orderId, job.claim, outcome, now());
        logger.log(`[testimonials] ${outcome.status}${outcome.error ? `: ${outcome.error}` : ''}`);
        return true; // one post per tick, under Telegram's per-group message limit
      }
    } catch (error) {
      logger.error(`[testimonials] queue processing failed: ${error.code || error.name || 'Error'}`);
    } finally { busy = false; }
    return false;
  };
  return {
    flush,
    start() {
      if (!token) { logger.log('[testimonials] disabled: TELEGRAM_BOT_TOKEN is missing'); return; }
      if (timer) return;
      logger.log(`[testimonials] worker ready for ${TESTIMONIAL_CHAT_ID}`);
      timer = setInterval(flush, 3100);
      timer.unref();
      void flush();
    },
    stop() { if (timer) clearInterval(timer); timer = undefined; },
  };
}

module.exports = { TESTIMONIAL_CHAT_ID, maskedName, paymentTestimonialText, queuePaymentTestimonial, testimonialDue, claimPaymentTestimonial, completePaymentTestimonial, createPaymentTestimonialWorker };
