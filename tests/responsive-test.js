/* AromaSpice responsive suite — durable regression (recreated in-repo, Phase D)
 * Reconstructed from the original harness: 2 viewports (360 / 768) x 7 pages = 14 zones,
 * asserting ZERO horizontal overflow. Includes the original harness fix: await
 * document.fonts.ready BEFORE measuring (webfont swap otherwise reports false overflow).
 * JS page errors are collected and reported (expected 0).
 * Run: node tests/responsive-test.js
 */
const { chromium } = require('playwright');

const BASE = process.env.RESP_BASE || 'http://localhost:3000';
const VIEWPORTS = [{ w: 360, h: 800, label: '360px' }, { w: 768, h: 1024, label: '768px' }];
const PAGES = ['/', '/shop', '/product', '/search', '/cart', '/login', '/register'];

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let pass = 0, fail = 0;
  const failures = [];

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    const page = await ctx.newPage();
    const jsErrors = [];
    page.on('pageerror', e => jsErrors.push(e.message));

    for (const p of PAGES) {
      await page.goto(BASE + p, { waitUntil: 'networkidle' });
      // CRITICAL: wait for webfonts, otherwise swap shifts layout and fakes overflow
      await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
      await page.waitForTimeout(250);
      const m = await page.evaluate(() => {
        const de = document.documentElement;
        // find the widest offending element for actionable output
        let worst = null;
        const limit = de.clientWidth;
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.right > limit + 1) {
            if (!worst || r.right > worst.right) {
              worst = { right: Math.round(r.right), tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 40) };
            }
          }
        }
        return { overflow: de.scrollWidth - de.clientWidth, worst };
      });
      const good = m.overflow <= 0;
      if (good) pass++; else { fail++; failures.push(vp.label + ' ' + p + ' overflow=' + m.overflow + 'px' + (m.worst ? ' worst=<' + m.worst.tag + ' class="' + m.worst.cls + '">' : '')); }
      console.log((good ? 'PASS' : 'FAIL') + ' ' + vp.label.padEnd(6) + p.padEnd(10) + ' h-overflow=' + m.overflow + 'px');
    }

    console.log('  [' + vp.label + ' JS errors: ' + jsErrors.length + (jsErrors.length ? ' -> ' + jsErrors.slice(0, 2).join(' | ').slice(0, 160) : '') + ']');
    if (jsErrors.length) fail += jsErrors.length;
    await ctx.close();
  }

  await browser.close();
  console.log('\n===== RESPONSIVE: ' + pass + '/' + (pass + fail === 0 ? pass : pass + fail) + ' zones OK' + (fail ? ' (' + fail + ' failing)' : '') + ' =====');
  if (failures.length) console.log('failures:\n' + failures.map(f => '  - ' + f).join('\n'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e.message); process.exit(2); });
