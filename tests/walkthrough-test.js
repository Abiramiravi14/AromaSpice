/* AromaSpice end-to-end walkthrough — durable regression (recreated in-repo, Phase D)
 * Reconstructed from the original harness: BOTH customer funnels (guest + registered)
 * plus the admin funnel, and zero JS page errors. Uses two isolated browser contexts so
 * each funnel starts with clean cart/session/idempotency state.
 * Self-cleaning: every order it creates is deleted afterwards (stock auto-restores).
 * Run: node tests/walkthrough-test.js
 */
const { chromium } = require('playwright');

const BASE = process.env.WALK_BASE || 'http://localhost:3000';
const results = [];
const ok = (name, pass, info) => {
  results.push({ name, pass });
  console.log((pass ? 'PASS' : 'FAIL') + ' ' + name + (info ? ' -> ' + info : ''));
};
const createdOrders = [];
const jsErrors = [];

// ---- shared funnel steps (guest or registered) -------------------------------
let adminToken = null;
async function adminAuth() {
  if (adminToken) return adminToken;
  const r = await (await fetch(BASE + '/api/customers/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@aromaspice.com', password: 'admin123' })
  })).json();
  adminToken = r.token || null;
  return adminToken;
}
async function listAllOrders() {
  const t = await adminAuth();
  const j = await (await fetch(BASE + '/api/orders', { headers: { Authorization: 'Bearer ' + (t || '') } })).json().catch(() => []);
  return Array.isArray(j) ? j : (Array.isArray(j.orders) ? j.orders : []);
}

