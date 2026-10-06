/* AromaSpice security suite — durable regression (recreated in-repo, Phase D)
 * Reconstructed from the documented 13 checks: 401 / 403 / own / IDOR / mass-assign /
 * expired JWT / tampered JWT / role-escalation / no-password-leak / cross-edit / order-ownership.
 * Secrets are read from .env to craft adversarial tokens and are NEVER printed.
 * Run: node tests/security-test.js
 */
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const BASE = process.env.SEC_BASE || 'http://localhost:3000';
const results = [];
const ok = (name, pass, info) => {
  results.push({ name, pass });
  console.log((pass ? 'PASS' : 'FAIL') + ' ' + name + (info ? ' -> ' + info : ''));
};

// JWT secret: needed only to mint expired / role-escalated tokens. Never logged.
function loadJwtSecret() {
  try {
    const t = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    const m = t.match(/^JWT_SECRET=(.*)$/m);
    if (m && m[1].trim()) return m[1].trim();
  } catch (e) { /* no .env */ }
  return null;
}
const JWT_SECRET = loadJwtSecret();

const req = async (method, p, { token, body } = {}) => {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch (e) {}
  return { status: r.status, body: json };
};

(async () => {
  const admin = (await req('POST', '/api/customers/login', { body: { email: 'admin@aromaspice.com', password: 'admin123' } })).body;
  const cust = (await req('POST', '/api/customers/login', { body: { email: 'riya.sharma@email.com', password: 'demo123' } })).body;
  if (!admin?.token || !cust?.token) { console.error('FATAL: logins failed — server on ' + BASE + '?'); process.exit(2); }
  const A = admin.token, C = cust.token;
  const created = [];

  // 1. anonymous access to a protected route
  let r = await req('GET', '/api/orders');
  ok('1. protected route without token -> 401', r.status === 401, 'http=' + r.status);

  // 2. authenticated but not admin -> 403
  r = await req('GET', '/api/customers', { token: C });
  ok('2. non-admin on admin route -> 403', r.status === 403, 'http=' + r.status);

  // 3. owner may update own profile
  const me = (await req('GET', '/api/customers', { token: A })).body.find(c => c.email === 'riya.sharma@email.com');
  r = await req('PUT', '/api/customers/' + me._id, { token: C, body: { phone: '9876500000' } });
  ok('3. owner updates own profile -> 200', r.status === 200, 'http=' + r.status);
  await req('PUT', '/api/customers/' + me._id, { token: C, body: { phone: '9876543210' } });   // restore

  // 4. IDOR: update somebody else's profile
  const victim = (await req('GET', '/api/customers', { token: A })).body.find(c => c.email === 'karan.singh@email.com');
  r = await req('PUT', '/api/customers/' + victim._id, { token: C, body: { phone: '1111111111' } });
  ok('4. IDOR: edit another customer -> 403', r.status === 403, 'http=' + r.status);

  // 5. mass-assignment ignored on profile update (role/password stripped)
  r = await req('PUT', '/api/customers/' + me._id, { token: C, body: { role: 'admin', password: 'hacked123' } });
  const after = (await req('GET', '/api/customers', { token: A })).body.find(c => c._id === me._id);
  const oldPwStillWorks = (await req('POST', '/api/customers/login', { body: { email: 'riya.sharma@email.com', password: 'demo123' } })).status === 200;
  ok('5. mass-assign role/password ignored on update', r.status === 200 && after.role === 'customer' && oldPwStillWorks,
    'role=' + after.role + ' oldPasswordStillWorks=' + oldPwStillWorks);

  // 6. public register cannot mint an admin
  const secEmail = 'sec.tester.' + Date.now() + '@email.com';
  const reg = await req('POST', '/api/customers/register', { body: { fullName: 'Sec Tester', email: secEmail, password: 'secret123', role: 'admin' } });
  if (reg.status === 201) created.push(reg.body.id || reg.body._id);
  ok('6. register with role:admin -> role forced customer', reg.status === 201 && reg.body.role === 'customer', 'role=' + (reg.body && reg.body.role));

  // 7. expired JWT rejected
  if (JWT_SECRET) {
    const expired = jwt.sign({ id: cust.id, email: cust.email, role: 'customer' }, JWT_SECRET, { expiresIn: '-1h' });
    r = await req('GET', '/api/orders', { token: expired });
    ok('7. expired JWT -> 401', r.status === 401, 'http=' + r.status);
  } else {
    ok('7. expired JWT -> 401', false, 'SKIPPED: JWT_SECRET absent from .env (cannot mint expired token)');
  }

  // 8. tampered JWT (payload edited, signature kept) rejected
  const [hdr, pay, sig] = C.split('.');
  const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(pay, 'base64url')), role: 'admin' })).toString('base64url');
  r = await req('GET', '/api/customers', { token: hdr + '.' + edited + '.' + sig });
  ok('8. tampered JWT payload -> 401', r.status === 401, 'http=' + r.status);

  // 9. role-escalation token signed with an attacker key rejected
  if (JWT_SECRET) {
    const forged = jwt.sign({ id: cust.id, email: cust.email, role: 'admin' }, 'attacker-key-' + 'x'.repeat(32), { expiresIn: '1h' });
    r = await req('GET', '/api/customers', { token: forged });
    ok('9. role-escalation JWT (wrong signing key) -> 401', r.status === 401, 'http=' + r.status);
  } else {
    ok('9. role-escalation JWT (wrong signing key) -> 401', false, 'SKIPPED: JWT_SECRET absent');
  }

  // 10. no password material ever leaves the API
  const list = (await req('GET', '/api/customers', { token: A })).body;
  const prof = await req('GET', '/api/customers', { token: A });
  const leaked = list.some(c => c.password !== undefined) || JSON.stringify(prof.body).includes('$2') || JSON.stringify(prof.body).includes('"password"');
  ok('10. no password/hash leaked in API responses', !leaked);

  // 11. cross-edit: customer cannot change order status (admin-only)
  const prods = (await req('GET', '/api/products')).body;
  const turmeric = prods.find(p => p.name === 'Turmeric Powder');
  const ord = await req('POST', '/api/orders', { body: { customerName: 'Sec Tester', items: [{ productId: turmeric._id, qty: 1 }], address: {} } });
  if (ord.status === 201) created.push(ord.body.orderId);
  const enc = encodeURIComponent(ord.body.orderId);
  r = await req('PUT', '/api/orders/' + enc, { token: C, body: { status: 'Delivered' } });
  ok('11. cross-edit order status as customer -> 403', r.status === 403, 'http=' + r.status);

  // 12. order list is scoped to the JWT identity
  const mine = (await req('GET', '/api/orders', { token: C })).body;
  const foreign = mine.filter(o => o.customerEmail && o.customerEmail !== 'riya.sharma@email.com');
  ok('12. order list scoped to own identity only', foreign.length === 0, 'foreign=' + foreign.length);

  // 13. order detail ownership enforced for logged-in customers
  // use the anonymously-created order: customer=null, customerEmail='' -> provably NOT riya's
  r = await req('GET', '/api/orders/' + enc, { token: C });
  ok('13. fetch another customer order -> 403', r.status === 403, 'http=' + r.status);

  // cleanup
  for (const id of created) {
    if (typeof id === 'string' && id.startsWith('#AS')) await req('DELETE', '/api/orders/' + encodeURIComponent(id), { token: A });
    else await req('DELETE', '/api/customers/' + id, { token: A });
  }
  if (created.length) console.log('cleanup: removed ' + created.length + ' security-suite artefact(s)');

  const pass = results.filter(r => r.pass).length, fail = results.length - pass;
  console.log('\n===== SECURITY: ' + pass + '/' + results.length + ' =====');
  if (fail) console.log('failed:\n' + results.filter(r => !r.pass).map(r => '  - ' + r.name).join('\n'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e.message); process.exit(2); });
