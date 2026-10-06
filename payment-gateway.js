// ============================================================
// payment-gateway.js — Phase B payment gateway adapter
//
// MODES (auto-detected, env-driven — NO keys are ever hardcoded):
//   'razorpay' — real Razorpay SDK/REST calls (TEST/SANDBOX keys only).
//                Active when RAZORPAY_KEY_ID + RAZORPAY_SECRET are set
//                (or PAYMENT_MODE=razorpay, which then REQUIRES them).
//   'sandbox'  — built-in local simulator implementing the *identical*
//                HMAC-SHA256 signature contract, used when no keys exist.
//                No network calls, no real money. Used by the payment test
//                suite; its endpoint is 404 in razorpay mode.
//
// Secrets stay server-side. The only value ever handed to the browser in
// razorpay mode is the PUBLISHABLE key_id.
// ============================================================
'use strict';
const crypto = require('crypto');

const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = process.env.RAZORPAY_SECRET || '';
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';
const MOCK_SECRET = process.env.PAYMENT_MOCK_SECRET || '';   // sandbox webhook+checkout signing
const EXPLICIT = (process.env.PAYMENT_MODE || '').toLowerCase();

let MODE;
if (EXPLICIT === 'razorpay' || (EXPLICIT !== 'sandbox' && KEY_ID && KEY_SECRET)) {
  if (!KEY_ID || !KEY_SECRET) throw new Error('PAYMENT_MODE=razorpay requires RAZORPAY_KEY_ID and RAZORPAY_SECRET in .env');
  MODE = 'razorpay';
} else {
  MODE = 'sandbox';
}
if (MODE === 'sandbox' && !MOCK_SECRET) {
  // ephemeral dev fallback (regenerated on restart) — same pattern as JWT_SECRET
  process.env.PAYMENT_MOCK_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('⚠️  PAYMENT_MOCK_SECRET not set — using ephemeral sandbox secret (webhook tests reset on restart).');
}
const mockSecret = () => process.env.PAYMENT_MOCK_SECRET || MOCK_SECRET;
const checkoutSecret = () => (MODE === 'razorpay' ? KEY_SECRET : mockSecret());
const webhookSecret = () => (MODE === 'razorpay' ? WEBHOOK_SECRET : mockSecret());

// ---------- signature primitives (identical in both modes) ----------
function hmacHex(str, secret) { return crypto.createHmac('sha256', String(secret)).update(String(str), 'utf8').digest('hex'); }
function safeEqual(a, b) {
  // constant-time compare via digest buffers (length-independent)
  const ha = crypto.createHash('sha256').update(String(a || ''), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b || ''), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb) && String(a || '').length === String(b || '').length;
}
// Razorpay checkout signature: HMAC_SHA256(order_id + '|' + payment_id, secret)
function checkoutSignature(orderId, paymentId) { return hmacHex(orderId + '|' + paymentId, checkoutSecret()); }
function verifyCheckoutSignature(orderId, paymentId, signature) {
  if (!signature || typeof signature !== 'string') return false;
  return safeEqual(checkoutSignature(orderId, paymentId), signature);
}
// Razorpay webhook signature: HMAC_SHA256(raw_request_body, webhook_secret)
function verifyWebhookSignature(rawBody, signature) {
  const secret = webhookSecret();
  if (!secret || !signature || !rawBody) return false;
  return safeEqual(hmacHex(rawBody, secret), signature);
}

// ---------- sandbox in-memory "gateway" (server-side only) ----------
const sandboxOrders = new Map();     // gatewayOrderId -> {amount, currency, receipt, internalOrderId}
const sandboxPayments = new Map();   // paymentId -> {id, order_id, amount, currency, status}

function sandboxCreateOrder({ amountPaise, currency, receipt }) {
  const id = 'order_sandbox_' + crypto.randomBytes(12).toString('hex');
  sandboxOrders.set(id, { amount: amountPaise, currency: currency || 'INR', receipt, internalOrderId: receipt });
  return { id, amount: amountPaise, currency: currency || 'INR' };
}
// "Customer completes payment" — signs the result exactly like Razorpay would.
function sandboxComplete({ gatewayOrderId, outcome = 'success', amount }) {
  const go = sandboxOrders.get(gatewayOrderId);
  if (!go) { const e = new Error('Unknown gateway order'); e.code = 'NO_GATEWAY_ORDER'; throw e; }
  const status = outcome === 'success' ? 'captured' : (outcome === 'cancelled' ? 'cancelled' : 'failed');
  const paymentId = 'pay_sandbox_' + crypto.randomBytes(10).toString('hex');
  const amt = amount === undefined || amount === null ? go.amount : Number(amount);
  sandboxPayments.set(paymentId, { id: paymentId, order_id: gatewayOrderId, amount: amt, currency: go.currency, status });
  return { paymentId, signature: checkoutSignature(gatewayOrderId, paymentId), outcome: status, amount: amt, currency: go.currency };
}

// ---------- HTTP calls ----------
const API = 'https://api.razorpay.com/v1';
async function razorpayCreateOrder({ amountPaise, currency, receipt, internalOrderId }) {
  const auth = Buffer.from(KEY_ID + ':' + KEY_SECRET).toString('base64');
  const r = await fetch(API + '/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + auth },
    body: JSON.stringify({ amount: amountPaise, currency: currency || 'INR', receipt, notes: { internalOrderId } })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('Razorpay create order failed:', r.status, j.error && j.error.description); const e = new Error('gateway-create-failed'); e.code = 'GATEWAY'; throw e; }
  return { id: j.id, amount: j.amount, currency: j.currency };
}
async function razorpayFetchPayment(paymentId) {
  const auth = Buffer.from(KEY_ID + ':' + KEY_SECRET).toString('base64');
  const r = await fetch(API + '/payments/' + encodeURIComponent(paymentId), { headers: { Authorization: 'Basic ' + auth } });
  if (!r.ok) { const e = new Error('gateway-fetch-failed'); e.code = 'GATEWAY'; throw e; }
  const j = await r.json();
  return { id: j.id, order_id: j.order_id, amount: j.amount, currency: j.currency, status: j.status };
}

// ---------- public adapter API ----------
module.exports = {
  get MODE() { return MODE; },
  keyId: () => KEY_ID || null,                       // publishable only
  checkoutSignature, verifyCheckoutSignature, verifyWebhookSignature, hmacHex, safeEqual,

  async createGatewayOrder(opts) {
    if (MODE === 'razorpay') return razorpayCreateOrder(opts);
    return sandboxCreateOrder(opts);
  },
  async fetchGatewayPayment(paymentId) {
    if (MODE === 'razorpay') return razorpayFetchPayment(paymentId);
    const p = sandboxPayments.get(paymentId);
    if (!p) { const e = new Error('gateway-payment-not-found'); e.code = 'NO_PAYMENT'; throw e; }
    return p;
  },
  // sandbox-only helpers (routes calling these 404 when MODE=razorpay)
  sandboxComplete,
  sandboxHasOrder: (id) => sandboxOrders.has(id)
};
