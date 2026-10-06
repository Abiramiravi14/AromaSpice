/* ============================================================
 * PHASE B — PAYMENT TEST SUITE (sandbox mode, never real money)
 * 12 mandated scenarios + expiry sweep. Run: node payment-test.js
 * Contract under test (server must implement EXACTLY this):
 *   POST /api/payments/create       201 fresh | 200 idempotent replay
 *   POST /api/payments/mock/complete (sandbox only) → signed payment token
 *   POST /api/payments/verify       200 order(Paid) | 400/404, never trusts client
 *   POST /api/payments/webhook      200 signed/acked | 401 unsigned/forged
 *   GET  /api/payments/:orderId/status
 *   POST /api/payments/sweep        admin: release expired pendings
 * ============================================================ */
const fs = require('fs');
const BASE = 'http://localhost:3000';
const PROJ = '/home/monesh/Desktop/MCA Project /stitch_aromaspice_e_commerce_ui_system';

// local test fixtures from project .env (test-only secrets, never real gateway creds)
const envTxt = fs.readFileSync(PROJ + '/.env', 'utf8');
const envOf = (k) => (envTxt.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1] || '';
const MOCK_SECRET = envOf('PAYMENT_MOCK_SECRET');
const JWT_SECRET = envOf('JWT_SECRET');
if (!MOCK_SECRET) { console.log('FATAL: PAYMENT_MOCK_SECRET missing from .env'); process.exit(2); }

const crypto = require('crypto');
const hmac = (s, secret) => crypto.createHmac('sha256', secret).update(s).digest('hex');