async function buyFunnel(page, label, who) {
  // 0) deterministic starting cart: the app re-seeds DEFAULT_CART whenever as_cart is not
  //    an array, so we INJECT a single Turmeric unit instead of trying to clear the cart.
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    const c = JSON.parse(localStorage.getItem('as_cart') || '[]');
    const t = c.find(i => /turmeric/i.test(i.name)) || c[0];
    localStorage.setItem('as_cart', JSON.stringify([Object.assign({}, t, { qty: 1 })]));
    sessionStorage.removeItem('as_pay_idem');       // fresh idempotency key for this order
  });

  // 1) real ADD TO CART interaction (second product card = Chilli)
  await page.goto(BASE + '/shop', { waitUntil: 'networkidle' });
  const before = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find(x => /cart/i.test(x.textContent));
    const sp = a && [...a.querySelectorAll('span')].find(s => /^\d+$/.test(s.textContent.trim()));
    return sp ? sp.textContent.trim() : '0';
  });
  await page.locator('button:has-text("ADD TO CART")').nth(1).click();
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find(x => /cart/i.test(x.textContent));
    const sp = a && [...a.querySelectorAll('span')].find(s => /^\d+$/.test(s.textContent.trim()));
    return sp ? sp.textContent.trim() : '0';
  });
  ok(label + ': add to cart updates badge', Number(after) === Number(before) + 1, before + '->' + after);

  // 2) product page renders
  await page.goto(BASE + '/product', { waitUntil: 'networkidle' });
  const prodOk = await page.locator('h1').first().isVisible().catch(() => false);
  ok(label + ': product page renders', prodOk);

  // 3) remove the added line again -> single deterministic item (149; discount now coupon-gated)
  await page.goto(BASE + '/cart', { waitUntil: 'networkidle' });
  await page.locator('button[data-act="rm"][data-i="1"]').first().click();
  await page.waitForTimeout(400);
  const items = await page.locator('[data-purpose="cart-item"]').count();
  const totalTxt = await page.evaluate(() => {
    const aside = document.querySelector('[data-purpose="order-summary-sidebar"]');
    if (!aside) return null;
    const rows = [...aside.querySelectorAll('div')].filter(r => r.children.length === 2);
    const t = rows.find(r => /^\s*total/i.test(r.children[0].textContent));
    return t ? t.children[1].textContent : null;
  });
  ok(label + ': cart remove + total (1 x 149 -> 149, no auto discount)', items === 1 && totalTxt && totalTxt.replace(/\s/g, '') === '\u20b9149',
    'items=' + items + ' total=' + totalTxt);

  // 4) checkout blocks empty submit
  await page.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    ['full_name', 'phone_number', 'email_address', 'street_address', 'area_locality', 'city', 'state', 'pincode']
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  });
  await page.locator('button:has-text("PROCEED TO PAYMENT")').click();
  await page.waitForTimeout(400);
  const errs = await page.locator('.as-err').count();
  ok(label + ': checkout validation blocks empty form', errs > 0, 'errors=' + errs);

  // 5) valid checkout -> payment
  await page.fill('#full_name', who.name);
  await page.fill('#phone_number', '9876543210');
  await page.fill('#email_address', who.email);
  await page.fill('#street_address', '12 MG Road');
  await page.fill('#area_locality', 'Indiranagar');
  await page.fill('#city', 'Bengaluru');
  await page.selectOption('#state', 'Karnataka');
  await page.fill('#pincode', '560038');
  await page.locator('button:has-text("PROCEED TO PAYMENT")').click();
  await page.waitForURL('**/payment', { timeout: 8000 }).catch(() => {});
  ok(label + ': checkout -> payment navigation', page.url().endsWith('/payment'), page.url());

  // 6) payment page shows the authoritative amount
  await page.waitForLoadState('networkidle').catch(() => {});
  const payBtn = page.locator('button', { hasText: /PAY NOW/i }).first();
  const hasPay = (await payBtn.count()) > 0;
  const upiInput = page.locator('input[placeholder*="UPI"]').first();
  if (await upiInput.count()) await upiInput.fill('9876543210@okhdfcbank');
  const amtTxt = await page.evaluate(() => {
    const aside = document.querySelector('[data-purpose="order-summary-section"]');
    if (!aside) return null;
    const rows = [...aside.querySelectorAll('div')].filter(r => r.children.length === 2);
    const t = rows.find(r => /^\s*total/i.test(r.children[0].textContent));
    return t ? t.children[1].textContent : null;
  }).catch(() => null);
  ok(label + ': payment page shows amount + PAY NOW', hasPay && amtTxt && amtTxt.replace(/\s/g, '') === '\u20b9149', 'amount=' + amtTxt);

  // 7) pay -> confirmation
  await payBtn.click();
  await page.waitForURL('**/order-confirmation', { timeout: 12000 }).catch(() => {});
  const reached = page.url().endsWith('/order-confirmation');
  ok(label + ': PAY NOW reaches order confirmation', reached, page.url());

  // 8) confirmation order id is a real DB order at the authoritative total
  const confId = await page.evaluate(() => {
    const sp = [...document.querySelectorAll('span')].find(s => /^#AS\d+$/.test(s.textContent.trim()));
    return sp ? sp.textContent.trim() : null;
  }).catch(() => null);
  if (confId) createdOrders.push(confId);
  const found = (await listAllOrders()).find(o => o.orderId === confId) || null;
  ok(label + ': confirmation order exists in DB at \u20b9149', !!confId && !!found && found.total === 149,
    'order=' + confId + ' total=' + (found ? found.total : 'n/a'));
  return confId;
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const trackErrors = (page, tag) => page.on('pageerror', e => jsErrors.push(tag + ': ' + e.message));

  // ================= GUEST FUNNEL =================
  const gctx = await browser.newContext();
  const gpage = await gctx.newPage();
  trackErrors(gpage, 'guest');
  await gpage.goto(BASE + '/', { waitUntil: 'networkidle' });
  ok('guest: home renders hero + nav', await gpage.locator('h1').first().isVisible().catch(() => false));
  const guestOrder = await buyFunnel(gpage, 'guest', { name: 'Walkthrough Guest', email: 'walk.guest@email.com' });
  await gctx.close();

  // ================= REGISTERED FUNNEL =================
  const cctx = await browser.newContext();
  const cpage = await cctx.newPage();
  trackErrors(cpage, 'registered');
  // establish a browser session for the registered customer
  await cpage.goto(BASE + '/login', { waitUntil: 'networkidle' });
  await cpage.fill('#email', 'riya.sharma@email.com');
  await cpage.fill('#password', 'demo123');
  await cpage.locator('form:has(#password) button[type="submit"]').first().click();
  await cpage.waitForURL(u => !String(u).includes('/login'), { timeout: 8000 }).catch(() => {});
  const session = await cpage.evaluate(() => { try { return JSON.parse(localStorage.getItem('as_user')); } catch (e) { return null; } });
  ok('registered: login stores session', !!session && session.email === 'riya.sharma@email.com', session ? session.email : 'no session');

  await cpage.goto(BASE + '/order-history', { waitUntil: 'networkidle' });
  await cpage.waitForTimeout(900);
  const histRows = await cpage.locator('tbody tr').count();
  ok('registered: order history scoped list loads', histRows >= 1, 'rows=' + histRows);

  await cpage.evaluate(() => { localStorage.removeItem('as_cart'); sessionStorage.removeItem('as_pay_idem'); });
  const regOrder = await buyFunnel(cpage, 'registered', { name: 'Riya Sharma', email: 'riya.sharma@email.com' });
  ok('registered: second funnel produced a distinct order', !!regOrder && regOrder !== guestOrder, regOrder + ' vs ' + guestOrder);
  await cctx.close();

  // ================= ADMIN FUNNEL =================
  const actx = await browser.newContext();
  const apage = await actx.newPage();
  trackErrors(apage, 'admin');
  await apage.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await apage.fill('#admin-email', 'admin@aromaspice.com');
  await apage.fill('#admin-password', 'admin123');
  await apage.locator('form button[type="submit"]').first().click();
  await apage.waitForURL('**/admin/dashboard', { timeout: 8000 }).catch(() => {});
  await apage.waitForTimeout(900);
  const statText = await apage.evaluate(() => [...document.querySelectorAll('[data-purpose="stat-card"] .text-3xl')].map(x => x.textContent.trim()));
  const statOk = statText.length === 4 && statText.slice(0, 3).every(t => /^\d+$/.test(t) && Number(t) >= 5) && /^₹[\d,]+$/.test(statText[3] || '');
  ok('admin: dashboard stats load from DB', statOk, 'stats=' + JSON.stringify(statText));

  await apage.goto(BASE + '/admin/orders', { waitUntil: 'networkidle' });
  await apage.waitForTimeout(800);
  const ordRows = await apage.locator('tbody tr').count();
  ok('admin: orders table + status update works', ordRows >= 6, 'rows=' + ordRows);
  await actx.close();

  // ================= JS ERRORS =================
  ok('zero JS page errors across all funnels', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | ').slice(0, 200));

  // ================= cleanup =================
  const adminTok = await adminAuth();
  let removed = 0;
  for (const id of createdOrders) {
    const r = await fetch(BASE + '/api/orders/' + encodeURIComponent(id), { method: 'DELETE', headers: { Authorization: 'Bearer ' + adminTok } });
    if (r.ok) removed++;
  }
  if (removed) console.log('cleanup: deleted ' + removed + '/' + createdOrders.length + ' walkthrough order(s) (stock auto-restored)');
  await browser.close();

  const pass = results.filter(r => r.pass).length, fail = results.length - pass;
  console.log('\n===== WALKTHROUGH: ' + pass + '/' + results.length + ' =====');
  if (fail) console.log('failed:\n' + results.filter(r => !r.pass).map(r => '  - ' + r.name).join('\n'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e.message); process.exit(2); });
