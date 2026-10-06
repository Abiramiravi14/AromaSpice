/* AromaSpice API audit — durable regression suite (recreated in-repo, Phase D)
 * Reconstructed from the documented behaviour of the original /tmp harness
 * (47 checks: anon-mutation guards →401, unknown login →401, q=( →200, self-cleaning).
 * Target: dev server on :3000 in sandbox payment mode. No secrets are read or printed.
 * Run: node tests/api-audit.js
 */
const BASE = process.env.AUDIT_BASE || 'http://localhost:3000';
const results = [];
const ok = (name, pass, info) => {
  results.push({ name, pass });
  console.log((pass ? 'PASS' : 'FAIL') + ' ' + name + (info ? ' -> ' + info : ''));
};

const ADMIN = { email: 'admin@aromaspice.com', password: 'admin123' };
const CUST = { email: 'riya.sharma@email.com', password: 'demo123' };

// cleanup registry
const created = { products: [], customers: [], orders: [] };

const req = async (method, path, { token, body } = {}) => {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await r.json(); } catch (e) { /* html/empty */ }
  return { status: r.status, body: json, raw: json };
};
const GET = (p, t) => req('GET', p, { token: t });
const POST = (p, b, t) => req('POST', p, { token: t, body: b === undefined ? {} : b });
const PUT = (p, b, t) => req('PUT', p, { token: t, body: b === undefined ? {} : b });
const DEL = (p, t) => req('DELETE', p, { token: t });