const results = [];
const ok = (name, pass, info) => { results.push(!!pass); console.log((pass ? '✅' : '❌') + ' ' + name + (info ? ' — ' + info : '')); };
const J = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const post = (p, body, token) => fetch(BASE + p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: JSON.stringify(body || {}) });
const get = (p, token) => fetch(BASE + p, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
const del = (p, token) => fetch(BASE + p, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
const stockOf = async (name) => {
  const list = (await (await get('/api/products?q=' + encodeURIComponent(name))).json());
  const p = (Array.isArray(list) ? list : []).find(x => x.name === name);
  return p ? p.stock : null;
};
const K = () => 'PAYTEST-' + crypto.randomBytes(8).toString('hex');
const mkItems = (name, weight, qty) => [{ name, weight, qty, price: 1 }]; // prices ignored (Phase A)

const createdIds = [];   // for cleanup
async function createPay(idem, items, method) {
  const r = await J(await post('/api/payments/create', {
    customerName: 'Payment Tester', customerEmail: 'pay.test@x.com',
    items, address: { street: '1 Test St', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' },
    paymentMethod: method || 'UPI', idempotencyKey: idem
  }));
  if (r.body && r.body.internalOrderId) createdIds.push(r.body.internalOrderId);
  return r;
}
async function complete(gatewayOrderId, outcome, amount) {
  return J(await post('/api/payments/mock/complete', { gatewayOrderId, outcome, amount }));
}
async function verify(payload) { return J(await post('/api/payments/verify', payload)); }
async function statusOf(orderId) { return J(await get('/api/payments/' + encodeURIComponent(orderId) + '/status')); }
function webhook(gatewayOrderId, event, extra, sigOverride) {
  const payload = Object.assign({
    event,
    payload: { payment: { entity: Object.assign({ id: 'pay_unknown', order_id: gatewayOrderId, amount: 0, currency: 'INR', status: 'captured' }, extra || {}) } }
  });
  const raw = JSON.stringify(payload);
  return fetch(BASE + '/api/payments/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sigOverride || hmac(raw, MOCK_SECRET) },
    body: raw
  });
}
async function orderOf(orderId) {
  const tok = (await J(await post('/api/customers/login', { email: 'admin@aromaspice.com', password: 'admin123' }))).body.token;
  const list = (await (await get('/api/orders', tok)).json());
  return { tok, order: (Array.isArray(list) ? list : []).find(o => o.orderId === orderId) };
}

(async () => {
  const ADM = (await J(await post('/api/customers/login', { email: 'admin@aromaspice.com', password: 'admin123' }))).body.token;
  if (!ADM) { console.log('FATAL: admin login failed'); process.exit(2); }
  const S = {}; // stock before each product use
  for (const n of ['Turmeric Powder', 'Chilli Powder', 'Coriander Powder', 'Rasam Powder', 'Sambar Powder', 'Garam Masala', 'Black Pepper Powder', 'Chat Masala', 'Aroma Combo Pack']) S[n] = await stockOf(n);
  console.log('stocks before: ' + JSON.stringify(S));

  // ===== 1. SUCCESSFUL PAYMENT =====
  let r = await createPay(K(), mkItems('Chilli Powder', '200g', 1));
  ok('1a. create → 201 + gateway order info (no secrets)', r.status === 201 && r.body.gatewayOrderId && r.body.mode === 'sandbox' && r.body.amount === 15200 && r.body.currency === 'INR' && r.body.keyId == null,
    'http=' + r.status + ' amt=' + r.body.amount);
  const g1 = r.body.gatewayOrderId, o1 = r.body.internalOrderId;
  ok('1b. amount = server price ×100 paise (15200)', r.body.amount === 15200, String(r.body.amount));
  let c = await complete(g1, 'success');
  ok('1c. sandbox complete → signed token', c.status === 200 && c.body.paymentId && c.body.signature, 'pay=' + c.body.paymentId);
  let v = await verify({ gatewayOrderId: g1, paymentId: c.body.paymentId, signature: c.body.signature });
  ok('1d. verify → 200 Paid', v.status === 200 && v.body.paymentStatus === 'Paid', 'status=' + v.body.paymentStatus);
  const od1 = (await orderOf(o1)).order;
  ok('1e. payment fields stored (gatewayPaymentId + verifiedAt), order status untouched',
    od1 && od1.paymentStatus === 'Paid' && od1.gatewayPaymentId === c.body.paymentId && !!od1.paymentVerifiedAt && od1.status === 'Processing',
    'order=' + (od1 && od1.status) + ' pay=' + (od1 && od1.paymentStatus));
  ok('1f. stock decremented exactly once', (await stockOf('Chilli Powder')) === S['Chilli Powder'] - 1, String(await stockOf('Chilli Powder')));

  // ===== 2. FAILED PAYMENT =====
  r = await createPay(K(), mkItems('Turmeric Powder', '200g', 1));
  const g2 = r.body.gatewayOrderId, o2 = r.body.internalOrderId;
  c = await complete(g2, 'failure');
  v = await verify({ gatewayOrderId: g2, paymentId: c.body.paymentId, signature: c.body.signature });
  const od2 = (await orderOf(o2)).order;
  ok('2a. failed payment → 400 + paymentStatus Failed', v.status === 400 && od2.paymentStatus === 'Failed', 'http=' + v.status + ' pay=' + od2.paymentStatus);
  ok('2b. stock restored on failure', (await stockOf('Turmeric Powder')) === S['Turmeric Powder'], String(await stockOf('Turmeric Powder')));
  ok('2c. order status NOT mixed with payment (still Processing)', od2.status === 'Processing', od2.status);

  // ===== 3. CANCELLED PAYMENT =====
  r = await createPay(K(), mkItems('Garam Masala', '100g', 1));
  const g3 = r.body.gatewayOrderId, o3 = r.body.internalOrderId;
  c = await complete(g3, 'cancelled');
  v = await verify({ gatewayOrderId: g3, paymentId: c.body.paymentId, signature: c.body.signature });
  const od3 = (await orderOf(o3)).order;
  ok('3a. cancelled payment → 400 + paymentStatus Cancelled', v.status === 400 && od3.paymentStatus === 'Cancelled', 'http=' + v.status + ' pay=' + od3.paymentStatus);
  ok('3b. stock restored on cancel', (await stockOf('Garam Masala')) === S['Garam Masala'], String(await stockOf('Garam Masala')));

  // ===== 4. INVALID SIGNATURE =====
  r = await createPay(K(), mkItems('Chilli Powder', '200g', 1));
  const g4 = r.body.gatewayOrderId, o4 = r.body.internalOrderId;
  c = await complete(g4, 'success');
  v = await verify({ gatewayOrderId: g4, paymentId: c.body.paymentId, signature: 'a'.repeat(64) });
  let od4 = (await orderOf(o4)).order;
  ok('4a. invalid signature → 400, NOT marked paid', v.status === 400 && od4.paymentStatus !== 'Paid', 'http=' + v.status + ' pay=' + od4.paymentStatus);
  ok('4b. no state change: still Pending, stock still held (T1 paid −1 + T4 pending −1)', od4.paymentStatus === 'Pending' && (await stockOf('Chilli Powder')) === S['Chilli Powder'] - 2,
    'pay=' + od4.paymentStatus + ' stock=' + (await stockOf('Chilli Powder')) + ' want=' + (S['Chilli Powder'] - 2));

  // ===== 5. WRONG PAYMENT AMOUNT =====
  r = await createPay(K(), mkItems('Turmeric Powder', '200g', 1));
  const g5 = r.body.gatewayOrderId, o5 = r.body.internalOrderId;
  c = await complete(g5, 'success', r.body.amount + 1000); // gateway reports inflated amount
  v = await verify({ gatewayOrderId: g5, paymentId: c.body.paymentId, signature: c.body.signature });
  const od5 = (await orderOf(o5)).order;
  ok('5a. amount mismatch → 400, payment Failed', v.status === 400 && od5.paymentStatus === 'Failed', 'http=' + v.status + ' pay=' + od5.paymentStatus);
  ok('5b. stock restored after amount-mismatch failure', (await stockOf('Turmeric Powder')) === S['Turmeric Powder'], String(await stockOf('Turmeric Powder')));

  // ===== 6. WRONG GATEWAY ORDER ID =====
  r = await createPay(K(), mkItems('Coriander Powder', '200g', 1));
  const g6 = r.body.gatewayOrderId, o6 = r.body.internalOrderId;
  c = await complete(g6, 'success');
  v = await verify({ gatewayOrderId: 'order_sandbox_bogus999', paymentId: c.body.paymentId, signature: c.body.signature });
  let od6 = (await orderOf(o6)).order;
  ok('6a. unknown gateway order → 404', v.status === 404, 'http=' + v.status);
  // signature over a DIFFERENT order id with valid-looking hex
  v = await verify({ gatewayOrderId: g6, paymentId: c.body.paymentId, signature: hmac(g6 + '|some_other_pay', MOCK_SECRET) });
  od6 = (await orderOf(o6)).order;
  ok('6b. signature for different payment id → 400, order untouched (Pending, stock held)',
    v.status === 400 && od6.paymentStatus === 'Pending' && (await stockOf('Coriander Powder')) === S['Coriander Powder'] - 1,
    'http=' + v.status + ' pay=' + od6.paymentStatus);

  // ===== 7. DUPLICATE PAYMENT REQUEST (idempotency) =====
  const k7 = K();
  const d1 = await createPay(k7, mkItems('Chilli Powder', '200g', 2));
  const d2 = await createPay(k7, mkItems('Chilli Powder', '200g', 2));
  ok('7a. same idempotencyKey → same order + same gateway order', d1.status === 201 && d2.status === 200 && d1.body.internalOrderId === d2.body.internalOrderId && d1.body.gatewayOrderId === d2.body.gatewayOrderId,
    d1.status + '/' + d2.status + ' ' + d1.body.internalOrderId + ' vs ' + d2.body.internalOrderId);
  ok('7b. stock decremented ONCE for double-submitted checkout (cumulative T1 −1, T4 −1, T7 −2)', (await stockOf('Chilli Powder')) === S['Chilli Powder'] - 4,
    'stock=' + (await stockOf('Chilli Powder')) + ' want=' + (S['Chilli Powder'] - 4));
  // parallel double-click
  const k7b = K();
  const [p1, p2] = await Promise.all([createPay(k7b, mkItems('Turmeric Powder', '200g', 1)), createPay(k7b, mkItems('Turmeric Powder', '200g', 1))]);
  ok('7c. parallel duplicate → one order, same id', p1.status < 400 && p2.status < 400 && p1.body.internalOrderId === p2.body.internalOrderId,
    'http=' + p1.status + '/' + p2.status + ' ' + p1.body.internalOrderId + ' vs ' + p2.body.internalOrderId);
  // cleanup their held stock path later (orders deleted at end)
  createdIds.push(p1.body.internalOrderId);

  // ===== 8. REPEATED WEBHOOK =====
  r = await createPay(K(), mkItems('Rasam Powder', '200g', 1));
  const g8 = r.body.gatewayOrderId, o8 = r.body.internalOrderId;
  const pay8 = 'pay_sandbox_wh000001';
  const forged = await webhook(g8, 'payment.captured', { id: pay8, amount: 12300 }, 'f'.repeat(64));
  let od8 = (await orderOf(o8)).order;
  ok('8a. forged webhook signature → 401, unpaid', forged.status === 401 && od8.paymentStatus === 'Pending', 'http=' + forged.status + ' pay=' + od8.paymentStatus);
  const w1 = await webhook(g8, 'payment.captured', { id: pay8, amount: 12300 });
  const w2 = await webhook(g8, 'payment.captured', { id: pay8, amount: 12300 });
  od8 = (await orderOf(o8)).order;
  ok('8b. repeated valid webhook → 200/200, Paid exactly once', w1.status === 200 && w2.status === 200 && od8.paymentStatus === 'Paid',
    w1.status + '/' + w2.status + ' pay=' + od8.paymentStatus);
  ok('8c. webhook did NOT disturb stock (still reserved −1)', (await stockOf('Rasam Powder')) === S['Rasam Powder'] - 1, String(await stockOf('Rasam Powder')));
  const wNoSig = await fetch(BASE + '/api/payments/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'payment.captured' }) });
  ok('8d. webhook without signature header → 401', wNoSig.status === 401, String(wNoSig.status));

  // ===== 9. UNAUTHORIZED PAYMENT VERIFICATION =====
  v = await verify({});
  ok('9a. verify with no fields → 400', v.status === 400, String(v.status));
  r = await createPay(K(), mkItems('Sambar Powder', '200g', 1));
  const g9 = r.body.gatewayOrderId, o9 = r.body.internalOrderId;
  c = await complete(g9, 'success');
  // signature computed over wrong payload (payment id only) with real secret — still wrong format
  v = await verify({ gatewayOrderId: g9, paymentId: c.body.paymentId, signature: hmac(c.body.paymentId, MOCK_SECRET) });
  const od9 = (await orderOf(o9)).order;
  ok('9b. wrong-payload signature (real secret) → 400, still Pending', v.status === 400 && od9.paymentStatus === 'Pending', 'http=' + v.status + ' pay=' + od9.paymentStatus);

  // ===== 10. EXPIRED / INVALID AUTHENTICATION =====
  let st = null;
  if (JWT_SECRET) {
    const jwt = require(PROJ + '/node_modules/jsonwebtoken');
    const expired = jwt.sign({ id: 'x', email: 'a@b.c', role: 'customer' }, JWT_SECRET, { expiresIn: '-1s' });
    st = (await get('/api/orders', expired)).status;
  }
  ok('10a. expired JWT → 401', st === 401, String(st));
  const tampered = (ADM.slice(0, 20) + (ADM[20] === 'A' ? 'B' : 'A') + ADM.slice(21));
  st = (await get('/api/orders', tampered)).status;
  ok('10b. tampered JWT → 401', st === 401, String(st));
  st = (await post('/api/payments/sweep', {}, 'Bearer expired.garbage.token')).status;
  ok('10c. admin sweep with garbage token → 401', st === 401, String(st));

  // ===== 11. BROWSER CLOSES AFTER PAYMENT (webhook is source of truth) =====
  r = await createPay(K(), mkItems('Black Pepper Powder', '100g', 1));
  const g11 = r.body.gatewayOrderId, o11 = r.body.internalOrderId;
  c = await complete(g11, 'success');
  // browser dies here — no verify call
  let s11 = (await statusOf(o11)).body;
  ok('11a. after gateway success, before callback → status endpoint shows Pending', s11.paymentStatus === 'Pending' && s11.paid === false, 'pay=' + s11.paymentStatus);
  const w11 = await webhook(g11, 'payment.captured', { id: 'pay_sandbox_browserclose', amount: 19000 });
  s11 = (await statusOf(o11)).body;
  ok('11b. late webhook confirms → Paid (browser not required)', w11.status === 200 && s11.paymentStatus === 'Paid' && s11.paid === true,
    'http=' + w11.status + ' pay=' + s11.paymentStatus);
  ok('11c. stock stays reserved after successful payment', (await stockOf('Black Pepper Powder')) === S['Black Pepper Powder'] - 1, String(await stockOf('Black Pepper Powder')));
  // late/duplicate browser callback after webhook already paid
  v = await verify({ gatewayOrderId: g11, paymentId: c.body.paymentId, signature: c.body.signature });
  ok('11d. late browser verify after webhook → still 200 Paid (idempotent)', v.status === 200 && v.body.paymentStatus === 'Paid', 'http=' + v.status);

  // ===== 12. PAYMENT CALLBACK REPEATED =====
  r = await createPay(K(), mkItems('Chat Masala', '100g', 1));
  const g12 = r.body.gatewayOrderId, o12 = r.body.internalOrderId;
  c = await complete(g12, 'success');
  const v1 = await verify({ gatewayOrderId: g12, paymentId: c.body.paymentId, signature: c.body.signature });
  const od12a = (await orderOf(o12)).order;
  const v2 = await verify({ gatewayOrderId: g12, paymentId: c.body.paymentId, signature: c.body.signature });
  const od12b = (await orderOf(o12)).order;
  ok('12. repeated verify callback → 200/200, Paid once, stock decremented once',
    v1.status === 200 && v2.status === 200 && od12b.paymentStatus === 'Paid' &&
    (await stockOf('Chat Masala')) === S['Chat Masala'] - 1,
    v1.status + '/' + v2.status + ' stock=' + (await stockOf('Chat Masala')));

  // ===== B13 (bonus). EXPIRED PENDING RELEASE (stock never permanently held) =====
  r = await createPay(K(), mkItems('Aroma Combo Pack', 'Pack of 4', 1));
  const o13 = r.body.internalOrderId;
  // backdate the order via direct DB (local test harness) then run admin sweep
  const mongoose = require(PROJ + '/node_modules/mongoose');
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/aromaspice_ui_system');
  await mongoose.connection.collection('orders').updateOne({ orderId: o13 }, { $set: { orderDate: new Date(Date.now() - 3 * 60 * 60 * 1000) } });
  const sw = await J(await post('/api/payments/sweep', {}, ADM));
  await mongoose.disconnect();
  const od13 = (await orderOf(o13)).order;
  ok('B13a. admin sweep releases expired Pending → Cancelled', sw.status === 200 && od13.paymentStatus === 'Cancelled', 'http=' + sw.status + ' pay=' + od13.paymentStatus);
  ok('B13b. stock restored for expired pending', (await stockOf('Aroma Combo Pack')) === S['Aroma Combo Pack'], String(await stockOf('Aroma Combo Pack')));

  // ===== CLEANUP: delete every test order (auto-restores held stock) =====
  let deleted = 0;
  for (const id of [...new Set(createdIds)]) { if (id) { const d = await del('/api/orders/' + encodeURIComponent(id), ADM); if (d.status === 200) deleted++; } }
  console.log('cleanup: deleted ' + deleted + '/' + new Set(createdIds).size + ' test orders');
  let stocksOK = true;
  for (const n of Object.keys(S)) {
    const now = await stockOf(n);
    if (now !== S[n]) { stocksOK = false; console.log('   stock drift ' + n + ': ' + now + ' != ' + S[n]); }
  }
  ok('FINAL. all seed stocks back to pre-test values', stocksOK);
  const list = (await (await get('/api/orders', ADM)).json()).filter(o => o.customerName === 'Payment Tester');
  ok('FINAL. no Payment Tester orders remain', list.length === 0, 'left=' + list.length);

  const passed = results.filter(Boolean).length;
  console.log('\n===== PAYMENT SUITE: ' + passed + '/' + results.length + ' passed =====');
  process.exit(passed === results.length ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
