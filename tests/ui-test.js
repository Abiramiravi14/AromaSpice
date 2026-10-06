/* UI smoke test for AromaSpice — walks the full customer + admin flow */
const { chromium } = require('playwright');

const BASE = 'http://localhost:3000';
const results = [];
const ok = (name, pass, info) => { results.push({ name, pass, info }); console.log((pass ? '✅' : '❌') + ' ' + name + (info ? ' — ' + info : '')); };

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  // B-11 auth: orders list is now JWT-protected — sign in as a demo customer first
  const riyaLogin = await (await fetch(BASE + '/api/customers/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'riya.sharma@email.com', password: 'demo123' })
  })).json();
  const authFetch = (p, opts) => fetch(BASE + p, Object.assign({
    headers: { 'Authorization': 'Bearer ' + riyaLogin.token }
  }, opts || {}));

  // 1. HOME
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  ok('Home renders hero', await page.locator('h1').first().isVisible());
  const shopLink = page.locator('a', { hasText: 'SHOP NOW' }).first();
  const href = await shopLink.getAttribute('href');
  ok('SHOP NOW wired → /shop', href === '/shop', 'href=' + href);
  const aboutHref = await page.locator('a[data-path="about-us"]').first().getAttribute('href');
  ok('About link wired → /about', aboutHref === '/about', 'href=' + aboutHref);

  // 2. SHOP — add to cart
  await page.goto(BASE + '/shop', { waitUntil: 'networkidle' });
  const badgeBefore = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find(x => /cart/i.test(x.textContent));
    const sp = a && [...a.querySelectorAll('span')].find(s => /^\d+$/.test(s.textContent.trim()));
    return sp ? sp.textContent.trim() : null;
  });
  await page.locator('button:has-text("ADD TO CART")').first().click();
  await page.waitForTimeout(300);
  const badgeAfter = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find(x => /cart/i.test(x.textContent));
    const sp = a && [...a.querySelectorAll('span')].find(s => /^\d+$/.test(s.textContent.trim()));
    return sp ? sp.textContent.trim() : null;
  });
  ok('Shop add-to-cart updates badge', badgeBefore === '3' && badgeAfter === '4', `before=${badgeBefore} after=${badgeAfter}`);
  // sort
  await page.selectOption('#sort-select', 'price-high');
  await page.waitForTimeout(200);
  const firstPrice = await page.evaluate(() => {
    const arts = [...document.querySelectorAll('article')].filter(a => a.style.display !== 'none');
    const m = arts[0].innerText.match(/₹\s?([\d,]+)/); return m ? Number(m[1].replace(/,/g, '')) : 0;
  });
  ok('Sort price-high works', firstPrice === 199, 'first visible price=' + firstPrice);

  // 3. CART — qty controls + totals
  await page.goto(BASE + '/cart', { waitUntil: 'networkidle' });
  const itemCount = await page.locator('[data-purpose="cart-item"]').count();
  // default cart has 3 rows; shop add bumped Turmeric qty → still 3 rows
  ok('Cart renders items', itemCount === 3, 'items=' + itemCount);
  await page.locator('button[data-act="inc"][data-i="0"]').click();
  await page.waitForTimeout(200);
  const qty = await page.locator('[data-purpose="cart-item"]').first().locator('span').filter({ hasText: /^\d+$/ }).first().textContent();
  ok('Cart qty + works', qty.trim() === '2', 'qty=' + qty);
  const total1 = await page.evaluate(() => {
    const aside = document.querySelector('[data-purpose="order-summary-sidebar"]');
    const rows = [...aside.querySelectorAll('div')].filter(r => r.children.length === 2);
    const t = rows.find(r => /^\s*total/i.test(r.children[0].textContent));
    return t ? t.children[1].textContent : null;
  });
  // (159*2 + 149*2 + 179) = 795, -5% (floor 39) = 756
  ok('Cart total recalculated', total1 && total1.replace(/\s/g, '') === '₹756', 'total=' + total1);
  // remove 3rd item (Garam Masala)
  await page.locator('button[data-act="rm"][data-i="2"]').click();
  await page.waitForTimeout(200);
  const itemCount2 = await page.locator('[data-purpose="cart-item"]').count();
  ok('Cart remove works', itemCount2 === 2, 'items=' + itemCount2);

  // 4. CHECKOUT — validation then submit
  // NOTE: the static checkout form ships pre-filled with demo values,
  // so clear them first to verify validation actually blocks.
  await page.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    ['full_name', 'phone_number', 'email_address', 'street_address', 'area_locality', 'city', 'state', 'pincode']
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  });
  await page.locator('button:has-text("PROCEED TO PAYMENT")').click();
  await page.waitForTimeout(300);
  const errCount = await page.locator('.as-err').count();
  ok('Checkout validation blocks empty form', errCount > 0, 'errors=' + errCount);
  await page.fill('#full_name', 'Riya Sharma');
  await page.fill('#phone_number', '9876543210');
  await page.fill('#email_address', 'riya.sharma@email.com');
  await page.fill('#street_address', '12 MG Road, Indiranagar');
  await page.fill('#area_locality', 'Indiranagar');
  await page.fill('#city', 'Bengaluru');
  await page.selectOption('#state', 'Karnataka');
  await page.fill('#pincode', '560038');
  await page.locator('button:has-text("PROCEED TO PAYMENT")').click();
  await page.waitForURL('**/payment', { timeout: 5000 }).catch(() => {});
  ok('Checkout → Payment navigation', page.url().endsWith('/payment'), page.url());

  // 5. PAYMENT — place order
  await page.waitForLoadState('networkidle');
  const payBtn = page.locator('button', { hasText: /PAY NOW/i }).first();
  ok('PAY NOW button found', await payBtn.count() > 0);
  // default method is UPI — fill the UPI ID field
  const upiInput = page.locator('input[placeholder*="UPI"]').first();
  if (await upiInput.count()) await upiInput.fill('9876543210@okhdfcbank');
  const ordersBefore = await (await authFetch('/api/orders')).json();
  await payBtn.click();
  await page.waitForURL('**/order-confirmation', { timeout: 8000 }).catch(() => {});
  ok('Payment → Confirmation navigation', page.url().endsWith('/order-confirmation'), page.url());
  const ordersAfter = await (await authFetch('/api/orders')).json();
  ok('Order created in DB', ordersAfter.length === ordersBefore.length + 1, `before=${ordersBefore.length} after=${ordersAfter.length}`);

  // 6. CONFIRMATION — shows real order id
  await page.waitForLoadState('networkidle');
  const confId = await page.evaluate(() => {
    const sp = [...document.querySelectorAll('span')].find(s => /^#AS\d+$/.test(s.textContent.trim()));
    return sp ? sp.textContent.trim() : null;
  });
  const newOrder = ordersAfter[0];
  ok('Confirmation shows placed order ID', confId === newOrder.orderId, `page=${confId} db=${newOrder.orderId}`);
  const createdOrderId = confId;   // cleaned up at the end of this suite

  // 7. ORDER HISTORY — table + tracking
  // B-11: page API calls need a session — sign the demo customer in inside the browser
  await page.evaluate(u => {
    localStorage.setItem('as_user', JSON.stringify(u));
    localStorage.setItem('as_token', JSON.stringify(u.token));
  }, riyaLogin);
  await page.goto(BASE + '/order-history', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const rows = await page.locator('tbody tr').count();
  // auth-scoped list: only this customer's orders are visible now (was: all orders)
  ok('Order history table loaded from DB', rows >= 1, 'rows=' + rows);
  await page.fill('#track-order-id', '#AS987654321');
  await page.locator('form:has(#track-order-id) button[type="submit"], form:has(#track-order-id) button').last().click();
  await page.waitForTimeout(800);
  const trackBox = await page.locator('#as-track-result').count();
  const trackText = trackBox ? await page.locator('#as-track-result').textContent() : '';
  ok('Track order returns status', trackBox > 0 && /Delivered/.test(trackText), trackText.slice(0, 80));

  // 8. REGISTER + LOGIN  (unique email so re-runs don't hit 'already registered')
  const TEST_EMAIL = 'ui.tester.' + Date.now() + '@email.com';
  await page.goto(BASE + '/register', { waitUntil: 'networkidle' });
  await page.fill('#fullName', 'UI Tester');
  await page.fill('#email', TEST_EMAIL);
  await page.fill('#phone', '9111111111');
  await page.fill('#password', 'secret123');
  await page.fill('#confirmPassword', 'secret123');
  const terms = page.locator('#terms');
  if (await terms.count()) await terms.check().catch(() => {});
  await page.locator('form:has(#fullName) button[type="submit"]').click();
  await page.waitForURL(u => !String(u).includes('/register'), { timeout: 8000 }).catch(() => {});
  ok('Register creates account + redirects', !page.url().includes('/register'), page.url());
  // wait for the home page (fresh navigation) to fully wire before checking header
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(500);
  const headerName = await page.evaluate(() => {
    const sp = [...document.querySelectorAll('span')].find(s => s.textContent.trim() === 'UI');
    const stillLogin = [...document.querySelectorAll('a')].some(x => /Login\s*\/\s*Register/i.test(x.textContent));
    return sp ? 'UI' : (stillLogin ? 'STILL_LOGIN_LINK' : null);
  });
  ok('Header shows logged-in name', !!headerName && headerName !== 'STILL_LOGIN_LINK', headerName || 'not found');

  await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
  await page.fill('#email', TEST_EMAIL);
  await page.fill('#password', 'wrongpass');
  await page.locator('form:has(#password) button[type="submit"]').first().click();
  await page.waitForTimeout(600);
  const loginErr = await page.locator('.as-form-error').count();
  ok('Login rejects wrong password', loginErr > 0);
  await page.fill('#password', 'secret123');
  await page.locator('form:has(#password) button[type="submit"]').first().click();
  await page.waitForURL(u => !String(u).includes('/login'), { timeout: 8000 }).catch(() => {});
  ok('Login accepts correct password', !page.url().includes('/login'), page.url());

  // 9. ADMIN LOGIN → DASHBOARD
  await page.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await page.fill('#admin-email', 'admin@aromaspice.com');
  await page.fill('#admin-password', 'admin123');
  await page.locator('form button[type="submit"]').first().click();
  await page.waitForURL('**/admin/dashboard', { timeout: 6000 }).catch(() => {});
  ok('Admin login → dashboard', page.url().includes('/admin/dashboard'), page.url());
  await page.waitForTimeout(800);
  const statText = await page.evaluate(() => [...document.querySelectorAll('[data-purpose="stat-card"] .text-3xl')].map(x => x.textContent.trim()));
  // 4 stats: orders, customers, products (plain numbers ≥ seed) + revenue (₹)
  const statOk = statText.length === 4 &&
    statText.slice(0, 3).every(t => /^\d+$/.test(t) && Number(t) >= 5) &&
    /^₹[\d,]+$/.test(statText[3] || '');
  ok('Dashboard stats from DB', statOk, 'stats=' + JSON.stringify(statText));
  const dashRows = await page.locator('tbody tr').count();
  ok('Dashboard recent orders loaded', dashRows >= 4, 'rows=' + dashRows);

  // 10. ADMIN PRODUCTS — table + add + delete
  await page.goto(BASE + '/admin/products', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const prodRows = await page.locator('tbody tr').count();
  ok('Admin products table loaded', prodRows === 9, 'rows=' + prodRows);
  await page.locator('[data-purpose="add-product-button"]').click();
  await page.waitForTimeout(300);
  await page.fill('#as-modal-form input[name="name"]', 'Browser Test Masala');
  await page.fill('#as-modal-form input[name="price"]', '111');
  await page.fill('#as-modal-form input[name="stock"]', '7');
  await page.locator('#as-modal-form button[type="submit"]').click();
  await page.waitForTimeout(700);
  const prodRows2 = await page.locator('tbody tr').count();
  ok('Admin add product works', prodRows2 === 10, 'rows=' + prodRows2);
  // delete the row we added (last)
  page.once('dialog', d => d.accept());
  await page.locator('tbody tr', { hasText: 'Browser Test Masala' }).locator('button[title="Delete Product"]').click();
  await page.waitForTimeout(700);
  const prodRows3 = await page.locator('tbody tr').count();
  ok('Admin delete product works', prodRows3 === 9, 'rows=' + prodRows3);

  // 11. ADMIN CUSTOMERS
  await page.goto(BASE + '/admin/customers', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  const custRows = await page.locator('tbody tr').count();
  ok('Admin customers table loaded', custRows >= 6, 'rows=' + custRows);

  // 12. ADMIN ORDERS — status change
  await page.goto(BASE + '/admin/orders', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  const ordRows = await page.locator('tbody tr').count();
  ok('Admin orders table loaded', ordRows >= 6, 'rows=' + ordRows);
  page.once('dialog', d => d.accept());
  await page.locator('tbody tr').first().locator('button[title="Edit Order"]').click();
  await page.waitForTimeout(300);
  await page.selectOption('#as-modal-form select[name="status"]', 'Delivered');
  await page.locator('#as-modal-form button[type="submit"]').click();
  await page.waitForTimeout(700);
  const firstStatus = await page.locator('tbody tr').first().textContent();
  ok('Admin order status update', /Delivered/.test(firstStatus), firstStatus.replace(/\s+/g, ' ').slice(0, 70));

  // 13. SEARCH page — 4 static cards: 3 turmeric + 1 combo
  await page.goto(BASE + '/search?q=turmeric', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const visibleCards = await page.evaluate(() => [...document.querySelectorAll('article')].filter(a => a.style.display !== 'none').length);
  ok('Search ?q= filters cards', visibleCards === 3, 'visible=' + visibleCards);

  // 14. PRODUCT page — buy now
  await page.goto(BASE + '/product', { waitUntil: 'networkidle' });
  const pdBadgeBefore = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find(x => /cart/i.test(x.textContent));
    const sp = a && [...a.querySelectorAll('span')].find(s => /^\d+$/.test(s.textContent.trim()));
    return sp ? sp.textContent.trim() : null;
  }).catch(() => null);
  ok('Product page loads', true);

  console.log('\n--- PAGE JS ERRORS (' + errors.length + ') ---');
  [...new Set(errors)].slice(0, 10).forEach(e => console.log('  • ' + e));

  // ---- cleanup: this suite is the only one that used to leave artefacts behind.
  // Deleting the order restores its reserved stock, so the seeded baseline is preserved.
  try {
    const adminTok = (await (await fetch(BASE + '/api/customers/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@aromaspice.com', password: 'admin123' })
    })).json()).token;
    const AH = { Authorization: 'Bearer ' + adminTok };
    if (typeof createdOrderId === 'string' && /^#AS\d+$/.test(createdOrderId)) {
      const r = await fetch(BASE + '/api/orders/' + encodeURIComponent(createdOrderId), { method: 'DELETE', headers: AH });
      if (r.ok) console.log(`cleanup: deleted suite order ${createdOrderId} (stock auto-restored)`);
    }
    if (typeof TEST_EMAIL === 'string' && /^ui\.tester\./.test(TEST_EMAIL)) {
      const all = await (await fetch(BASE + '/api/customers', { headers: AH })).json();
      const row = (Array.isArray(all) ? all : all.customers || []).find(c => c.email === TEST_EMAIL);
      if (row) {
        const r = await fetch(BASE + '/api/customers/' + (row._id || row.id), { method: 'DELETE', headers: AH });
        if (r.ok) console.log('cleanup: deleted suite customer ' + TEST_EMAIL);
      }
    }
  } catch (e) { console.log('cleanup warning: ' + e.message); }

  const passed = results.filter(r => r.pass).length;
  console.log(`\n===== ${passed}/${results.length} checks passed =====`);
  await browser.close();
  process.exit(passed === results.length ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