(async () => {
  // ---------- logins ----------
  const admin = (await POST('/api/customers/login', ADMIN)).body;
  const cust = (await POST('/api/customers/login', CUST)).body;
  if (!admin || !admin.token) { console.error('FATAL: admin login failed — is the server on ' + BASE + '?'); process.exit(2); }
  if (!cust || !cust.token) { console.error('FATAL: customer login failed'); process.exit(2); }
  const A = admin.token, C = cust.token;

  // ================= 1. PRODUCTS — read (12) =================
  const all = await GET('/api/products');
  ok('GET /api/products -> 200 array', all.status === 200 && Array.isArray(all.body), 'n=' + (all.body || []).length);
  const P = all.body;
  ok('products carry required fields', P.every(p => p.name && typeof p.price === 'number' && typeof p.stock === 'number' && p.category));
  const byCat = await GET('/api/products?category=Single%20Masala');
  ok('GET ?category= filters correctly', byCat.status === 200 && byCat.body.length > 0 && byCat.body.every(p => p.category === 'Single Masala'), 'n=' + byCat.body.length);
  const byQ = await GET('/api/products?q=Turmeric');
  ok('GET ?q= name search', byQ.status === 200 && byQ.body.length > 0 && byQ.body.every(p => /turmeric/i.test(p.name)), 'n=' + byQ.body.length);
  const noQ = await GET('/api/products?q=NoSuchProductXyz');
  ok('GET ?q= no match -> empty', noQ.status === 200 && noQ.body.length === 0);
  const badRe = await GET('/api/products?q=(');
  ok('GET ?q=( regex escaped -> 200 (no 500)', badRe.status === 200, 'http=' + badRe.status);
  const asc = await GET('/api/products?sort=price-low');
  ok('GET ?sort=price-low ascending', asc.status === 200 && asc.body.every((p, i, a) => !i || a[i - 1].price <= p.price));
  const desc = await GET('/api/products?sort=price-high');
  ok('GET ?sort=price-high descending', desc.status === 200 && desc.body.every((p, i, a) => !i || a[i - 1].price >= p.price));
  const byRate = await GET('/api/products?sort=rating');
  ok('GET ?sort=rating -> 200', byRate.status === 200, 'n=' + byRate.body.length);
  const one = await GET('/api/products/' + P[0]._id);
  ok('GET /api/products/:id -> 200', one.status === 200 && one.body._id === P[0]._id);
  const badId = await GET('/api/products/not-an-object-id');
  ok('GET /api/products/<garbage> -> 400 Invalid ID format', badId.status === 400 && /Invalid ID format/.test(badId.body.error), 'http=' + badId.status);
  const noId = await GET('/api/products/000000000000000000000000');
  ok('GET /api/products/<missing> -> 404', noId.status === 404, 'http=' + noId.status);

  // ================= 2. PRODUCTS — write guards (9) =================
  const pAnon = await POST('/api/products', { name: 'X', price: 10, stock: 1 });
  ok('POST /api/products anon -> 401', pAnon.status === 401, 'http=' + pAnon.status);
  const pCust = await POST('/api/products', { name: 'X', price: 10, stock: 1 }, C);
  ok('POST /api/products customer -> 403', pCust.status === 403, 'http=' + pCust.status);
  const pBadPrice = await POST('/api/products', { name: 'Audit Temp', price: 0, stock: 5 }, A);
  ok('POST price=0 -> 400', pBadPrice.status === 400, 'http=' + pBadPrice.status);
  const pBadStock = await POST('/api/products', { name: 'Audit Temp', price: 10, stock: -5 }, A);
  ok('POST stock=-5 -> 400', pBadStock.status === 400, 'http=' + pBadStock.status);
  const pNew = await POST('/api/products', { name: 'Audit Temp Product', category: 'Single Masala', price: 99, stock: 3, weight: '1g', img: '', description: 'temp' }, A);
  if (pNew.status === 201) created.products.push(pNew.body._id);
  ok('POST admin valid -> 201', pNew.status === 201, 'http=' + pNew.status);
  const putAnon = await PUT('/api/products/' + P[0]._id, { price: 1 });
  ok('PUT /api/products/:id anon -> 401', putAnon.status === 401, 'http=' + putAnon.status);
  const putMissing = await PUT('/api/products/000000000000000000000000', { price: 1 }, A);
  ok('PUT /api/products/<missing> -> 404', putMissing.status === 404, 'http=' + putMissing.status);
  const delAnon = await DEL('/api/products/' + P[0]._id);
  ok('DELETE /api/products/:id anon -> 401', delAnon.status === 401, 'http=' + delAnon.status);
  if (pNew.status === 201) {
    const d = await DEL('/api/products/' + pNew.body._id, A);
    ok('DELETE admin temp product -> 200 (cleanup)', d.status === 200, 'http=' + d.status);
    created.products = created.products.filter(x => x !== pNew.body._id);
  } else {
    ok('DELETE admin temp product -> 200 (cleanup)', false, 'skipped: product not created');
  }

  // ================= 3. CUSTOMERS (12) =================
  const cAnon = await GET('/api/customers');
  ok('GET /api/customers anon -> 401', cAnon.status === 401, 'http=' + cAnon.status);
  const cCust = await GET('/api/customers', C);
  ok('GET /api/customers customer -> 403', cCust.status === 403, 'http=' + cCust.status);
  const cAdm = await GET('/api/customers', A);
  ok('GET /api/customers admin -> 200, no password field', cAdm.status === 200 && cAdm.body.every(c => c.password === undefined), 'n=' + (cAdm.body || []).length);
  const rMiss = await POST('/api/customers/register', { email: 'x@y.com' });
  ok('register missing fields -> 400', rMiss.status === 400, 'http=' + rMiss.status);
  const rBadMail = await POST('/api/customers/register', { fullName: 'X', email: 'not-an-email', password: 'secret123' });
  ok('register invalid email -> 400', rBadMail.status === 400, 'http=' + rBadMail.status);
  const rShortPw = await POST('/api/customers/register', { fullName: 'X', email: 'x@y.com', password: '123' });
  ok('register short password -> 400', rShortPw.status === 400, 'http=' + rShortPw.status);
  const rDup = await POST('/api/customers/register', { fullName: 'Riya', email: CUST.email, password: 'secret123' });
  ok('register duplicate email -> 400', rDup.status === 400, 'http=' + rDup.status);
  const auditEmail = 'audit.tester.' + Date.now() + '@email.com';
  const rRole = await POST('/api/customers/register', { fullName: 'Audit Tester', email: auditEmail, password: 'secret123', phone: '9000000000', role: 'admin' });
  if (rRole.status === 201) created.customers.push(rRole.body.id || rRole.body._id);
  ok('register role:admin ignored (mass-assignment)', rRole.status === 201 && rRole.body.role === 'customer', 'role=' + (rRole.body && rRole.body.role));
  const lUnknown = await POST('/api/customers/login', { email: 'nobody@nowhere.com', password: 'whatever1' });
  const lWrong = await POST('/api/customers/login', { email: CUST.email, password: 'wrongpassword' });
  ok('login unknown email -> 401', lUnknown.status === 401, 'http=' + lUnknown.status);
  ok('login wrong password -> 401 (identical generic msg, no enumeration)',
    lWrong.status === 401 && lWrong.body.error === lUnknown.body.error, JSON.stringify(lWrong.body && lWrong.body.error));
  const lMiss = await POST('/api/customers/login', { email: CUST.email });
  ok('login missing password -> 400', lMiss.status === 400, 'http=' + lMiss.status);
  const lOk = await POST('/api/customers/login', CUST);
  ok('login valid -> 200 + token, no password leak', lOk.status === 200 && !!lOk.body.token && lOk.body.password === undefined);

  // ================= 4. ORDERS (8) =================
  const oAnon = await GET('/api/orders');
  ok('GET /api/orders anon -> 401', oAnon.status === 401, 'http=' + oAnon.status);
  const oCust = await GET('/api/orders', C);
  ok('GET /api/orders customer -> 200', oCust.status === 200 && Array.isArray(oCust.body), 'n=' + (oCust.body || []).length);
  const oNoItems = await POST('/api/orders', { items: [], customerName: 'X' });
  ok('POST /api/orders no items -> 400', oNoItems.status === 400, 'http=' + oNoItems.status);
  const oBadProd = await POST('/api/orders', { items: [{ productId: '000000000000000000000000', qty: 1 }], customerName: 'X' });
  ok('POST /api/orders unknown product -> 400', oBadProd.status === 400, 'http=' + oBadProd.status);
  const oBadQty = await POST('/api/orders', { items: [{ productId: P[0]._id, qty: 0 }], customerName: 'X' });
  ok('POST /api/orders qty=0 -> 400', oBadQty.status === 400, 'http=' + oBadQty.status);
  const auditProd = P.find(p => p.name === 'Turmeric Powder');
  const oNew = await POST('/api/orders', {
    customerName: 'Audit Guest', customerEmail: auditEmail, paymentMethod: 'UPI',
    items: [{ productId: auditProd._id, qty: 1, price: 1 }],   // tampered client price on purpose
    address: { street: '1 Test St', city: 'Pune', state: 'Maharashtra', pincode: '411001', phone: '9000000000' }
  });
  if (oNew.status === 201) created.orders.push(oNew.body.orderId);
  ok('POST /api/orders server-priced (client price ignored; no coupon ⇒ no discount)', oNew.status === 201 && oNew.body.total === 149, 'total=' + (oNew.body && oNew.body.total));
  // orderId starts with '#' -> MUST be percent-encoded or it truncates the path
  const encId = encodeURIComponent(oNew.body && oNew.body.orderId);
  const track = await GET('/api/orders/' + encId);
  ok('GET /api/orders/:id anonymous tracking -> 200', track.status === 200, 'http=' + track.status);
  const trackMissing = await GET('/api/orders/' + encodeURIComponent('#AS000000000'));
  ok('GET /api/orders/<missing> -> 404', trackMissing.status === 404, 'http=' + trackMissing.status);

  // ================= 5. ADMIN / MISC (6) =================
  const sAnon = await GET('/api/admin/stats');
  ok('GET /api/admin/stats anon -> 401', sAnon.status === 401, 'http=' + sAnon.status);
  const sCust = await GET('/api/admin/stats', C);
  ok('GET /api/admin/stats customer -> 403', sCust.status === 403, 'http=' + sCust.status);
  const sAdm = await GET('/api/admin/stats', A);
  ok('GET /api/admin/stats admin -> 200', sAdm.status === 200, 'http=' + sAdm.status);
  const putOrdAnon = await PUT('/api/orders/' + encId, { status: 'Shipped' });
  ok('PUT /api/orders/:id anon -> 401', putOrdAnon.status === 401, 'http=' + putOrdAnon.status);
  const putOrdCust = await PUT('/api/orders/' + encId, { status: 'Shipped' }, C);
  ok('PUT /api/orders/:id customer -> 403', putOrdCust.status === 403, 'http=' + putOrdCust.status);
  const badStatus = await PUT('/api/orders/' + encId, { status: 'Teleported' }, A);
  ok('PUT /api/orders/:id invalid status -> 400', badStatus.status === 400, 'http=' + badStatus.status);
  const wh = await POST('/api/payments/webhook', { event: 'payment.captured' });
  ok('POST /api/payments/webhook unsigned -> 401', wh.status === 401, 'http=' + wh.status);
  const nf = await fetch(BASE + '/no-such-page-xyz');
  ok('GET unknown page -> 404', nf.status === 404, 'http=' + nf.status);

  // ================= cleanup (self-cleaning harness) =================
  for (const id of created.orders) await DEL('/api/orders/' + encodeURIComponent(id), A);
  for (const id of created.customers) await DEL('/api/customers/' + id, A);
  for (const id of created.products) await DEL('/api/products/' + id, A);
  if (created.orders.length) console.log('cleanup: deleted ' + created.orders.length + ' audit order(s) (stock auto-restored)');
  if (created.customers.length) console.log('cleanup: deleted ' + created.customers.length + ' audit customer(s)');
  if (created.products.length) console.log('cleanup: deleted ' + created.products.length + ' audit product(s)');

  const pass = results.filter(r => r.pass).length;
  const fail = results.length - pass;
  console.log('\n===== API AUDIT: ' + pass + ' pass, ' + fail + ' fail =====');
  if (fail) console.log('failed:\n' + results.filter(r => !r.pass).map(r => '  - ' + r.name).join('\n'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e.message); process.exit(2); });
