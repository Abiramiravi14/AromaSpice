/* ============================================================
   AromaSpice — Shared Client Runtime
   Injected by server before </body>; original HTML files on disk
   are never modified. Handles routing, cart, auth, checkout flow,
   search, and admin CRUD against the Express + MongoDB API.
   ============================================================ */
(function () {
  'use strict';

  // ---------- helpers ----------
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const path = location.pathname;
  const onAdmin = path.indexOf('/admin') === 0;

  const api = (p, opts) => {
    // B-11: attach JWT when present; localStorage role stays UX-gate only (server enforces auth)
    const headers = Object.assign({ 'Content-Type': 'application/json' }, (opts && opts.headers) || {});
    const token = store.get('as_token', '');
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch('/api' + p, Object.assign({}, opts || {}, { headers }))
      .then(r => r.json().then(j => {
        if (r.status === 401 && !/\/customers\/(login|register)/.test(p)) {
          store.del('as_token');                       // expired/invalid session
          store.del('as_user');                        // no stale identity in the header (Step 7)
          if (onAdmin && !path.startsWith('/admin/login')) location.href = '/admin/login';
          else { toast('Please login to continue'); initializeAuthState(); }   // header flips at once
        }
        return { ok: r.ok, status: r.status, data: j };
      }));
  };

  const fmtINR = n => '₹' + Number(n || 0).toLocaleString('en-IN');
  const fmtDate = d => {
    const dt = new Date(d);
    return isNaN(dt) ? '' : dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + (Date.now() % 100000);

  let toastTimer = null;
  function toast(msg) {
    let t = $('#as-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'as-toast';
      t.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#181d1a;color:#fff;padding:12px 18px;border-radius:10px;font:600 14px/1.4 system-ui,sans-serif;z-index:99999;box-shadow:0 10px 25px rgba(0,0,0,.25);transition:opacity .3s;max-width:320px';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 2600);
  }

  // ---------- storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
    del(k) { localStorage.removeItem(k); }
  };

  // Default cart matches the designed static screens (3 items, ₹487 / -₹24 / ₹463)
  // Cart is AUTH-SCOPED (Phase K): each customer's cart lives under their own
  // storage key `as_cart:<id>` — Customer A ≠ Customer B. Logout never deletes
  // it (re-login restores, §13). Guests have NO active cart: header forces
  // ₹0.00 + no badge, /cart is load-gated, add-to-cart requires login, and a
  // NEW registration initialises their key to [] (never inherits stale/legacy
  // browser data, §4/§7). Legacy key 'as_cart' is only read for guests — kept
  // for the existing guest-checkout payment harness (§17: payment untouched).
  function cartKey(u) { return 'as_cart:' + ((u && (u.id || u._id || u.email)) || 'anon'); }
  function getCart() {
    const u = validUser();
    const c = store.get(u ? cartKey(u) : 'as_cart', null);
    return Array.isArray(c) ? c : [];   // authed: ONLY their cart; no demo seeding
  }
  function setCart(c) {
    const u = validUser();
    store.set(u ? cartKey(u) : 'as_cart', c);
    updateBadges();
  }
  // COUPON-GATED discount: no automatic % — a discount exists only when a
  // VALID code from VALID_COUPONS has been applied (stored as as_coupon).
  // Keep in sync with VALID_COUPONS in server.js (the server re-validates).
  const VALID_COUPONS = { SAVESPICE: 0.05 };            // code → rate
  function activeCoupon() {
    const c = store.get('as_coupon', null);
    return c && c.code && VALID_COUPONS[c.code] ? c : null;
  }
  function cartTotals(cartOverride) {
    const c = Array.isArray(cartOverride) ? cartOverride : getCart();
    const subtotal = c.reduce((s, i) => s + i.price * i.qty, 0);
    const cp = activeCoupon();
    const discount = cp && subtotal ? Math.floor(subtotal * VALID_COUPONS[cp.code]) : 0;
    const shipping = 0; // FREE shipping per design
    return { subtotal, discount, shipping, total: subtotal - discount + shipping };
  }
  function addToCart(item) {
    const c = getCart();
    const key = item.name + '|' + item.weight;
    const found = c.find(i => (i.name + '|' + i.weight) === key);
    if (found) found.qty += item.qty || 1;
    else c.push({ id: slug(item.name), name: item.name, category: item.category || '', weight: item.weight || '200g', price: Number(item.price) || 0, qty: item.qty || 1, img: item.img || '' });
    setCart(c);
  }
  function updateBadges() {
    // Header reflects ONLY the authenticated customer's cart (§9/§10).
    // Guests always display ₹0.00 + NO badge — regardless of any legacy
    // guest-cart storage (header must never show another session's items).
    // Same calculation: cartTotals().subtotal; badge = Σ qty; empty ⇒ hidden.
    const u = validUser();
    const cart = u ? getCart() : [];
    const n = cart.reduce((s, i) => s + i.qty, 0);
    const subtotal = cartTotals(cart).subtotal;
    $$('a[data-path="shopping-cart"]').forEach(a => {
      $$('span', a).forEach(sp => {
        const t = sp.textContent.trim();
        if (/^₹/.test(t)) sp.textContent = n > 0 ? fmtINR(subtotal) : '₹0.00';
        else if (/^\d+$/.test(t)) {
          sp.textContent = String(n);
          sp.style.display = n > 0 ? '' : 'none';   // empty cart ⇒ badge removed entirely
        }
      });
    });
  }

  // ---------- product catalog + wishlist (targeted fix) ----------
  // Catalog: one cached fetch of the existing /api/products API. Used to map
  // card titles → real product ids (no hardcoded product data anywhere).
  let __catalog = null;
  function getCatalog() {
    if (__catalog) return Promise.resolve(__catalog);
    return fetch('/api/products').then(r => (r.ok ? r.json() : [])).then(list => {
      __catalog = Array.isArray(list) ? list : [];
      return __catalog;
    }).catch(() => []);
  }
  function _normName(s) {
    return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*\(.*\)$/, '');
  }
  function findProductByName(list, name) {
    const k = _normName(name);
    return list.find(p => _normName(p.name) === k) || null;
  }
  function resolveProductId(name) {
    return getCatalog().then(list => {
      const p = findProductByName(list, name);
      return p ? p._id : null;
    });
  }
  // Wishlist: the EXISTING as_wishlist storage system, upgraded from a shared
  // numeric counter to a per-user array of product ids (same auth-scoping
  // pattern as the cart). Guests have no wishlist state; old numeric key ignored.
  function wishlistKey(u) { return 'as_wishlist:' + ((u && (u.id || u._id || u.email)) || 'anon'); }
  function getWishlist() {
    const u = validUser();
    if (!u) return [];
    const v = store.get(wishlistKey(u), null);
    return Array.isArray(v) ? v : [];
  }
  function inWishlist(id) { return getWishlist().indexOf(id) !== -1; }
  function setWishlist(arr) { const u = validUser(); if (u) store.set(wishlistKey(u), arr); }
  function paintHeart(btn, active) {
    const ic = $('span.material-symbols-outlined', btn);
    if (ic) {
      ic.textContent = active ? 'favorite' : 'favorite_border';
      // Material Symbols FILL axis: without this the font renders FILL 0 → an
      // active heart is a thin *outline* (indistinguishable at a glance).
      // FILL 1 = solid glyph — same trick the rating stars already use.
      ic.style.fontVariationSettings = active ? "'FILL' 1" : "'FILL' 0";
    }
    btn.style.color = active ? '#a33b3c' : '';
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  function updateWishlistHearts() {
    const list = isAuthed() ? getWishlist() : [];
    $$('[data-pd-heart]').forEach(b => paintHeart(b, list.indexOf(b.getAttribute('data-pd-heart')) !== -1));
    // header wishlist badge (count of favourited products; hidden when 0)
    const wa = $('a[data-path="wishlist"]');
    if (wa) {
      const badge = $$('span', wa).find(sp => /^\d+$/.test(sp.textContent.trim()));
      if (badge) {
        badge.textContent = String(list.length);
        badge.style.display = list.length > 0 ? '' : 'none';
      }
    }
  }
  function toggleWishlist(id, name, btn) {
    if (!isAuthed()) {                                // guest → existing auth flow, NOTHING persisted
      requireCustomerAuth(location.pathname + location.search);
      return false;
    }
    const list = getWishlist();
    const i = list.indexOf(id);
    if (i === -1) list.push(id); else list.splice(i, 1);
    setWishlist(list);
    updateWishlistHearts();                            // repaint badge + every heart surface from the store
    if ($('[data-purpose="wishlist-grid"]')) initWishlist();   // on /wishlist: list updates in place (no reload)
    toast((name || 'Product') + (i === -1 ? ' added to wishlist' : ' removed from wishlist'));
    return true;
  }

  // ---------- session ----------
  const getUser = () => store.get('as_user', null);
  const getAdmin = () => store.get('as_admin', null);

  // ============================================================
  // AUTH GATE — one reusable gate for all customer entry points
  // (navigation-level protection; server JWT middleware remains
  //  the real security boundary — nothing server-side is weakened)
  // ============================================================
  const PROTECTED_PATHS = ['/shop', '/product', '/cart', '/checkout', '/order-history', '/profile', '/wishlist'];
  // Load-time gate only for pages whose DATA needs a session. /shop, /cart,
  // /checkout, /product stay guest-reachable on direct URL entry because guest
  // browsing + guest checkout are part of the tested payment architecture —
  // their NAVIGATION entry points (links, CTAs, cards, buttons) are all gated.
  const LOAD_GATED_PATHS = ['/order-history', '/profile', '/cart', '/wishlist'];   // §16: /cart requires auth (returns here after login/register)
  const isAuthed = () => !!validUser();   // expired/invalid JWT never counts as logged in

  // Only same-origin absolute paths allowed; never /register or /login
  // (prevents redirect loops after auth) and never admin paths (Step 7).
  function safeRedirect(raw) {
    if (!raw || typeof raw !== 'string') return null;
    if (raw.charAt(0) !== '/' || raw.charAt(1) === '/') return null;
    const p = raw.split('#')[0].split('?')[0];
    if (p === '/register' || p === '/login' || p.indexOf('/admin') === 0) return null;
    return raw;
  }

  // Reusable gate (Step 5): authed → destination; else remember destination
  // and send the user to /register?redirect=<destination> (Steps 6-7).
  function requireCustomerAuth(destination) {
    const dest = safeRedirect(destination) || '/shop';
    if (isAuthed()) { location.href = dest; return true; }
    location.href = '/register?redirect=' + encodeURIComponent(dest);
    return false;
  }

  // Document-level capture listener: intercepts clicks on any link that
  // resolves to a protected path — covers data-path CTAs (SHOP NOW, SHOP,
  // combo packs), nav links, cart "Proceed to Checkout", profile links, etc.
  function wireAuthGate() {
    document.addEventListener('click', e => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
      const href = a.getAttribute('href') || '';
      if (!href || href.charAt(0) === '#' || /^(mailto|tel|javascript):/i.test(href)) return;
      let dest;
      try {
        const u = new URL(href, location.origin);
        if (u.origin !== location.origin) return;
        dest = u.pathname + u.search;
      } catch (_) { return; }
      if (PROTECTED_PATHS.indexOf(dest.split('?')[0]) === -1) return;
      if (isAuthed()) return;
      e.preventDefault();
      e.stopPropagation();
      requireCustomerAuth(dest);
    }, true);
  }

  // ============================================================
  // 1. ROUTING — wire data-path + text links (never touches files)
  // ============================================================
  const PATH_MAP = {
    home: '/', shop: '/shop', 'combo-packs': '/shop?category=Combo%20Pack',
    'about-us': '/about', 'contact-us': '/contact', profile: '/profile',
    'shopping-cart': '/cart', 'track-order': '/order-history',
    wishlist: '/wishlist', product: '/product'
  };
  const NAV_MAP = [
    [/^home$/i, '/'], [/^shop/i, '/shop'], [/^combo packs/i, '/shop?category=Combo%20Pack'],
    [/^about us$/i, '/about'], [/^track order/i, '/order-history'], [/^contact us$/i, '/contact'],
    [/^login\s*\/\s*register$|^login$|^sign ?in$/i, '/login'],
    [/^register$|^sign ?up$/i, '/register'],
    [/^cart$/i, '/cart'], [/^continue shopping$/i, '/shop'],
    [/^proceed to checkout$/i, '/checkout'], [/^view cart$/i, '/cart'],
    [/^all (spices|products)/i, '/shop'], [/^festive gift boxes/i, '/shop?category=Combo%20Pack'],
    [/^single masalas$|^blended masalas$|^combo value packs$/i, '/shop'],
    [/^our farming heritage/i, '/about'], [/^track order$/i, '/order-history']
  ];
  // Footer "Quick Links" fallback — transplanted pages ship bare href="#" links
  // (no data-path) that NAV_MAP above doesn't cover. Only inside <footer>.
  const FOOTER_MAP = [
    // support & commercial enquiries → dedicated Contact page
    [/^(faq|frequently|contact support|help|wholesale)/i, '/contact'],
    // dedicated policy pages (own routes, not About)
    [/^privacy/i, '/privacy'],
    [/^terms/i, '/terms'],
    [/^(return|refund)/i, '/returns'],
    // remaining company info → About page
    [/^(shipping|security|quality|about narus)/i, '/about'],
    // order tracking
    [/^track (your )?order/i, '/order-history'],
    // category quick links → matching live shop category
    [/combo/i, '/shop?category=Combo%20Pack'],
    [/special/i, '/shop?category=Special%20Masala'],
    [/single|origin/i, '/shop?category=Single%20Masala'],
    [/blend/i, '/shop?category=Blended%20Masala'],
    [/pepper|powder/i, '/shop?category=Pepper%20%26%20Powders'],
    // generic shop links
    [/^(all |all$|products|pure |exclusive |gift |shop$)/i, '/shop']
  ];
  const ADMIN_MAP = [
    [/^dashboard$/i, '/admin/dashboard'], [/^products$/i, '/admin/products'],
    [/^orders$/i, '/admin/orders'], [/^customers$/i, '/admin/customers'],
    [/^reports?$/i, '/admin/reports'], [/^settings?$/i, '/admin/settings'],
    [/^log ?out$|^sign ?out$/i, '__admin_logout']
  ];
  const PROFILE_MAP = [
    [/^my profile$/i, '/profile'], [/^addresses$/i, '/profile'],
    [/^order history$/i, '/order-history'], [/^track orders$/i, '/order-history'],
    [/^wishlist$/i, '/wishlist'], [/^change password$/i, '/profile'],
    [/^log ?out$/i, '__logout']
  ];

  function wireRouting() {
    $$('[data-path]').forEach(a => { a.href = PATH_MAP[a.dataset.path] || '/'; });

    $$('a[href="#"], a:not([href])').forEach(a => {
      const txt = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt) return;
      // admin sidebar
      // all 4 admin sidebar variants (dashboard/products/orders/customers pages
      // each ship their own container ids) + the 2 new pages reuse the dashboard one
      if (a.closest('[data-purpose="admin-sidebar"], [data-purpose="admin-navigation-sidebar"], nav[aria-label="Admin Navigation"], nav[aria-label="Sidebar Navigation"]')) {
        const hit = ADMIN_MAP.find(([re]) => re.test(txt));
        if (hit) {
          if (hit[1] === '__admin_logout') a.addEventListener('click', e => { e.preventDefault(); store.del('as_admin'); store.del('as_token'); location.href = '/admin/login'; });
          else a.href = hit[1];
        }
        return;
      }
      // profile sidebar
      if (a.closest('[data-purpose="account-sidebar-navigation"]')) {
        const hit = PROFILE_MAP.find(([re]) => re.test(txt));
        if (hit) {
          if (hit[1] === '__logout') a.addEventListener('click', e => { e.preventDefault(); store.del('as_user'); store.del('as_token'); toast('Logged out'); location.href = '/login'; });
          else a.href = hit[1];
        }
        return;
      }
      // logo / brand
      if (/^aromaspice/i.test(txt)) { a.href = onAdmin ? '/admin/dashboard' : '/'; return; }
      if (/^admin portal$/i.test(txt)) { a.href = '/admin/dashboard'; return; }
      const hit = NAV_MAP.find(([re]) => re.test(txt));
      if (hit) a.href = hit[1];
      // footer quick links: NAV_MAP miss → text→route fallback (footer only)
      else if (a.closest('footer')) { const fh = FOOTER_MAP.find(([re]) => re.test(txt)); if (fh) a.href = fh[1]; }
    });
  }

  // ---------- header search forms (all screens) ----------
  function wireSearchForms() {
    const goto = q => {
      location.href = '/search' + (q ? '?q=' + encodeURIComponent(q) : '');
    };
    let closeSuggest = () => {};                       // reassigned per search input (typeahead panel)
    let applyShopText = () => {};                      // reassigned per search input (in-page grid filter)
    $$('form').forEach(f => {
      const inp = $('input[type="text"][placeholder*="Search for spices"]', f);
      if (!inp) return;
      f.addEventListener('submit', e => {
        e.preventDefault();
        goto(inp.value.trim());
      });
    });
    // Most customer pages wrap the header search in a plain <div>, not a
    // <form> — bind those directly (Enter key + the "Search" button).
    $$('input[placeholder*="Search for spices"]').forEach(inp => {
      if (inp.closest('form')) return;                 // handled above
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); closeSuggest(); goto(inp.value.trim()); }
        if (e.key === 'Escape') closeSuggest();
      });
      const btn = inp.parentElement &&
        $$('button', inp.parentElement).find(b => b.textContent.trim() === 'Search');
      if (btn && !btn.dataset.searchWired) {
        btn.dataset.searchWired = '1';
        btn.addEventListener('click', () => { closeSuggest(); goto(inp.value.trim()); });
      }
      if (inp.dataset.searchSuggest === '1') return;  // wired once
      inp.dataset.searchSuggest = '1';

      // ---- LIVE TYPEAHEAD: matching products appear AS YOU TYPE (even a
      // single character) — name/category/price/image from the real catalog,
      // case-insensitive. Click a row → that product's details page;
      // Enter/Search → full results page (unchanged).
      const box = inp.parentElement;
      if (box && getComputedStyle(box).position === 'static') box.style.position = 'relative';
      if (!document.getElementById('as-suggest-style')) {
        const st = document.createElement('style');
        st.id = 'as-suggest-style';
        st.textContent =
          '[data-purpose="search-suggest"] .sg-row{display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;border:0;border-bottom:1px solid #f3f1ea;background:#fff;text-align:left;cursor:pointer;font:inherit}' +
          '[data-purpose="search-suggest"] .sg-row:hover,[data-purpose="search-suggest"] .sg-row:focus{background:#faf8f3;outline:none}' +
          '[data-purpose="search-suggest"] .sg-all{display:block;width:100%;padding:10px 12px;border:0;border-top:1px solid #eee9df;background:#faf8f3;color:#781616;font:600 12.5px/1.3 inherit;cursor:pointer;text-align:left}' +
          '[data-purpose="search-suggest"] .sg-all:hover{background:#f3efe6}';
        document.head.appendChild(st);
      }
      const panel = document.createElement('div');
      panel.setAttribute('data-purpose', 'search-suggest');
      panel.style.cssText = 'position:absolute;top:calc(100% + 6px);left:0;right:0;background:#fff;border:1px solid #e6e2d8;border-radius:12px;box-shadow:0 14px 34px rgba(0,0,0,.14);z-index:80;max-height:min(420px,70vh);overflow:auto;display:none';
      if (box) box.appendChild(panel);
      closeSuggest = () => { panel.style.display = 'none'; };

      const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
      let sTimer = null;
      inp.addEventListener('input', () => {
        clearTimeout(sTimer);
        const q = inp.value.trim();
        if (!q) { closeSuggest(); return; }
        sTimer = setTimeout(() => {
          getCatalog().then(list => {
            if (inp.value.trim() !== q) return;                 // stale keystroke
            const nq = norm(q);
            const m = list.filter(p =>
              norm(p.name + ' ' + p.category + ' ' + (p.description || '')).indexOf(nq) !== -1);
            panel.innerHTML = m.length
              ? m.slice(0, 10).map(p =>
                  '<button type="button" class="sg-row" data-id="' + p._id + '">' +
                  '<img alt="" src="' + escapeHtml(p.image || '') + '" style="width:38px;height:38px;object-fit:contain;border-radius:8px;background:#faf8f3;flex:0 0 auto"/>' +
                  '<span style="min-width:0;flex:1">' +
                    '<span style="display:block;font-size:13.5px;font-weight:600;color:#1f2937;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(p.name) + '</span>' +
                    '<span style="display:block;font-size:11px;color:#8a8f98;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(p.category || '') + (p.weight ? ' · ' + escapeHtml(p.weight) : '') + '</span>' +
                  '</span>' +
                  '<span style="font-size:13.5px;font-weight:700;color:#a33b3c;white-space:nowrap">' + fmtINR(p.price) + '</span>' +
                  '</button>').join('') +
                '<button type="button" class="sg-all">See all ' + m.length + ' result' + (m.length === 1 ? '' : 's') + ' for “' + escapeHtml(q) + '” →</button>'
              : '<div style="padding:14px 12px;font-size:13.5px;color:#6b7280">No products match “' + escapeHtml(q) + '”</div>';
            panel.style.display = 'block';
            $$('.sg-row', panel).forEach(r => r.addEventListener('click', () => {
              closeSuggest();
              location.href = '/product?id=' + r.getAttribute('data-id');
            }));
            const all = $('.sg-all', panel);
            if (all) all.addEventListener('click', () => { closeSuggest(); goto(q); });
          });
        }, 150);
      });
      panel.addEventListener('mousedown', e => e.preventDefault());   // keep input focused (no blur-close race)
      inp.addEventListener('blur', () => setTimeout(closeSuggest, 200));

      // ---- IN-PAGE GRID FILTER: typing narrows the SHOP PAGE's own product
      // grid live (every keystroke, even 1 char) — name + category, case-
      // insensitive. Sidebar category/price visibility is PRESERVED for
      // matching cards (we only ever hide non-matches, tracked in a set so
      // clearing the query restores exactly what we hid — nothing else).
      const textHidden = new Set();
      applyShopText = () => {
        const grid = $$('.grid').find(g => $$('article', g).length >= 3);
        if (!grid) return;                              // product grid exists only on /shop
        textHidden.forEach(a => { a.style.display = ''; });
        textHidden.clear();
        const q = norm(inp.value);
        const arts = $$('article', grid);
        let note = document.getElementById('shop-search-note');
        if (!q) { if (note) note.style.display = 'none'; return; }
        let n = 0;
        arts.forEach(a => {
          const hay = norm((($('h2, h3', a) || {}).textContent || '') + ' ' +
                           (($('span.uppercase', a) || {}).textContent || ''));
          if (hay.indexOf(q) !== -1) { n++; return; }   // match → keep sidebar visibility as-is
          a.style.display = 'none';
          textHidden.add(a);
        });
        if (!note) {
          note = document.createElement('p');
          note.id = 'shop-search-note';
          note.style.cssText = 'text-align:center;color:#6b7280;font:600 14px/1.4 inherit;padding:28px 0;display:none';
          grid.parentNode.insertBefore(note, grid.nextSibling);
        }
        note.textContent = n ? '' : 'No products match “' + inp.value.trim() + '”';
        note.style.display = n ? 'none' : 'block';
      };
      inp.addEventListener('input', applyShopText);     // instant, no debounce
    });

    // Sidebar category / price / chips / sort re-set display directly —
    // re-run the text filter after ANY of them so both filters combine.
    const reapplyText = () => requestAnimationFrame(() => applyShopText());
    document.addEventListener('click', reapplyText);
    document.addEventListener('change', reapplyText);
  }

  // ---------- header auth state — ONE reusable initializer ----------
  // Runs on every page load from boot(); renders the two-state account
  // control (STATE A: Account/Login → /login; STATE B: avatar + user name
  // → account dropdown). Uses only the existing JWT/session storage.
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function decodeJwtPayload(tok) {
    try {
      const b64 = String(tok).split('.')[1] || '';
      const b = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
      const json = decodeURIComponent(b.split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
      return JSON.parse(json);
    } catch (e) { return null; }
  }
  function clearSession() { store.del('as_token'); store.del('as_user'); }
  // Step 7: expired or malformed JWT ⇒ treated as logged out (no stale identity).
  function validUser() {
    const tok = store.get('as_token', '');
    const u = getUser();
    if (!tok || !u) return null;
    const p = decodeJwtPayload(tok);
    if (!p || (typeof p.exp === 'number' && p.exp * 1000 <= Date.now())) { clearSession(); return null; }
    return u;
  }
  // ---------- delivery location (real GPS — never a default/test address) ----------
  function gpsKey(u) { return 'as_location:' + ((u && (u.id || u.email)) || 'guest'); }
  function getGps() { return store.get(gpsKey(validUser()), null); }
  const coord = (v, dp) => Number(v).toFixed(dp);
  function deliverLabelText() {
    const u = validUser();
    if (!u) return 'Deliver: Set location';
    const a = store.get('as_address', null);
    const g = getGps();
    const addrOk = !!(a && a.uid === u.id && /^\d{6}$/.test(a.pincode || ''));
    // Show a real AREA NAME, never the raw pincode/coordinates (user request):
    // area → city → state → pincode (pincode only as the last resort).
    const place = addrOk
      ? ([String(a.area || '').trim(), String(a.city || '').trim()].filter(Boolean).join(', ')
         || String(a.state || '').trim() || String(a.pincode || '').trim())
      : '';
    const aTxt = place ? 'Deliver: ' + place : null;
    const gTxt = g ? 'Deliver: Current location' : null;   // raw coords never shown in the header
    // Saved address (area name) always wins; GPS is only the fallback signal.
    return aTxt || gTxt || 'Deliver: Set location';
  }
  function syncDeliverLabel() {
    const txt = deliverLabelText();
    $$('header button').forEach(b => {
      const lbl = $$('span', b).find(s => (s.textContent || '').indexOf('Deliver') !== -1 && !s.classList.contains('material-symbols-outlined'));
      if (lbl) lbl.textContent = txt;
    });
  }
  function renderGpsStatus() {
    const box = $('[data-purpose="gps-status"]');
    if (!box) return;
    const g = getGps();
    if (!g) return;
    box.hidden = false;
    box.style.color = '#15522E';
    box.textContent = 'Location captured: ' + coord(g.lat, 6) + ', ' + coord(g.lon, 6) +
      (g.acc ? ' (accuracy ±' + g.acc + ' m)' : '') + ' · ' +
      new Date(g.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  }
  function captureGps() {
    if (!navigator.geolocation) return toast('GPS is not available in this browser');
    toast('Getting your location… make sure GPS is on');
    navigator.geolocation.getCurrentPosition(pos => {
      const g = { lat: +coord(pos.coords.latitude, 6), lon: +coord(pos.coords.longitude, 6), acc: Math.round(pos.coords.accuracy || 0), at: Date.now() };
      store.set(gpsKey(validUser()), g);        // per-user scoped (guest → as_location:guest)
      syncDeliverLabel();
      renderGpsStatus();
      toast('Location captured');
    }, err => {
      const msg = err && err.code === 1 ? 'Location permission denied — allow GPS or type the address instead'
        : err && err.code === 3 ? 'Location request timed out — please try again'
        : 'Could not get your location — check that GPS is switched on';
      const box = $('[data-purpose="gps-status"]');
      if (box) { box.hidden = false; box.style.color = '#b91c1c'; box.textContent = msg; }
      toast(msg);
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
  }
  // Existing routes only (mirrors PATH_MAP / PROFILE_MAP destinations — no fake items).
  const ACCOUNT_MENU = [
    ['My Profile', '/profile', 'account_circle'],
    ['Order History', '/order-history', 'receipt_long'],
    ['Track Orders', '/order-history', 'local_shipping'],
    ['Wishlist', '/shop', 'favorite'],
    ['Saved Addresses', '/profile', 'location_on'],
    ['Change Password', '/profile', 'key']
  ];
  function accountMenuHtml(u) {
    let h = '<div class="hidden absolute top-full right-0 mt-2 w-[240px] max-w-[calc(100vw-2rem)] bg-surface-container-lowest border border-outline-variant rounded-[0.5rem] shadow-[0_8px_24px_rgba(24,29,26,0.14)] py-1.5 z-[60]" data-purpose="header-account-menu">' +
      '<div class="px-4 py-2.5 border-b border-outline-variant">' +
      '<div class="text-[14px] font-bold text-on-surface truncate">' + escapeHtml(u.fullName || 'Customer') + '</div>' +
      '<div class="text-[12px] text-on-surface-variant truncate">' + escapeHtml(u.email || '') + '</div></div>';
    ACCOUNT_MENU.forEach(it => {
      h += '<a href="' + it[1] + '" class="flex items-center gap-3 px-4 py-2.5 text-[14px] text-on-surface hover:bg-surface-container-low transition-colors">' +
        '<span class="material-symbols-outlined text-[18px] text-primary-container">' + it[2] + '</span>' + it[0] + '</a>';
    });
    h += '<div class="border-t border-outline-variant mt-1 pt-1">' +
      '<a href="#" class="flex items-center gap-3 px-4 py-2.5 text-[14px] font-semibold text-secondary hover:bg-surface-container-low transition-colors" data-purpose="header-logout">' +
      '<span class="material-symbols-outlined text-[18px]">logout</span>Logout</a></div>';
    return h;
  }

  function initializeAuthState() {
    if (onAdmin) return;
    const u = validUser();                     // expired/invalid ⇒ null (logged out)
    // (0) auth-only header controls — guests never see delivery/location or the
    //     favourite/heart. Visibility only: address data & wishlist logic untouched.
    //     Deliver label = the user's OWN location (saved PIN / GPS / prompt) —
    //     never the old static demo pincode. Click → capture real GPS.
    $$('header button').forEach(b => {
      if ((b.textContent || '').indexOf('Deliver') === -1) return;
      b.style.display = u ? '' : 'none';
      if (!b.dataset.gpsWired) { b.dataset.gpsWired = '1'; b.addEventListener('click', () => captureGps()); }
    });
    syncDeliverLabel();
    const heart = $('header a[data-path="wishlist"]');
    if (heart) heart.style.display = u ? '' : 'none';
    // Cart box (shopping_bag / Cart / ₹0.00) — official account control:
    // visible ONLY after login, on every page for every user (guests never see it).
    $$('header a[data-path="shopping-cart"]').forEach(a => { a.style.display = u ? '' : 'none'; });
    // (1) login/register cross-links — same behavior as before, every page
    $$('a').forEach(a => {
      const txt = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/login|register|sign\s?in/i.test(txt)) return;
      if (txt.length > 40) return;
      if (!u) { a.href = /register|sign\s?up/i.test(txt) ? '/register' : '/login'; return; }
      a.href = '/profile';
      const sp = $$('span', a).find(s => /^\s*(login|register|sign\s?in)/i.test(s.textContent.trim()) && !s.children.length);
      if (sp) sp.textContent = (u.fullName || '').split(' ')[0];
    });
    // (2) account control — built once around the avatar (right end of header);
    //     re-renders replace the nodes so listeners never stack.
    let wrap = $('[data-purpose="header-account"]');
    let img;
    if (wrap) {
      img = wrap.querySelector('img');
    } else {
      const anchor = $('a[data-path="profile"]');
      img = $('img[alt="Profile"]');
      if (!anchor || !img) return;             // register/login/payment have their own headers
      wrap = document.createElement('div');
      wrap.className = 'relative';
      wrap.setAttribute('data-purpose', 'header-account');
      img.parentNode.insertBefore(wrap, img);  // control takes the avatar's spot (header right end)
      anchor.remove();                         // old dead person-icon link (Problem A) — replaced
    }
    if (!img) return;
    // The site's Tailwind config redefines borderRadius.full → 0.75rem (12px),
    // so the avatar's `rounded-full` class renders as a rounded SQUARE.
    // Force a true circle inline (targeted; no config/body restyle).
    img.style.borderRadius = '50%';
    const oldTrigger = wrap.querySelector('[data-purpose="header-account-trigger"]');
    if (oldTrigger) oldTrigger.remove();
    const oldMenu = wrap.querySelector('[data-purpose="header-account-menu"]');
    if (oldMenu) oldMenu.remove();
    const trigger = document.createElement('a');
    trigger.setAttribute('data-purpose', 'header-account-trigger');
    trigger.href = u ? '#' : '/login';         // STATE A → Login ; STATE B → dropdown toggle
    if (u) {
      // STATE B: clean circular avatar (+ supported name). No box/background,
      // no "Account/Login" text — avatar is w-9 h-9 rounded-full (36px circle).
      trigger.className = 'flex items-center gap-space-sm rounded-full transition-colors';
      img.style.display = '';
      trigger.appendChild(img);                 // reuse the existing avatar element (cached src)
      trigger.insertAdjacentHTML('beforeend',
        '<span class="hidden lg:flex flex-col text-left leading-none">' +
        '<span class="text-[13px] text-on-surface-variant">Hi,</span>' +
        '<span class="text-[14px] font-bold text-on-surface mt-1">' + escapeHtml((u.fullName || '').split(' ')[0]) + '</span>' +
        '</span>');
    } else {
      // STATE A: Account / Login only — avatar hidden (kept in DOM for the
      // next state flip so login-without-reload can reuse it).
      trigger.className = 'flex items-center gap-space-xs py-space-xs px-space-sm text-on-surface-variant hover:text-on-surface transition-colors';
      img.style.display = 'none';
      wrap.appendChild(img);
      trigger.insertAdjacentHTML('beforeend',
        '<span class="material-symbols-outlined text-[22px]">person</span>' +
        '<span class="hidden lg:flex flex-col text-left">' +
        '<span class="font-label-sm text-label-sm leading-none">Account</span>' +
        '<span class="font-label-md text-label-md font-bold leading-none mt-space-xs">Login</span>' +
        '</span>');
    }
    wrap.appendChild(trigger);
    syncHeaderOffset();                          // header height changes when controls appear/disappear (mobile wrap)
    if (!u) return;                            // STATE A done — no menu
    // STATE B — account dropdown
    wrap.insertAdjacentHTML('beforeend', accountMenuHtml(u));
    const menu = wrap.querySelector('[data-purpose="header-account-menu"]');
    trigger.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      menu.classList.toggle('hidden');         // open/close on click; no layout shift (absolute)
    });
    const outside = e => {
      if (menu.classList.contains('hidden')) return;
      if (!wrap.contains(e.target)) menu.classList.add('hidden');
    };
    const onEsc = e => { if (e.key === 'Escape') menu.classList.add('hidden'); };
    document.addEventListener('click', outside);
    document.addEventListener('keydown', onEsc);
    menu.querySelector('[data-purpose="header-logout"]').addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      document.removeEventListener('click', outside);   // Step 5: close dropdown…
      document.removeEventListener('keydown', onEsc);
      clearSession();                                  // …clear JWT + auth state…
      toast('Logged out');
      initializeAuthState();                           // …header back to Account/Login at once (no reload)
      updateBadges();                                  // …cart display drops to ₹0.00 / no badge (§12)
    });
  }

  // ---------- product cards → /product + add-to-cart wiring ----------
  function wireProductCards() {
    $$('article').forEach(art => {
      if (art.dataset.wired) return;
      art.dataset.wired = '1';
      const title = $('h2, h3', art);
      const go = e => {
        if (e.target.closest('button')) return;
        // Open THIS card's product: resolve its real catalog id, then route with it
        const name = title ? title.textContent.trim() : '';
        resolveProductId(name).then(id => {
          requireCustomerAuth(id ? '/product?id=' + id : '/product');   // unknown name → not-found state (never another product)
        });
      };
      art.addEventListener('click', go);
      if (title) title.style.cursor = 'pointer';

      const btn = $$('button', art).find(b => /add to cart/i.test(b.textContent));
      if (btn) btn.addEventListener('click', e => {
        e.stopPropagation();
        if (!isAuthed()) {                             // §3: no persistent cart for guests —
          requireCustomerAuth(location.pathname + location.search);   // existing gate (/register?redirect=…)
          return;
        }
        addToCart(parseCard(art));
        toast(parseCard(art).name + ' added to cart');
      });
      // wishlist heart — real per-product state (user-scoped; guest → auth flow)
      const heart = $('button[aria-label*="ishlist"]', art);
      if (heart) {
        // BUG FIX: card hover applies group-hover:scale-105 to the product img,
        // whose new stacking context painted it ABOVE the z-auto heart → every
        // click hit the image (heart looked dead). Lift the heart above it.
        heart.style.zIndex = '10';
        const pname = title ? title.textContent.trim() : '';
        const preloadedId = heart.getAttribute('data-pd-heart');   // wishlist grid ships the real id at render
        if (preloadedId) paintHeart(heart, inWishlist(preloadedId));
        else resolveProductId(pname).then(id => {
          if (!id) return;                             // unknown product → heart stays inert
          heart.setAttribute('data-pd-heart', id);
          paintHeart(heart, inWishlist(id));            // active only if THIS user favourited THIS product
        });
        heart.addEventListener('click', e => {
          e.stopPropagation();
          if (!isAuthed()) {                           // guest → existing auth flow, nothing persisted
            requireCustomerAuth(location.pathname + location.search);
            return;
          }
          const known = heart.getAttribute('data-pd-heart');
          (known ? Promise.resolve(known) : resolveProductId(pname)).then(id => {
            if (!id) { toast('Product not found'); return; }
            toggleWishlist(id, pname, heart);
          });
        });
      }
    });
  }

  function parseCard(art) {
    const txt = art.innerText || '';
    const name = ($('h2, h3', art) || {}).textContent?.trim() || 'Product';
    const priceM = txt.match(/₹\s?([\d,]+)/);
    const weightM = txt.match(/\b(50g|100g|200g|500g|1kg|Pack of 4)\b/i);
    const catEl = $$('span', art).find(s => /masala|combo|pepper|powder/i.test(s.textContent) && s.textContent.length < 30);
    const img = $('img', art);
    return {
      name, price: priceM ? Number(priceM[1].replace(/,/g, '')) : 0,
      weight: weightM ? weightM[1] : '200g',
      category: catEl ? catEl.textContent.trim() : '',
      img: img ? img.src : '', qty: 1
    };
  }

  // Fill a cloned STATIC product card with a REAL catalog product (design
  // unchanged). Shared by the shop grid and the search grid — works for BOTH
  // card templates by selecting elements by CONTENT, not layout position:
  //   shop card    — <h3> title, price+mrp+weight-chip row, rating "4.8"
  //   search card  — <h2> title, price+mrp+"Save ₹x" row, rating "(4.8)"
  function fillProductCard(card, p) {
    card.removeAttribute('data-wired');               // clone must be wired fresh (click/heart/cart)
    const title = $('h2, h3', card);
    if (title) title.textContent = p.name;
    const label = $('span.uppercase', card);
    if (label) label.textContent = p.category || '';
    const img = $('img', card);
    if (img) { img.src = p.image || ''; img.alt = p.name || ''; }
    const desc = $('p.font-body-sm', card);
    if (desc) {
      desc.textContent = p.description || '';
      desc.style.display = p.description ? '' : 'none';
    }
    const feature = $$('span', card).find(s => s.classList.contains('text-primary') && s.classList.contains('font-label-sm'));
    if (feature) feature.style.display = 'none';      // template fluff ("5.2% Curcumin") ≠ this product
    const spans = $$('span', card);
    // rating: keep the template's wrapper style — "(4.8)" vs "4.8"
    const rat = spans.find(s => /^\(?\d\.\d\)?$/.test(s.textContent.trim()));
    if (rat) {
      const v = String(p.rating || 0);
      rat.textContent = /^\(/.test(rat.textContent.trim()) ? '(' + v + ')' : v;
    }
    const badge = spans.find(s => s.classList.contains('bg-secondary'));
    const off = (p.mrp && p.mrp > p.price) ? Math.round((p.mrp - p.price) / p.mrp * 100) : 0;
    if (badge) { if (off) badge.textContent = off + '% OFF'; else badge.style.display = 'none'; }
    const money = s => /^₹/.test(s);
    const priceEl = spans.find(s => money(s.textContent.trim()) && !s.classList.contains('line-through'));
    const mrpEl = spans.find(s => money(s.textContent.trim()) && s.classList.contains('line-through'));
    const saveEl = spans.find(s => /^Save ₹/.test(s.textContent.trim()));
    const hasMrp = !!(p.mrp && p.mrp > p.price);
    if (priceEl) priceEl.textContent = fmtINR(p.price);
    if (mrpEl) { mrpEl.textContent = hasMrp ? fmtINR(p.mrp) : ''; mrpEl.style.display = hasMrp ? '' : 'none'; }
    if (saveEl) { saveEl.textContent = hasMrp ? 'Save ' + fmtINR(p.mrp - p.price) : ''; saveEl.style.display = hasMrp ? '' : 'none'; }
    const chip = spans.find(s => /^(Pack of \d+|\d+(\.\d+)?\s?(?:g|kg))$/i.test(s.textContent.trim()));
    if (chip && p.weight) chip.textContent = p.weight;
    const heart = $('button[aria-label*="ishlist"]', card);
    if (heart) heart.setAttribute('data-pd-heart', p._id); // instant heart paint (wishlist pattern)
    return card;
  }

  // ============================================================
  // 2. SHOP PAGE (screen 2) — category filter, price filter, sort
  // ============================================================
  // Price-filter ranges — SHARED by the radio filter AND the live counts
  // (index-matched to the five price_range radios): one source of truth.
  const SHOP_PRICE_RANGES = [[0, 199], [100, 199], [200, 299], [300, 499], [500, Infinity]];

  function initShop() {
    const grid = $('main .grid.grid-cols-1.sm\\:grid-cols-2.xl\\:grid-cols-4') || $$('.grid').find(g => $$('article', g).length >= 4);
    if (!grid) return;
    // Fresh card list per event — the grid is re-rendered from the live
    // catalog below, so handlers must never capture a stale node array.
    const cardsNow = () => $$('article', grid);

    // ---- category counts: LIVE from the admin-managed catalog (fetched on
    // every shop visit) so the sidebar shows the EXACT number of listed
    // products per category and auto-updates whenever admin adds one.
    getCatalog().then(list => {
      if (!list.length) return;                        // fetch failed → keep static markup (never show fake zeros)
      const nrm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
      $$('#category-list a').forEach(link => {
        const spans = $$('span', link);
        if (spans.length < 2) return;
        const label = nrm(spans[0].textContent);
        let n;
        if (label.indexOf('all') === 0) {
          n = list.length;
        } else {
          const key = label.replace(/s$/, '');          // "single masalas" → "single masala"
          n = list.filter(p => {
            const c = nrm(p.category || '');
            return c === key || c.indexOf(key) === 0 || key.indexOf(c) === 0;
          }).length;
        }
        spans[1].textContent = n;
      });

      // ---- price range counts: SAME live catalog, index-matched to the
      // five radios (SHOP_PRICE_RANGES is shared with the filter itself,
      // so counts can never drift from what a click actually shows).
      $$('input[name="price_range"]').forEach((r, i) => {
        const rg = SHOP_PRICE_RANGES[i];
        const label = r.closest('label');
        const sp = label ? label.querySelectorAll('span') : [];
        const cnt = sp[sp.length - 1];
        if (!rg || !cnt) return;
        cnt.textContent = list.filter(p => {
          const pr = Number(p.price) || 0;
          return pr >= rg[0] && pr <= rg[1];
        }).length;
      });

      // ---- render the grid from the LIVE catalog so newly added products
      // (e.g. one Combo Pack per masala powder) are actually LISTED — the
      // static 8 cards alone left "Combo Packs" showing count 1 / zero cards.
      const tpl = $('article', grid);
      if (tpl) {
        grid.innerHTML = '';
        list.forEach(p => grid.appendChild(fillProductCard(tpl.cloneNode(true), p)));
        wireProductCards();                             // clone carries data-wired → re-wire click/heart/cart
        applyUrlCategory();                             // ?category= must filter the REAL cards (footer links)
      }
    });

    // category sidebar — filter logic extracted into applyCategory so "Clear"
    // (and ?category=) can re-apply a category WITHOUT a synthetic .click():
    // NAV_MAP rewrites "All Products"/"Single Masalas" hrefs to /shop, and a
    // programmatic click on those trips the guest auth gate (→ /register).
    const catLinks = $$('#category-list a');
    const applyCategory = link => {
      catLinks.forEach(l => l.classList.remove('bg-surface-container-low', 'text-primary', 'font-bold', 'shadow-[0_1px_2px_rgba(0,0,0,0.02)]'));
      link.classList.add('bg-surface-container-low', 'text-primary', 'font-bold');
      const label = $('span', link).textContent.trim().toLowerCase();
      cardsNow().forEach(a => {
        const cat = (a.querySelector('span.uppercase')?.textContent || '').toLowerCase();
        a.style.display = (label.indexOf('all') === 0 || !cat || cat.indexOf(label.split(' ')[0]) !== -1 || label.indexOf(cat.split(' ')[0]) !== -1) ? '' : 'none';
      });
    };
    catLinks.forEach(link => {
      link.addEventListener('click', e => { e.preventDefault(); applyCategory(link); });
    });

    // price radios
    $$('input[name="price_range"]').forEach((r, i) => {
      r.addEventListener('change', () => {
        const [lo, hi] = SHOP_PRICE_RANGES[i] || [0, Infinity];   // shared with the live counts
        cardsNow().forEach(a => {
          const m = (a.innerText || '').match(/₹\s?([\d,]+)/);
          const p = m ? Number(m[1].replace(/,/g, '')) : 0;
          a.style.display = (p >= lo && p <= hi) ? '' : 'none';
        });
      });
    });

    // "Clear" (price card header) — removes ONLY the price dimension: uncheck
    // the radios, then re-apply whichever category link is active (default
    // "All Products") so an active category filter isn't lost with it.
    const priceHead = $$('h3').find(h => /filter\s*by\s*price/i.test(h.textContent));
    const clearBtn = priceHead ? $$('button', priceHead).find(b => b.textContent.trim() === 'Clear') : null;
    if (clearBtn) clearBtn.addEventListener('click', () => {
      $$('input[name="price_range"]').forEach(r => { r.checked = false; });
      const active = catLinks.find(l => /text-primary/.test(l.className)) || catLinks[0];
      if (active) applyCategory(active);
      else cardsNow().forEach(a => { a.style.display = ''; });
    });

    // package size chips
    $$('aside button').forEach(b => {
      if (!/^(50g|100g|200g|500g|1kg)$/i.test(b.textContent.trim())) return;
      b.addEventListener('click', () => {
        $$('aside button').forEach(x => {
          if (/^(50g|100g|200g|500g|1kg)$/i.test(x.textContent.trim())) {
            x.className = 'px-space-sm py-1 rounded-md text-on-surface font-label-md text-label-md bg-surface-container hover:bg-surface-container-high transition-colors';
          }
        });
        b.className = 'px-space-sm py-1 rounded-md text-on-primary font-label-md text-label-md bg-primary-container shadow-sm';
        const w = b.textContent.trim().toLowerCase();
        cardsNow().forEach(a => {
          const m = (a.innerText || '').match(/\b(50g|100g|200g|500g|1kg|pack of 4)\b/i);
          a.style.display = (!m || m[1].toLowerCase() === w) ? '' : 'none';
        });
      });
    });

    // sort
    const sortSel = $('#sort-select');
    if (sortSel) sortSel.addEventListener('change', () => {
      const v = sortSel.value;
      const now = cardsNow();
      const arr = now.slice();
      if (v === 'price-low') arr.sort((a, b) => priceOf(a) - priceOf(b));
      else if (v === 'price-high') arr.sort((a, b) => priceOf(b) - priceOf(a));
      else if (v === 'rating') arr.sort((a, b) => ratingOf(b) - ratingOf(a));
      else arr.sort((a, b) => now.indexOf(a) - now.indexOf(b));
      arr.forEach(a => grid.appendChild(a));
    });
    const priceOf = a => { const m = (a.innerText || '').match(/₹\s?([\d,]+)/); return m ? Number(m[1].replace(/,/g, '')) : 0; };
    const ratingOf = a => { const m = (a.innerText || '').match(/(\d\.\d)\s*$/m); return m ? parseFloat(m[1]) : 0; };

    // URL category preselect (e.g. /shop?category=Combo%20Pack) — called twice:
    // on the static fallback cards, and again after the catalog render above.
    const applyUrlCategory = () => {
      const urlCat = new URLSearchParams(location.search).get('category');
      if (!urlCat) return;
      const link = catLinks.find(l => l.textContent.toLowerCase().indexOf(urlCat.toLowerCase().split(' ')[0]) !== -1);
      if (link) applyCategory(link);            // direct call — never a synthetic click (auth gate)
    };
    applyUrlCategory();
  }

  // ============================================================
  // 3. SEARCH PAGE (screen 4)
  // ============================================================
  function initSearch() {
    const container = $$('.grid').find(g => $$('article', g).length >= 3);
    if (!container) return;
    let cards = $$('article', container);              // reassigned after a catalog (?q=) render
    let qByCatalog = false;                            // true once ?q= was matched against the live catalog
    const countSpan = $$('span.font-bold.text-on-surface').find(s => /products/i.test(s.textContent));

    function applyFilters() {
      const q = (new URLSearchParams(location.search).get('q') || '').toLowerCase().trim();
      const cat = ($('input[name="category"]:checked') || {}).value || 'all';
      const priceR = $$('input[name="price_range"]');
      const pi = priceR.findIndex(r => r.checked);
      const ranges = [[0, 99], [100, 199], [200, 299], [300, 499], [500, Infinity]];
      const [lo, hi] = pi >= 0 ? ranges[pi] : [0, Infinity];
      const catMap = { single: 'single', blended: 'blended', combo: 'combo' };
      let n = 0;
      cards.forEach(a => {
        const title = ($('h2', a) || {}).textContent?.toLowerCase() || '';
        const label = ($$('span', a).find(s => /masala|combo pack/i.test(s.textContent) && s.textContent.length < 30) || {}).textContent?.toLowerCase() || '';
        const m = (a.innerText || '').match(/₹\s?([\d,]+)/);
        const p = m ? Number(m[1].replace(/,/g, '')) : 0;
        // Case-insensitive match: title OR category label; once the catalog
        // render handled ?q=, the cards are already q-filtered (skip re-check
        // so label-only matches like "masala" aren't hidden again).
        const okQ = !q || qByCatalog || title.indexOf(q) !== -1 || label.indexOf(q) !== -1;
        const okC = cat === 'all' || label.indexOf(catMap[cat] || cat) !== -1;
        const okP = p >= lo && p <= hi;
        const show = okQ && okC && okP;
        a.style.display = show ? '' : 'none';
        if (show) n++;
      });
      if (countSpan) countSpan.textContent = n + ' artisanal spice product' + (n === 1 ? '' : 's');
    }

    $$('input[name="category"], input[name="price_range"]').forEach(r => r.addEventListener('change', applyFilters));
    $$('button').forEach(b => { if (b.textContent.trim() === 'Reset') b.addEventListener('click', () => {
      const all = $('input[name="category"][value="all"]');
      if (all) all.checked = true;
      $$('input[name="price_range"]').forEach(r => { r.checked = false; });   // Reset must clear price too
      applyFilters();
    }); });

    const sortA = $('#sidebarSort'), sortB = $('#sortSelectMobile');
    [sortA, sortB].forEach(sel => sel && sel.addEventListener('change', () => {
      const arr = cards.slice();
      const v = sel.value;
      const priceOf = a => { const m = (a.innerText || '').match(/₹\s?([\d,]+)/); return m ? Number(m[1].replace(/,/g, '')) : 0; };
      if (v === 'price-low' || v === 'low') arr.sort((x, y) => priceOf(x) - priceOf(y));
      else if (v === 'price-high' || v === 'high') arr.sort((x, y) => priceOf(y) - priceOf(x));
      else arr.sort((x, y) => cards.indexOf(x) - cards.indexOf(y));
      arr.forEach(a => container.appendChild(a));
      if (sortA && sortB && sortA !== sortB) (sel === sortA ? sortB : sortA).value = v;
    }));

    // ---- ?q= → match against the LIVE catalog, case-insensitively, across
    // name + category + description, so ANY small/lower-case query displays
    // the related products (e.g. "masala" → all masalas, "garam" → Garam
    // Masala). No ?q= → static cards + sidebar filters, exactly as before.
    const rawQ = (new URLSearchParams(location.search).get('q') || '').trim();
    if (!rawQ) { applyFilters(); return; }

    getCatalog().then(list => {
      if (!list.length) { applyFilters(); return; }      // catalog unavailable → legacy title/label match
      const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const nq = norm(rawQ);
      const matches = list.filter(p =>
        norm(p.name + ' ' + p.category + ' ' + (p.description || '')).indexOf(nq) !== -1);
      if (matches.length) {
        const tpl = cards[0];
        container.innerHTML = '';
        matches.forEach(p => container.appendChild(fillProductCard(tpl.cloneNode(true), p)));
      } else {
        container.innerHTML = '<div class="col-span-full py-12 text-center">' +
          '<p class="text-gray-600 font-semibold mb-3">No products match “' + escapeHtml(rawQ) + '”</p>' +
          '<a class="text-sm font-semibold text-[#781616] underline" href="/shop">Browse all products →</a></div>';
      }
      qByCatalog = true;
      cards = $$('article', container);
      applyFilters();                                    // sidebar category/price still apply
      wireProductCards();                                // idempotent (data-wired guard)
    });
  }

  // ============================================================
  // Per-weight variant pricing (§12-§14): the DB has ONE base price per
  // product, so each weight's price is DERIVED from this product's own
  // price-per-gram:  price(w) = round5(basePrice × grams(w) / grams(baseWeight)).
  // Product-specific by construction (never a global weight→price map) and
  // fully reproducible — no arbitrary numbers. The product's own pack weight
  // returns the exact DB price (no rounding drift at checkout-relevant weight).
  // Non-gram packs (e.g. "Pack of 4") keep their single price.
  // ============================================================
  function gramsOf(w) {
    if (!w) return 0;
    const s = String(w).trim();
    const kg = s.match(/^(\d+(?:\.\d+)?)\s*kg$/i);
    if (kg) return Math.round(parseFloat(kg[1]) * 1000);
    const g = s.match(/^(\d+(?:\.\d+)?)\s*g$/i);
    return g ? Math.round(parseFloat(g[1])) : 0;
  }
  const round5 = n => Math.max(5, Math.round(n / 5) * 5);
  function variantPrice(p, weight) {
    const bg = gramsOf(p.weight), g = gramsOf(weight);
    if (!bg || !g || g === bg) return { price: p.price, mrp: p.mrp };   // base pack = exact DB price
    return {
      price: round5(p.price * g / bg),
      mrp: p.mrp > p.price ? round5(p.mrp * g / bg) : 0
    };
  }
  // Recompute the pricing row + __pdPrice for the CURRENT weight of the
  // CURRENT product. Called from renderProduct and from the page's setWeight.
  window.applyVariantPrice = function () {
    const p = window.__pdProduct;
    if (!p) return;
    const w = (typeof currentWeight !== 'undefined' && currentWeight) ? currentWeight : p.weight;
    const v = variantPrice(p, w);
    window.__pdPrice = fmtINR(v.price);
    const setT = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    setT('pd-price', fmtINR(v.price));
    const mrpEl = document.getElementById('pd-mrp'), discEl = document.getElementById('pd-discount');
    if (v.mrp > v.price) {
      if (mrpEl) { mrpEl.textContent = fmtINR(v.mrp); mrpEl.style.display = ''; }
      if (discEl) { discEl.textContent = Math.round((1 - v.price / v.mrp) * 100) + '% OFF'; discEl.style.display = ''; }
    } else {
      if (mrpEl) mrpEl.style.display = 'none';
      if (discEl) discEl.style.display = 'none';
    }
  };

  // ============================================================
  // 4. PRODUCT DETAILS (screen 3)
  // ============================================================
  function initProductDetails() {
    // NOTE: no setWeight→__pdPrice wrap. Chip onclick price args are static
    // design leftovers and must never reach the cart. __pdPrice is maintained
    // by window.applyVariantPrice(): derived from THIS product's own
    // price-per-gram for the selected weight (exact DB price at base pack).
    if (typeof window.handleAddToCart === 'function') {
      const orig = window.handleAddToCart;
      window.handleAddToCart = function () {
        if (!isAuthed()) {                             // §3: guest must not add to a persistent cart —
          requireCustomerAuth(location.pathname + location.search);   // existing auth flow; no toast (nothing added)
          return false;
        }
        const item = pdItem();
        if (!item) { toast('Product not found'); return false; }
        addToCart(item);
        updateBadges();
        return orig.apply(this, arguments);            // toast reads the DYNAMIC #pd-title (inline fix)
      };
    }
    // (BUY NOW is wired inside renderProduct — the button lives in the inert
    //  <template> until the correct product has been fetched and restored.)
    // pdItem() lives at IIFE scope (shared by the handleAddToCart wrap here
    //  and renderProduct's BUY NOW wiring).

    // ---- dynamic load: read ?id from THIS URL → fetch THAT product → render it ----
    // Initial DOM state = the loading skeleton shipped in the HTML (the static
    // product markup sits inside <template>, which is inert and NEVER paints),
    // so no wrong/default product can flash while this fetch is in flight.
    const id = new URLSearchParams(location.search).get('id');
    if (!id) { renderProductState('notfound'); return; }   // missing id → not-found, NEVER a default product
    fetch('/api/products/' + encodeURIComponent(id))
      .then(r => {
        if (r.status === 404) throw new Error('notfound');
        if (!r.ok) throw new Error('failed');
        return r.json();
      })
      .then(p => renderProduct(p))
      .catch(err => renderProductState(err && err.message === 'notfound' ? 'notfound' : 'error'));
  }

  function pdItem() {
    const P = window.__pdProduct;
    if (!P) return null;                               // never fall back to a hardcoded product
    const qty = (typeof currentQty !== 'undefined') ? currentQty : 1;
    const weight = (typeof currentWeight !== 'undefined' && currentWeight) ? currentWeight : P.weight;
    const price = window.__pdPrice ? Number(String(window.__pdPrice).replace(/[^\d]/g, '')) : P.price;
    const img = ($('#main-product-img') || {}).src || P.image || '';
    return { id: P._id, name: P.name, weight, price: price || P.price, qty, category: P.category, img };
  }

  // ---------- Wishlist page (existing as_wishlist system's destination) ----------
  function initWishlist() {
    const grid = $('[data-purpose="wishlist-grid"]');
    if (!grid) return;
    const EMPTY = '<div class="col-span-full py-12 text-center"><p class="text-gray-600 font-semibold mb-3">Your wishlist is empty</p>' +
      '<a class="text-sm font-semibold text-[#781616] underline" href="/shop">Browse products →</a></div>';
    const ids = getWishlist();                            // user-scoped favourites (§15)
    if (!ids.length) {                                    // empty state needs NO catalog fetch —
      grid.innerHTML = EMPTY;                             // render synchronously (no async gap where the
      updateWishlistHearts();                             // grid reads as blank to users/tests alike)
      return;
    }
    getCatalog().then(catalog => {
      const items = ids.map(id => catalog.find(p => p._id === id)).filter(Boolean);
      if (!items.length) {
        grid.innerHTML = EMPTY;
      } else {
        grid.innerHTML = items.map(p => `
          <article class="bg-surface-container-lowest rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow flex flex-col group relative">
            <div class="relative bg-[#faf8f3] p-space-md flex items-center justify-center aspect-square">
              <button aria-label="Add to Wishlist" aria-pressed="false" data-pd-heart="${p._id}" class="absolute top-2 right-2 z-10 w-8 h-8 rounded-full bg-surface-container-lowest/80 text-on-surface-variant hover:text-secondary flex items-center justify-center transition-colors" type="button">
                <span class="material-symbols-outlined text-[18px]">favorite_border</span>
              </button>
              <img alt="${escapeHtml(p.name)}" class="w-full h-full object-contain p-2 group-hover:scale-105 transition-transform duration-300" src="${p.image || ''}"/>
            </div>
            <div class="p-space-md flex flex-col flex-1 justify-between">
              <div>
                <p class="font-label-sm text-label-sm text-outline uppercase tracking-wider">${escapeHtml(p.category || '')}</p>
                <h3 class="font-title-lg text-title-lg font-bold text-on-surface mt-1">${escapeHtml(p.name)}</h3>
              </div>
              <div class="flex items-baseline gap-1.5 mt-2">
                <span class="font-title-lg text-title-lg font-bold text-on-surface">${fmtINR(p.price)}</span>
                ${p.mrp > p.price ? `<span class="font-body-sm text-body-sm line-through text-outline">${fmtINR(p.mrp)}</span>` : ''}
              </div>
            </div>
          </article>`).join('');
        // Paint from the SAME store the list was built from — the product id is
        // known at render time, so hearts get their state synchronously (no
        // name→id re-resolution, no async window where a saved heart shows
        // outline). One source of truth: as_wishlist:<uid> contains the id.
        $$('[data-pd-heart]', grid).forEach(b => paintHeart(b, inWishlist(b.getAttribute('data-pd-heart'))));
      }
      wireProductCards();                               // card click → product, heart → toggle (double-wire guarded)
      updateWishlistHearts();                           // final consistency pass from the same store
    });
  }

  function renderProductState(kind) {
    const msg = kind === 'error'
      ? "Couldn't load this product. Please try again."
      : 'Product not found';
    const setT = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    setT('pd-title', msg);
    setT('pd-crumb-name', msg);
    setT('pd-crumb-cat', '');
    window.__pdProduct = null;
    const canvas = document.getElementById('pd-canvas');
    if (canvas) {
      canvas.innerHTML = '<div class="max-w-7xl mx-auto px-gutter"><div class="py-16 text-center">' +
        '<h1 id="pd-title" class="text-2xl font-bold text-gray-800 mb-3"></h1>' +
        '<a class="text-sm font-semibold text-[#781616] underline" href="/shop">Browse products →</a>' +
        '</div></div>';
      const t = document.getElementById('pd-title');
      if (t) t.textContent = msg;
    }
  }

  function renderProduct(p) {
    window.__pdProduct = p;
    window.__pdPrice = fmtINR(p.price);
    // Restore the static template ONCE. Its content lives inside <template>
    // (inert — never painted), so the only thing visible so far was the
    // loading skeleton; restore + fill happen in THIS synchronous block, so
    // the browser paints exactly one frame: the correct product.
    const canvasEl = document.getElementById('pd-canvas');
    const tplEl = document.getElementById('pd-canvas-tpl');
    if (canvasEl && tplEl && !window.__pdRestored) {
      window.__pdRestored = true;
      canvasEl.innerHTML = tplEl.innerHTML;            // RHS read before assignment
    }
    const setT = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    setT('pd-title', p.name);
    setT('pd-crumb-name', p.name);
    setT('pd-crumb-cat', p.category);
    setT('pd-rating', String(p.rating || 0));
    setT('pd-price', fmtINR(p.price));
    setT('pd-stock', p.stock > 0 ? 'In Stock' : 'Out of Stock');
    setT('pd-pack', 'Standard Pack: ' + p.weight);
    const batch = document.getElementById('pd-batch');
    if (batch) batch.style.display = 'none';           // chilli-specific static batch code
    // MRP + discount badge (hide when there is no real discount)
    const mrpEl = document.getElementById('pd-mrp'), discEl = document.getElementById('pd-discount');
    if (p.mrp > p.price) {
      if (mrpEl) { mrpEl.textContent = fmtINR(p.mrp); mrpEl.style.display = ''; }
      if (discEl) { discEl.textContent = Math.round((1 - p.price / p.mrp) * 100) + '% OFF'; discEl.style.display = ''; }
    } else {
      if (mrpEl) mrpEl.style.display = 'none';
      if (discEl) discEl.style.display = 'none';
    }
    // weight chips: REAL selection state (requirement: selection must affect
    // the actual variant, not only CSS). Available options = the product's own
    // variant list when the data provides one (p.weights / p.variants);
    // otherwise the page's designed chips. Default = THIS product's actual
    // weight (never hardcoded 200g). Selecting a weight recomputes the price
    // from THIS product's own price-per-gram (see variantPrice above).
    const group = document.getElementById('weight-selector-group');
    if (group) {
      const chips = Array.prototype.slice.call(group.querySelectorAll('.weight-chip'));
      const dataWeights = (Array.isArray(p.weights) && p.weights.length) ? p.weights
        : (Array.isArray(p.variants) && p.variants.length)
          ? p.variants.map(v => (v && v.weight) || '').filter(Boolean) : null;
      chips.forEach(ch => {                            // start from all-enabled
        ch.disabled = false;
        ch.classList.remove('opacity-40', 'pointer-events-none');
      });
      if (dataWeights) chips.forEach(ch => {           // restrict only if data says so
        const on = dataWeights.indexOf(ch.textContent.trim()) !== -1;
        if (!on) { ch.disabled = true; ch.classList.add('opacity-40', 'pointer-events-none'); }
      });
      const matched = chips.find(ch => _normName(ch.textContent) === _normName(p.weight));
      if (matched && typeof setWeight === 'function') setWeight(matched, fmtINR(p.price), p.mrp > p.price ? fmtINR(p.mrp) : '', '', p.weight);
      else if (typeof currentWeight !== 'undefined') currentWeight = p.weight;   // e.g. "Pack of 4" — honest default, no chip active
      // non-gram packs have no gram variants — hide the selector (SPA reuse → unhide for gram products)
      if (group.parentElement) group.parentElement.style.display = gramsOf(p.weight) ? '' : 'none';
      if (window.applyVariantPrice) window.applyVariantPrice();   // price row + __pdPrice for the default weight
    }
    // image (per-product image from the products API)
    const img = document.getElementById('main-product-img');
    if (img && p.image) {
      img.src = p.image;
      img.alt = p.name;
      Array.prototype.forEach.call(document.querySelectorAll('.thumb-btn img'), t => { t.src = p.image; });
    }
    // description from product data (the static page ships chilli-specific copy)
    const desc = document.getElementById('tab-desc');
    if (desc) {
      const txt = (p.description && p.description.trim())
        ? p.description.trim()
        : 'AromaSpice ' + p.name + ' — ' + p.category + ', ' + p.weight + ' pack.';
      desc.innerHTML = '<p class="font-body-lg text-body-lg text-on-surface leading-relaxed max-w-4xl"></p>';
      desc.firstChild.textContent = txt;
    }
    // BUY NOW — wired AFTER template restore (button only exists post-restore)
    $$('button, a').forEach(b => {
      if (/^buy now$/i.test(b.textContent.trim()) && !b.dataset.pdBuyNow) {
        b.dataset.pdBuyNow = '1';
        b.addEventListener('click', e => {
          e.preventDefault();
          if (!isAuthed()) {                           // guest never writes a cart — just the auth gate
            requireCustomerAuth('/checkout');
            return;
          }
          const item = pdItem();
          if (!item) { toast('Product not found'); return; }
          addToCart(item);
          requireCustomerAuth('/checkout');
        });
      }
    });
    // favourite button (product page)
    const fav = document.getElementById('pd-fav');
    if (fav && !fav.getAttribute('data-pd-heart')) {
      fav.setAttribute('data-pd-heart', p._id);
      fav.addEventListener('click', e => {
        e.preventDefault();
        toggleWishlist(p._id, p.name, fav);            // guest → auth flow inside toggleWishlist
      });
    }
    updateWishlistHearts();                            // paint active/inactive for the current user
  }

  // ============================================================
  // 5. CART PAGE (screen 7)
  // ============================================================
  function initCartPage() {
    const table = $('[data-purpose="cart-items-table"]');
    if (!table) return;
    const list = $('.divide-y', table);
    if (!list) return;

    function render() {
      const cart = getCart();
      if (!cart.length) {
        list.innerHTML = '<div class="py-10 text-center"><p class="text-gray-600 font-semibold mb-3">Your cart is empty</p><a class="text-sm font-semibold text-[#781616] underline" href="/shop">Browse products →</a></div>';
      } else {
        list.innerHTML = cart.map((it, i) => `
        <div class="py-4 sm:py-5 grid grid-cols-1 sm:grid-cols-12 items-center gap-4" data-purpose="cart-item">
          <div class="sm:col-span-6 flex items-center space-x-4">
            <div class="w-16 h-16 flex-shrink-0 bg-gray-50 border border-gray-100 rounded-md p-1 flex items-center justify-center">
              <img alt="${it.name}" class="w-full h-full object-cover rounded" src="${it.img || ''}">
            </div>
            <div>
              <h3 class="font-semibold text-gray-900 text-sm sm:text-base">${it.name} (${it.weight})</h3>
              <p class="text-xs text-gray-500 mt-0.5">Category: ${it.category || 'Masala'}</p>
              <div class="sm:hidden mt-1 font-semibold text-gray-900 text-sm">${fmtINR(it.price)}</div>
            </div>
          </div>
          <div class="hidden sm:block sm:col-span-2 text-center text-sm font-medium text-gray-700">${fmtINR(it.price)}</div>
          <div class="sm:col-span-2 flex items-center justify-start sm:justify-center">
            <div class="flex items-center border border-gray-300 rounded overflow-hidden">
              <button aria-label="Decrease quantity" data-act="dec" data-i="${i}" class="px-2.5 py-1 text-gray-600 bg-gray-50 hover:bg-gray-200 transition text-sm font-semibold" type="button">−</button>
              <span class="px-3 py-1 text-xs font-medium text-gray-900 bg-white">${it.qty}</span>
              <button aria-label="Increase quantity" data-act="inc" data-i="${i}" class="px-2.5 py-1 text-gray-600 bg-gray-50 hover:bg-gray-200 transition text-sm font-semibold" type="button">+</button>
            </div>
          </div>
          <div class="sm:col-span-2 flex items-center justify-between sm:justify-end space-x-3">
            <span class="text-sm font-bold text-gray-900">${fmtINR(it.price * it.qty)}</span>
            <button aria-label="Remove item" data-act="rm" data-i="${i}" class="text-red-500 hover:text-red-700 p-1 transition" title="Remove Item" type="button">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path></svg>
            </button>
          </div>
        </div>`).join('');
      }
      renderSummary();
      updateBadges();
    }

    function renderSummary() {
      const t = cartTotals();
      const aside = $('[data-purpose="order-summary-sidebar"]');
      if (!aside) return;
      $$('div', aside).forEach(row => {
        if (row.children.length !== 2) return;
        const label = row.children[0].textContent;
        if (/subtotal/i.test(label)) row.children[1].textContent = fmtINR(t.subtotal);
        else if (/discount/i.test(label)) {
          if (t.discount > 0) { row.children[1].textContent = '-' + fmtINR(t.discount); row.style.display = ''; }
          else row.style.display = 'none';          // no valid coupon ⇒ row hidden
        }
        else if (/^\s*total/i.test(label)) row.children[1].textContent = fmtINR(t.total);
      });
    }

    list.addEventListener('click', e => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const i = +b.dataset.i;
      const cart = getCart();
      if (!cart[i]) return;
      if (b.dataset.act === 'inc') cart[i].qty++;
      if (b.dataset.act === 'dec') cart[i].qty = Math.max(1, cart[i].qty - 1);
      if (b.dataset.act === 'rm') { cart.splice(i, 1); toast('Item removed'); }
      setCart(cart);
      render();
    });

    render();

    // coupon — discount exists ONLY after a VALID code is applied here
    const applyBtn = $$('#coupon-code').length ? $$('button').find(b => b.textContent.trim() === 'Apply' && b.closest('aside')) : null;
    if (applyBtn) applyBtn.addEventListener('click', () => {
      const inp = $('#coupon-code');
      const code = ((inp && inp.value) || '').trim().toUpperCase();
      if (!code) { toast('Enter a coupon code'); return; }
      if (!VALID_COUPONS[code]) {
        store.del('as_coupon');                      // stale/invalid code ⇒ no discount
        if (inp) inp.value = '';
        renderSummary();
        toast('Invalid coupon code — no discount applied');
        return;
      }
      store.set('as_coupon', { code });
      if (inp) inp.value = code;
      renderSummary();
      toast('Coupon ' + code + ' applied — ' + Math.round(VALID_COUPONS[code] * 100) + '% off');
    });
    // reflect an already-applied code in the input
    const cp0 = activeCoupon();
    if (cp0 && $('#coupon-code')) $('#coupon-code').value = cp0.code;
  }

  // ============================================================
  // 6. CHECKOUT (screen 8)
  // ============================================================
  function initCheckout() {
    const list = $('[data-purpose="product-list"]');
    const cart = getCart();
    if (list) {
      list.innerHTML = cart.length ? cart.map(it => `
        <div class="py-3 flex items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded bg-[#eaf4ee] border border-emerald-100 flex items-center justify-center shrink-0">
              <img class="w-8 h-8 object-cover rounded" src="${it.img || ''}" alt="${it.name}">
            </div>
            <div>
              <p class="text-sm font-semibold text-stone-900">${it.name}</p>
              <p class="text-xs text-stone-500">${it.weight} × ${it.qty}</p>
            </div>
          </div>
          <span class="text-sm font-semibold text-stone-800">${fmtINR(it.price * it.qty)}</span>
        </div>`).join('') : '<p class="py-4 text-sm text-stone-500">Your cart is empty. <a class="underline font-semibold" href="/shop">Shop now</a></p>';
    }

    // totals
    const t = cartTotals();
    const summary = $('[data-purpose="order-summary-section"]') || document;
    $$('div', summary).forEach(row => {
      if (row.children.length !== 2) return;
      const label = row.children[0].textContent;
      if (/subtotal/i.test(label)) row.children[1].textContent = fmtINR(t.subtotal);
      else if (/discount/i.test(label)) {
        if (t.discount > 0) { row.children[1].textContent = '-' + fmtINR(t.discount); row.style.display = ''; }
        else row.style.display = 'none';            // no valid coupon ⇒ row hidden
      }
      else if (/^\s*total/i.test(label)) row.children[1].textContent = fmtINR(t.total);
    });

    // REAL-USER PREFILL — identity comes from the logged-in account, address
    // only from THIS user's own last saved address; any residual static demo
    // values (Riya Sharma / Flat 402 / 560034 …) are cleared first.
    const DEMO_VALS = {
      full_name: 'Riya Sharma', phone_number: '9876543210', email_address: 'riya.sharma@email.com',
      street_address: 'Flat 402, Green Valley Apartments, 8th Main',
      area_locality: 'Koramangala 4th Block, Near Sony Signal', city: 'Bengaluru', pincode: '560034'
    };
    Object.keys(DEMO_VALS).forEach(id => { const el = $('#' + id); if (el && el.value === DEMO_VALS[id]) el.value = ''; });
    const u = validUser();
    const saved = store.get('as_address', null);
    const own = !!(u && saved && saved.uid === u.id);
    if (u) {
      const setv = (id, v) => { const el = $('#' + id); if (el && v) el.value = v; };
      setv('full_name', u.fullName || '');
      setv('email_address', u.email || '');
      setv('phone_number', u.phone || (own ? saved.phone : '') || '');
      if (own) {
        setv('street_address', saved.street || '');
        setv('area_locality', saved.area || '');
        setv('city', saved.city || '');
        setv('pincode', saved.pincode || '');
        const st = $('#state');
        if (st && saved.state && Array.prototype.some.call(st.options, o => o.value === saved.state)) st.value = saved.state;
      }
    }
    // GPS block — capture the real delivery point (works for guests too;
    // stored per-user so user A's location never shows for user B).
    const gpsBtn = $('[data-purpose="gps-capture"]');
    if (gpsBtn) gpsBtn.addEventListener('click', () => captureGps());
    renderGpsStatus();
    syncDeliverLabel();

    // PROCEED TO PAYMENT
    const payBtn = $$('button').find(b => /proceed to payment/i.test(b.textContent));
    if (payBtn) payBtn.addEventListener('click', () => {
      const f = {
        name: $('#full_name'), phone: $('#phone_number'), email: $('#email_address'),
        street: $('#street_address'), area: $('#area_locality'), city: $('#city'),
        state: $('#state'), pin: $('#pincode')
      };
      let ok = true;
      const fail = (el, msg) => {
        ok = false;
        if (!el) return;
        el.style.borderColor = '#dc2626';
        let err = el.nextElementSibling && el.nextElementSibling.classList.contains('as-err') ? el.nextElementSibling : null;
        if (!err) { err = document.createElement('p'); err.className = 'as-err text-xs text-red-600 mt-1'; el.parentNode.insertBefore(err, el.nextSibling); }
        err.textContent = msg;
      };
      Object.values(f).forEach(el => el && (el.style.borderColor = '', el.nextElementSibling?.classList?.contains('as-err') && el.nextElementSibling.remove()));
      if (!f.name.value.trim()) fail(f.name, 'Full name is required');
      if (!/^\d{10}$/.test(f.phone.value.trim())) fail(f.phone, 'Enter a valid 10-digit phone number');
      if (!/^\S+@\S+\.\S+$/.test(f.email.value.trim())) fail(f.email, 'Enter a valid email address');
      if (!f.street.value.trim()) fail(f.street, 'Street address is required');
      if (!f.area.value.trim()) fail(f.area, 'Area / locality is required');
      if (!f.city.value.trim()) fail(f.city, 'City is required');
      if (!f.state.value.trim()) fail(f.state, 'State is required');
      if (!/^\d{6}$/.test(f.pin.value.trim())) fail(f.pin, 'Enter a valid 6-digit PIN code');
      if (!ok) { toast('Please fix the highlighted fields'); return; }
      // stamp ownership + timestamp + GPS snapshot so (a) only THIS user ever
      // sees the address re-prefilled and (b) the header can show the newest
      // real location signal (PIN vs GPS). Payment payload below picks its own
      // fields explicitly — uid/at/gps never reach the server order.
      store.set('as_address', {
        name: f.name.value.trim(), phone: f.phone.value.trim(), email: f.email.value.trim(),
        street: f.street.value.trim(), area: f.area.value.trim(), city: f.city.value.trim(),
        state: f.state.value.trim(), pincode: f.pin.value.trim(),
        uid: u ? u.id : null, at: Date.now(), gps: getGps() || null
      });
      syncDeliverLabel();
      location.href = '/payment';
    });
  }

  // ============================================================
  // 7. PAYMENT (screen 9) — Phase B: real gateway flow (sandbox/test)
  //    PAY NOW → POST /api/payments/create (idempotency key) → gateway
  //    checkout → POST /api/payments/verify (server verifies signature/amount)
  //    → order-confirmation. Frontend NEVER decides payment success.
  // ============================================================

  // Phase B: load Razorpay checkout.js on demand (razorpay mode only — sandbox needs no SDK)
  function loadRazorpaySdk() {
    return new Promise((resolve, reject) => {
      if (window.Razorpay) return resolve(true);
      const s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.onload = () => resolve(true);
      s.onerror = () => reject(new Error('Failed to load Razorpay checkout'));
      document.head.appendChild(s);
    });
  }
  // Open Razorpay modal; on handler response, BACKEND verifies (never the frontend)
  async function openRazorpayCheckout(d, onSuccess, onFailure, pref) {
    try { await loadRazorpaySdk(); }
    catch (e) { toast('Unable to load payment gateway — please retry'); onFailure(); return; }
    const rzp = new window.Razorpay({
      key: d.keyId,                     // publishable key only
      order_id: d.gatewayOrderId,
      amount: d.amount, currency: d.currency,
      name: 'AromaSpice', description: 'Order payment',
      prefill: { name: pref.name || '', email: pref.email || '', contact: pref.contact || '' },
      theme: { color: '#1b4d29' },
      handler: async (resp) => {
        const v = await api('/payments/verify', {
          method: 'POST',
          body: JSON.stringify({
            gatewayOrderId: resp.razorpay_order_id,
            paymentId: resp.razorpay_payment_id,
            signature: resp.razorpay_signature
          })
        });
        if (v.ok) onSuccess(v.data);
        else { toast('Payment failed: ' + ((v.data && v.data.error) || 'verification failed')); onFailure(); }
      },
      modal: { ondismiss: () => { toast('Payment cancelled'); onFailure(); } }
    });
    rzp.open();
  }

  function initPayment() {
    const cart = getCart();
    const t = cartTotals();

    const items = $('[data-purpose="summary-items-list"]');
    if (items) {
      items.innerHTML = cart.length ? cart.map(it => `
        <div class="py-3 flex justify-between items-center">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded bg-[#fff5f5] border border-[#fed7d7] flex items-center justify-center overflow-hidden">
              <img class="w-7 h-7 object-cover rounded" src="${it.img || ''}" alt="">
            </div>
            <div>
              <h3 class="font-medium text-gray-900 text-xs sm:text-sm">${it.name} (${it.weight})</h3>
              <p class="text-[11px] text-gray-500">Qty × ${it.qty}</p>
            </div>
          </div>
          <span class="font-semibold text-gray-800 text-xs sm:text-sm">${fmtINR(it.price * it.qty)}</span>
        </div>`).join('') : '<p class="py-3 text-xs text-gray-500">Cart is empty. <a class="underline" href="/shop">Shop now</a></p>';
    }

    const box = $('[data-purpose="order-summary-section"]') || document;
    $$('div', box).forEach(row => {
      if (row.children.length !== 2) return;
      const label = row.children[0].textContent;
      if (/subtotal/i.test(label)) row.children[1].textContent = fmtINR(t.subtotal);
      else if (/discount/i.test(label)) {
        if (t.discount > 0) { row.children[1].textContent = '-' + fmtINR(t.discount); row.style.display = ''; }
        else row.style.display = 'none';            // no valid coupon ⇒ row hidden
      }
      else if (/^\s*total/i.test(label)) row.children[1].textContent = fmtINR(t.total);
    });

    // delivery snapshot — the address the user just entered at checkout
    // (ownership-checked). NEVER the old static demo identity/address.
    const dn = $('[data-purpose="deliver-to-name"]'), da = $('[data-purpose="deliver-to-address"]');
    if (dn && da) {
      const a = store.get('as_address', null);
      const usr = validUser();
      const aOk = a && a.name && !(usr && a.uid && a.uid !== usr.id);
      if (aOk) {
        dn.textContent = a.name + (a.phone ? ' • +91 ' + a.phone : '');
        da.textContent = [a.street, a.area, a.city, a.state, a.pincode].filter(Boolean).join(', ');
      } else {
        dn.textContent = usr ? (usr.fullName || '') : '';
        da.textContent = 'No delivery address yet — click Change to add one.';
      }
    }

    // header amount + PAY NOW amount
    $$('span').forEach(sp => {
      const txt = sp.textContent.trim();
      if (/^PAY NOW/.test(txt)) sp.textContent = 'PAY NOW • ' + fmtINR(t.total);
      else if (/^₹[\d,]+$/.test(txt) && txt === '₹463') sp.textContent = fmtINR(t.total);
    });

    const payBtn = $$('button').find(b => /pay now/i.test(b.textContent));
    // Phase B: one idempotency key per checkout attempt — reused on double-click,
    // browser retry and network retry so the server can never create two orders.
    const getIdemKey = () => {
      let k = sessionStorage.getItem('as_pay_idem') || '';
      if (!k) {
        k = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
          : 'idem-' + Date.now() + '-' + Math.random().toString(16).slice(2);
        sessionStorage.setItem('as_pay_idem', k);
      }
      return k;
    };
    const restoreBtn = () => { payBtn.disabled = false; payBtn.innerHTML = 'PAY NOW • ' + fmtINR(t.total); };
    const finishPaid = (order) => {
      sessionStorage.removeItem('as_pay_idem');   // new checkout attempt next time
      store.del('as_coupon');                     // coupon consumed — next order needs it re-entered
      store.set('as_last_order', order);
      location.href = '/order-confirmation';
    };
    if (payBtn) payBtn.addEventListener('click', async () => {
      if (!cart.length) { toast('Your cart is empty'); return; }
      const method = ($('input[name="payment_method"]:checked') || {}).value || 'upi';
      if (method === 'upi') {
        const upi = $$('input[placeholder*="UPI"]').find(i => i.offsetParent !== null);
        if (upi && !/^\S+@\S+$/.test(upi.value.trim())) {
          upi.style.borderColor = '#dc2626';
          upi.focus();
          toast('Please enter a valid UPI ID (e.g. 9876543210@upi)');
          return;
        }
      }
      const addr = store.get('as_address', {});
      const u = getUser();
      payBtn.disabled = true;
      payBtn.textContent = 'Processing…';
      try {
        // 1. server validates cart + calculates authoritative amount + reserves stock
        const res = await api('/payments/create', {
          method: 'POST',
          body: JSON.stringify({
            customerName: addr.name || (u && u.fullName) || 'Guest',
            customerEmail: addr.email || (u && u.email) || '',
            items: cart.map(i => ({ name: i.name, weight: i.weight, qty: i.qty, price: i.price })),
            address: { street: addr.street, area: addr.area, city: addr.city, state: addr.state, pincode: addr.pincode },
            paymentMethod: method.toUpperCase(),
            coupon: activeCoupon() ? activeCoupon().code : '',   // server re-validates the code
            idempotencyKey: getIdemKey()
          })
        });
        if (!res.ok) {
          toast('Payment failed: ' + ((res.data && res.data.error) || 'try again'));
          restoreBtn();
          return;
        }
        const d = res.data;
        if (d.mode === 'cod') { finishPaid(d.order); return; }   // COD: order placed, pay on delivery
        if (d.mode === 'sandbox') {
          // 2a. SANDBOX (no keys): local simulator completes + signs the payment…
          const comp = await api('/payments/mock/complete', {
            method: 'POST', body: JSON.stringify({ gatewayOrderId: d.gatewayOrderId, outcome: 'success' })
          });
          if (!comp.ok) { toast('Payment failed: ' + ((comp.data && comp.data.error) || 'gateway error')); restoreBtn(); return; }
          // 2b. …and the BACKEND verifies signature/amount before marking Paid
          const v = await api('/payments/verify', {
            method: 'POST',
            body: JSON.stringify({ gatewayOrderId: d.gatewayOrderId, paymentId: comp.data.paymentId, signature: comp.data.signature })
          });
          if (v.ok) finishPaid(v.data);
          else { toast('Payment failed: ' + ((v.data && v.data.error) || 'verification failed')); restoreBtn(); }
          return;
        }
        // RAZORPAY (test keys configured): open real gateway checkout modal
        openRazorpayCheckout(d, finishPaid, restoreBtn, {
          name: addr.name || (u && u.fullName) || '',
          email: addr.email || (u && u.email) || '',
          contact: (addr.phone || '').replace(/\D/g, '')
        });
      } catch (e) {
        toast('Network error — is the server running?');
        restoreBtn();
      }
    });
  }

  // ============================================================
  // 8. ORDER CONFIRMATION (screen 10)
  // ============================================================
  function initConfirmation() {
    const order = store.get('as_last_order', null);
    if (order && order.orderId) {
      $$('span').forEach(sp => {
        if (/^#AS\d+$/.test(sp.textContent.trim())) sp.textContent = order.orderId;
      });
    }
    // sidebar totals from placed order (or default cart)
    const o = order || null;
    const t = o ? { subtotal: o.subtotal, discount: o.discount, total: o.total } : cartTotals();
    const aside = $('[data-purpose="order-summary-sidebar"]');
    if (aside) {
      // line items
      const itemsBox = $('.space-y-3.border-b', aside) || $$('div', aside).find(d => d.className.includes('space-y-3') && d.className.includes('border-b'));
      const items = o ? o.items : getCart();
      if (itemsBox && o) {
        itemsBox.innerHTML = items.map(it => `
          <div class="flex justify-between items-center text-gray-700">
            <span class="font-medium text-gray-800">${it.name} <span class="text-gray-400 font-normal">(${it.weight})</span></span>
            <span class="font-semibold text-gray-900">${fmtINR(it.price * it.qty)}</span>
          </div>`).join('');
      }
      $$('div', aside).forEach(row => {
        if (row.children.length !== 2) return;
        const label = row.children[0].textContent;
        if (/subtotal/i.test(label)) row.children[1].textContent = fmtINR(t.subtotal);
        else if (/discount/i.test(label)) {
          if (t.discount > 0) { row.children[1].textContent = '-' + fmtINR(t.discount); row.style.display = ''; }
          else row.style.display = 'none';          // no discount on this order ⇒ row hidden
        }
        else if (/^\s*total/i.test(label)) row.children[1].textContent = fmtINR(t.total);
      });
    }
    // buttons
    $$('a').forEach(a => {
      if (a.hasAttribute('data-purpose') && a.getAttribute('data-purpose') === 'track-order-button') a.href = '/order-history';
      if (a.getAttribute('data-purpose') === 'continue-shopping-link') a.href = '/shop';
    });
  }

  // ============================================================
  // 9. ORDER HISTORY + TRACKING (screen 12)
  // ============================================================
  function initOrderHistory() {
    // Static sidebar identity chip (Riya Sharma / e-mail / "RS" initials) →
    // THIS user's real identity. Runs once, BEFORE the orders table renders,
    // so server-rendered rows (real o.customerName) are never re-scanned.
    const ou = validUser();
    if (ou) $$('div, p, span').forEach(el => {
      if (el.children.length) return;
      const t = el.textContent.trim();
      if (t === 'Riya Sharma') el.textContent = ou.fullName || '';
      else if (t === 'riya.sharma@email.com') el.textContent = ou.email || '';
      else if (t === 'RS') el.textContent = (ou.fullName || '').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || 'You';
    });
    const trackForm = $('#track-order-id') && $('#track-order-id').closest('form');
    if (trackForm) trackForm.addEventListener('submit', async e => {
      e.preventDefault();
      const raw = $('#track-order-id').value.trim();
      if (!raw) { toast('Enter an order ID'); return; }
      const id = raw.startsWith('#') ? raw : '#' + raw;
      const res = await api('/orders/' + encodeURIComponent(id));
      let box = $('#as-track-result');
      if (!box) {
        box = document.createElement('div');
        box.id = 'as-track-result';
        box.style.cssText = 'margin-top:14px;padding:14px 16px;background:#fff;border:1px solid #E8DFD1;border-radius:10px;font:14px/1.5 system-ui,sans-serif';
        trackForm.parentNode.insertBefore(box, trackForm.nextSibling);
      }
      if (!res.ok) {
        box.innerHTML = '<span style="color:#dc2626;font-weight:600">Order ' + id + ' not found. Check the ID and try again.</span>';
        return;
      }
      const o = res.data;
      const steps = ['Processing', 'Shipped', 'Delivered'];
      const idx = o.status === 'Cancelled' ? -1 : steps.indexOf(o.status);
      box.innerHTML = `
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;align-items:center">
          <strong style="color:#15522E">${o.orderId}</strong>
          <span>
            <span class="as-pill" style="${pillStyle(o.status)}">${o.status}</span>
            <span class="as-pill" style="${payPillStyle(o.paymentStatus)}" title="Payment status">${o.paymentStatus || 'Paid'}</span>
          </span>
        </div>
        <div style="color:#6b7280;font-size:13px;margin-top:6px">${o.customerName} · ${fmtINR(o.total)} · ${fmtDate(o.orderDate)} · ${o.paymentMethod || 'UPI'}</div>
        <div style="display:flex;gap:6px;margin-top:12px">${steps.map((s, i) =>
          `<div style="flex:1;text-align:center;font-size:11px;font-weight:600;padding:6px 4px;border-radius:6px;background:${idx >= i ? '#15522E' : '#f3f4f6'};color:${idx >= i ? '#fff' : '#9ca3af'}">${s}</div>`).join('')}
        </div>`;
      toast('Order status: ' + o.status);
    });

    // orders table
    const tbody = $('tbody');
    const panel = $('[data-purpose="orders-panel"]');
    if (tbody && panel) {
      api('/orders').then(res => {
        if (!res.ok) return;
        const orders = res.data.slice(0, 10);
        tbody.innerHTML = orders.map(o => `
          <tr class="hover:bg-[#FCFAF6] transition-colors">
            <td class="py-4 px-4 sm:px-6 font-semibold text-[#15522E]">${o.orderId}</td>
            <td class="py-4 px-4 text-gray-600 whitespace-nowrap">${fmtDate(o.orderDate)}</td>
            <td class="py-4 px-4 font-semibold text-gray-800 whitespace-nowrap">${fmtINR(o.total)}</td>
            <td class="py-4 px-4"><span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium" style="${pillStyle(o.status)}">${o.status}</span>
              <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium" style="${payPillStyle(o.paymentStatus)}" title="Payment status">${o.paymentStatus || 'Paid'}</span></td>
            <td class="py-4 px-4 sm:px-6 text-right whitespace-nowrap"><a class="text-[#15522E] hover:text-[#0E3B20] font-medium hover:underline text-xs as-view" data-id="${o.orderId}" href="#">View Details</a></td>
          </tr>`).join('');
        const note = $$('p, span, div', panel).find(e2 => /Showing last \d+ orders?/i.test(e2.textContent) && e2.children.length === 0);
        if (note) note.textContent = 'Showing last ' + orders.length + ' orders';
      }).catch(() => {});

      tbody.addEventListener('click', e => {
        const a = e.target.closest('.as-view');
        if (!a) return;
        e.preventDefault();
        api('/orders/' + encodeURIComponent(a.dataset.id)).then(r => {
          if (r.ok) openModal('Order ' + r.data.orderId,
            `<p><b>${r.data.customerName}</b> · ${r.data.customerEmail || ''}</p>
             <p>${(r.data.address && [r.data.address.street, r.data.address.city, r.data.address.state, r.data.address.pincode].filter(Boolean).join(', ')) || ''}</p>
             <table style="width:100%;margin-top:10px;font-size:13px;border-collapse:collapse">
             ${(r.data.items || []).map(i => `<tr style="border-bottom:1px solid #eee"><td style="padding:6px 0">${i.name} (${i.weight}) × ${i.qty}</td><td style="text-align:right">${fmtINR(i.price * i.qty)}</td></tr>`).join('')}
             <tr><td style="padding:6px 0"><b>Total</b></td><td style="text-align:right"><b>${fmtINR(r.data.total)}</b></td></tr></table>`,
             null, 'Close');
        });
      });
    }
  }

  function pillStyle(status) {
    const map = {
      Delivered: 'background:#dcfce7;color:#16a34a;border:1px solid #bbf7d0',
      Shipped: 'background:#dbeafe;color:#2563eb;border:1px solid #bfdbfe',
      Processing: 'background:#fef3c7;color:#b45309;border:1px solid #fde68a',
      Cancelled: 'background:#fee2e2;color:#dc2626;border:1px solid #fecaca'
    };
    return map[status] || map.Processing;
  }

  // Phase B: payment status is SEPARATE from order status (same pill visual language)
  function payPillStyle(s) {
    const map = {
      Paid: 'background:#dcfce7;color:#16a34a;border:1px solid #bbf7d0',
      Pending: 'background:#fef3c7;color:#b45309;border:1px solid #fde68a',
      Failed: 'background:#fee2e2;color:#dc2626;border:1px solid #fecaca',
      Cancelled: 'background:#f3f4f6;color:#6b7280;border:1px solid #e5e7eb',
      Refunded: 'background:#dbeafe;color:#2563eb;border:1px solid #bfdbfe'
    };
    return map[s] || 'background:#f3f4f6;color:#6b7280;border:1px solid #e5e7eb';
  }

  // ============================================================
  // 10. AUTH — register (5), login (6), profile (11)
  // ============================================================
  function initRegister() {
    const form = $('form[data-purpose="register-form-card"]') || $$('form').find(f => $('#fullName', f));
    if (!form) return;
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const fullName = $('#fullName').value.trim(), email = $('#email').value.trim(),
        phone = $('#phone').value.trim(), password = $('#password').value,
        confirm = $('#confirmPassword').value, terms = $('#terms');
      if (!fullName) return toast('Full name is required');
      if (!/^\S+@\S+\.\S+$/.test(email)) return toast('Enter a valid email address');
      if (!/^\d{10}$/.test(phone)) return toast('Enter a valid 10-digit phone number');
      if (password.length < 6) return toast('Password must be at least 6 characters');
      if (password !== confirm) return toast('Passwords do not match');
      if (terms && !terms.checked) return toast('Please accept the Terms & Conditions');
      const res = await api('/customers/register', { method: 'POST', body: JSON.stringify({ fullName, email, phone, password }) });
      if (!res.ok) return toast(res.data.error || 'Registration failed');
      store.set('as_user', { id: res.data._id, fullName, email, phone, role: 'customer' });   // phone kept locally for address prefill (display only)
      store.set(cartKey({ id: res.data._id, email }), []);   // §7: NEW customer starts EMPTY — never inherits stale/anonymous/legacy browser cart data
      if (res.data.token) store.set('as_token', res.data.token);
      toast('Account created — welcome, ' + fullName.split(' ')[0] + '!');
      // Step 6/7: honour the saved destination (?redirect=…) or default to
      // the shop; safeRedirect blocks /register|/login so no loops.
      const dest = safeRedirect(new URLSearchParams(location.search).get('redirect')) || '/shop';
      setTimeout(() => location.href = dest, 700);
    });
  }

  function initLogin() {
    const form = $$('form').find(f => $('#email', f) && $('#password', f) && !$('#fullName'));
    if (!form) return;
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const email = $('#email').value.trim(), password = $('#password').value;
      if (!email || !password) return toast('Enter email and password');
      const res = await api('/customers/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      if (!res.ok) return showFormError(form, res.data.error || 'Invalid email or password');
      store.set('as_user', res.data);
      if (res.data.token) store.set('as_token', res.data.token);
      toast('Welcome back, ' + (res.data.fullName || '').split(' ')[0] + '!');
      // Step 4: authed → intended destination (saved via ?redirect=), else /shop;
      // admin still lands on the admin dashboard.
      const dest = res.data.role === 'admin' ? '/admin/dashboard'
        : (safeRedirect(new URLSearchParams(location.search).get('redirect')) || '/shop');
      setTimeout(() => location.href = dest, 500);
    });
    // password visibility toggle already inline
  }

  function showFormError(form, msg) {
    let box = $('.as-form-error', form);
    if (!box) {
      box = document.createElement('div');
      box.className = 'as-form-error';
      box.style.cssText = 'background:#fee2e2;color:#b91c1c;font-size:13px;font-weight:600;padding:9px 12px;border-radius:7px;margin-bottom:10px';
      form.insertBefore(box, form.firstChild);
    }
    box.textContent = msg;
  }

  function initProfile() {
    const u = getUser();
    if (!u) return;
    // Replace static demo identity (Riya Sharma / riya… / +91 9876543210) with
    // THIS user's real record — leaf nodes only, so server-rendered rows (e.g.
    // order tables) are never touched. Also make the Saved-Addresses stat real.
    $$('.text-2xl, .text-3xl, h1, h2, h3, span, p, div').forEach(el => {
      if (el.children.length) return;
      const t = el.textContent.trim();
      if (t === 'Riya Sharma') el.textContent = u.fullName || '';
      else if (t === 'riya.sharma@email.com') el.textContent = u.email || '';
      else if (t === '+91 9876543210') el.textContent = u.phone ? '+91 ' + u.phone : 'No phone saved';
      else if (t === '2 Locations') {
        const a = store.get('as_address', null);
        el.textContent = (a && (!a.uid || a.uid === u.id)) ? '1 Location' : 'No saved address yet';
      }
    });
    $$('input').forEach(inp => {
      if ((inp.value || '').toLowerCase() === 'riya.sharma@email.com') inp.value = u.email;
      if (inp.value === '9876543210') inp.value = u.phone || '';
    });
  }

  // ============================================================
  // 11. ADMIN — login (14), dashboard (15), products (16), customers (17), orders (18)
  // ============================================================
  function initAdminLogin() {
    const form = $('[data-purpose="admin-credentials-form"]') || $$('form').find(f => $('#admin-email', f));
    if (!form) return;
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const email = $('#admin-email').value.trim(), password = $('#admin-password').value;
      const res = await api('/customers/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      if (!res.ok || res.data.role !== 'admin') return showFormError(form, 'Invalid admin credentials. Try admin@aromaspice.com / admin123');
      store.set('as_admin', res.data);
      if (res.data.token) store.set('as_token', res.data.token);
      toast('Admin authenticated');
      location.href = '/admin/dashboard';
    });
  }

  function initAdminDashboard() {
    api('/admin/stats').then(res => {
      if (!res.ok) return;
      const s = res.data;
      const vals = { 'Total Orders': s.totalOrders, 'Total Customers': s.totalCustomers, 'Total Products': s.totalProducts, 'Total Revenue': fmtINR(s.totalRevenue) };
      $$('[data-purpose="stat-card"]').forEach(card => {
        const label = ($$('span', card).find(x => /total/i.test(x.textContent)) || {}).textContent;
        if (label && vals[label.trim()] !== undefined) {
          const big = $('.text-3xl', card);
          if (big) big.textContent = vals[label.trim()];
        }
      });
      const tbody = $('tbody');
      if (tbody && s.recentOrders.length) {
        tbody.innerHTML = s.recentOrders.map(o => `
          <tr class="hover:bg-slate-50/70 transition-colors">
            <td class="py-4 px-6 font-semibold text-slate-900">${o.orderId}</td>
            <td class="py-4 px-6 text-slate-800">${o.customerName}</td>
            <td class="py-4 px-6 text-slate-500 text-xs">${fmtDate(o.orderDate)}</td>
            <td class="py-4 px-6 font-semibold text-slate-900">${fmtINR(o.total)}</td>
            <td class="py-4 px-6 text-center"><span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold" style="${pillStyle(o.status)}">${o.status}</span></td>
          </tr>`).join('');
      }
    }).catch(() => toast('Could not load dashboard stats'));
  }

  // Reports page — same admin stats endpoint, rendered as report cards +
  // a recent-orders table (empty state instead of the design's static rows).
  function initAdminReports() {
    api('/admin/stats').then(res => {
      if (!res.ok) return;
      const s = res.data;
      const vals = { 'Total Orders': s.totalOrders, 'Total Customers': s.totalCustomers, 'Total Products': s.totalProducts, 'Total Revenue': fmtINR(s.totalRevenue) };
      $$('[data-purpose="stat-card"]').forEach(card => {
        const label = ($$('span', card).find(x => /total/i.test(x.textContent)) || {}).textContent;
        if (label && vals[label.trim()] !== undefined) {
          const big = $('.text-3xl', card);
          if (big) big.textContent = vals[label.trim()];
        }
      });
      const tbody = $('tbody');
      if (tbody) {
        const rows = s.recentOrders || [];
        tbody.innerHTML = rows.length ? rows.map(o => `
          <tr class="hover:bg-slate-50/70 transition-colors">
            <td class="py-4 px-6 font-semibold text-slate-900">${o.orderId}</td>
            <td class="py-4 px-6 text-slate-800">${o.customerName}</td>
            <td class="py-4 px-6 text-slate-500 text-xs">${fmtDate(o.orderDate)}</td>
            <td class="py-4 px-6 font-semibold text-slate-900">${fmtINR(o.total)}</td>
            <td class="py-4 px-6 text-center"><span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold" style="${pillStyle(o.status)}">${o.status}</span></td>
          </tr>`).join('')
          : '<tr><td colspan="5" class="py-8 text-center text-sm text-slate-400">No orders yet</td></tr>';
      }
    }).catch(() => toast('Could not load reports'));
  }

  // Settings page — READ-ONLY: shows the real signed-in admin record (from the
  // local admin session) + published store facts. No editable fields = no fake
  // settings behaviour.
  function initAdminSettings() {
    const a = getAdmin();
    if (!a) return;
    const set = (k, v) => { const el = $('[data-purpose="' + k + '"]'); if (el && v) el.textContent = v; };
    set('settings-admin-name', a.fullName || a.name || '');
    set('settings-admin-email', a.email || '');
    set('settings-admin-role', String(a.role || 'admin').toUpperCase());
  }

  // --- Admin profile page (My Profile) -----------------------------------
  function initAdminProfile() {
    const a = getAdmin();
    if (!a) return;
    const set = (k, v) => { const el = $('[data-purpose="' + k + '"]'); if (el && v) el.textContent = v; };
    set('profile-full-name', a.fullName || a.name || '');
    set('profile-email', a.email || '');
    set('profile-role', a.role === 'admin' ? 'Administrator' : String(a.role || 'Administrator'));
  }

  // --- Admin Manager profile dropdown (topbar avatar) --------------------
  function initAdminProfileMenu() {
    const trigger = document.querySelector('[data-purpose="admin-profile"]');
    if (!trigger || document.getElementById('admin-profile-menu')) return;
    if (getComputedStyle(trigger).position === 'static') trigger.style.position = 'relative';
    const a = getAdmin() || {};
    const name = a.fullName || a.name || 'Admin Manager';
    const email = a.email || 'store@aromaspice.com';
    const texts = trigger.querySelectorAll('p');
    if (texts[0]) texts[0].textContent = name;       // live identity, not hardcoded
    if (texts[1]) texts[1].textContent = email;

    const item = (act, icon, label) => '<button type="button" role="menuitem" data-apm="' + act + '" class="w-full text-left px-4 py-2 text-sm text-slate-200 hover:bg-slate-700 focus:bg-slate-700 focus:outline-none flex items-center gap-3"><span>' + icon + '</span><span>' + label + '</span></button>';
    const menu = document.createElement('div');
    menu.id = 'admin-profile-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Admin account menu');
    menu.className = 'absolute right-0 top-full mt-2 z-50 w-[260px] max-w-[calc(100vw-2rem)] rounded-xl border border-slate-700 bg-slate-800 shadow-2xl overflow-hidden text-left opacity-0 invisible transition-all duration-150';
    menu.innerHTML =
      '<div class="px-4 py-3 border-b border-slate-700">' +
        '<p class="text-sm font-semibold text-white truncate"></p>' +
        '<p class="text-xs text-slate-400 truncate"></p>' +
        '<span class="mt-1.5 inline-block rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-emerald-300">Administrator</span>' +
      '</div>' +
      '<div class="py-1">' +
        item('profile', '👤', 'My Profile') +
        item('settings', '⚙️', 'Account Settings') +
        item('password', '🔐', 'Change Password') +
        item('notifications', '🔔', 'Notifications') +
        item('security', '🛡️', 'Security') +
      '</div>' +
      '<div class="py-1 border-t border-slate-700">' +
        '<button type="button" role="menuitem" data-apm="logout" class="w-full text-left px-4 py-2 text-sm text-slate-200 hover:bg-slate-700 focus:bg-slate-700 focus:outline-none flex items-center gap-3"><span>🚪</span><span class="text-rose-300">Logout</span></button>' +
      '</div>';
    menu.querySelector('p').textContent = name;
    menu.querySelectorAll('p')[1].textContent = email;
    trigger.appendChild(menu);

    // live unread badge on the existing 🔔 Notifications item (contact messages)
    const bellItem = menu.querySelector('[data-apm="notifications"]');
    if (bellItem && store.get('as_token', '')) {
      api('/contact').then(r => {
        if (!r.ok) return;
        const msgs = Array.isArray(r.data) ? r.data : [];
        const n = msgs.filter(m => !m.read).length;
        if (!n) return;
        const badge = document.createElement('span');
        badge.textContent = n > 9 ? '9+' : String(n);
        badge.className = 'ml-auto min-w-[18px] px-1 text-center text-[10px] font-bold leading-[18px] rounded-full bg-emerald-500 text-white';
        bellItem.appendChild(badge);
      }).catch(() => {});
    }

    const close = () => { menu.classList.add('opacity-0', 'invisible'); trigger.setAttribute('aria-expanded', 'false'); trigger.style.boxShadow = ''; };
    const open = () => { menu.classList.remove('opacity-0', 'invisible'); trigger.setAttribute('aria-expanded', 'true'); trigger.style.boxShadow = '0 0 0 2px rgba(16,185,129,0.5)'; };
    const toggle = e => { e.stopPropagation(); menu.classList.contains('invisible') ? open() : close(); };

    trigger.addEventListener('click', toggle);
    trigger.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); } });
    menu.addEventListener('click', e => {
      const btn = e.target.closest('[data-apm]');
      if (!btn) return;
      e.stopPropagation();
      const act = btn.getAttribute('data-apm');
      if (act === 'profile') location.href = '/admin/profile';
      else if (act === 'settings' || act === 'security') location.href = '/admin/settings';
      else if (act === 'password') { close(); toast('Password change is not available yet — backend functionality is not implemented.'); }
      else if (act === 'notifications') { close(); openContactNotifications(); }
      else if (act === 'logout') { close(); store.del('as_admin'); store.del('as_token'); location.href = '/admin/login'; }
    });
    document.addEventListener('click', e => { if (!menu.contains(e.target) && !trigger.contains(e.target)) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  }

  // ---- 🔔 Notifications (existing menu item) → customer contact messages ----
  // GET /api/contact (admin-only). Clicking an unread message marks it read (PUT).
  function openContactNotifications() {
    const prev = $('#contact-notif-overlay');
    if (prev) prev.remove();
    const ov = document.createElement('div');
    ov.id = 'contact-notif-overlay';
    ov.className = 'fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8';
    ov.innerHTML =
      '<div class="mt-6 w-full max-w-2xl rounded-2xl bg-white shadow-2xl overflow-hidden" role="dialog" aria-label="Customer messages">' +
        '<div class="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-5 py-4">' +
          '<div>' +
            '<h3 class="text-sm font-bold text-slate-800">🔔 Customer Messages</h3>' +
            '<p class="text-xs text-slate-500" data-cn="count">Loading…</p>' +
          '</div>' +
          '<button type="button" data-cn="close" aria-label="Close notifications" class="rounded-lg px-2.5 py-1.5 text-slate-500 hover:bg-slate-200 hover:text-slate-800 text-sm font-bold">✕</button>' +
        '</div>' +
        '<div class="max-h-[60vh] divide-y divide-slate-100 overflow-y-auto" data-cn="list">' +
          '<div class="p-6 text-sm text-slate-500">Loading messages…</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.addEventListener('click', e => { if (e.target === ov) close(); });
    ov.querySelector('[data-cn="close"]').addEventListener('click', close);
    const esc = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } };
    document.addEventListener('keydown', esc);

    api('/contact').then(r => {
      const list = ov.querySelector('[data-cn="list"]');
      const cnt = ov.querySelector('[data-cn="count"]');
      if (!list) return;                                   // panel already closed
      if (!r.ok) {
        list.innerHTML = '<div class="p-6 text-sm text-rose-600">' +
          (r.status === 401 || r.status === 403 ? 'Admin session required — please login again.' : 'Could not load messages.') + '</div>';
        if (cnt) cnt.textContent = '';
        return;
      }
      const msgs = Array.isArray(r.data) ? r.data : ((r.data && r.data.data) || []);
      const unread = msgs.filter(m => !m.read).length;
      if (cnt) cnt.textContent = msgs.length
        ? msgs.length + ' message' + (msgs.length === 1 ? '' : 's') + (unread ? ' · ' + unread + ' unread' : ' · all read')
        : 'No messages yet';
      if (!msgs.length) {
        list.innerHTML = '<div class="p-6 text-sm text-slate-500">No customer messages yet — visitors can send one from the Contact Us page.</div>';
        return;
      }
      list.innerHTML = msgs.map(m => {
        const isNew = !m.read;
        return '<div data-cn-item data-id="' + m._id + '" data-read="' + (isNew ? '0' : '1') + '"' +
          ' class="p-4 transition hover:bg-slate-50 cursor-pointer' + (isNew ? ' bg-emerald-50/70' : '') + '">' +
          '<div class="flex items-start justify-between gap-3">' +
            '<p class="text-sm font-semibold text-slate-800">' + escapeHtml(m.name || '') +
              ' <span class="font-normal text-slate-500">· ' + escapeHtml(m.topic || 'general') + '</span></p>' +
            '<span class="flex-shrink-0 text-[11px] text-slate-400">' + fmtDate(m.createdAt) + '</span>' +
          '</div>' +
          '<p class="mt-0.5 text-xs text-slate-500">' + escapeHtml(m.email || '') +
            (m.phone ? ' · ' + escapeHtml(m.phone) : '') + '</p>' +
          '<p class="mt-1.5 whitespace-pre-line text-sm text-slate-700">' + escapeHtml(m.message || '') + '</p>' +
          (isNew ? '<span class="cn-new mt-2 inline-block text-[10px] font-bold uppercase tracking-wide text-emerald-600">● New — click to mark read</span>' : '') +
        '</div>';
      }).join('');
      list.querySelectorAll('[data-cn-item]').forEach(el => {
        el.addEventListener('click', () => {
          if (el.getAttribute('data-read') === '1') return;
          api('/contact/' + el.getAttribute('data-id'), { method: 'PUT' }).then(res => {
            if (!res.ok) return;
            el.setAttribute('data-read', '1');
            el.classList.remove('bg-emerald-50/70');
            const chip = el.querySelector('.cn-new');
            if (chip) chip.remove();
            const left = list.querySelectorAll('[data-cn-item][data-read="0"]').length;
            if (cnt) cnt.textContent = msgs.length + ' message' + (msgs.length === 1 ? '' : 's') +
              (left ? ' · ' + left + ' unread' : ' · all read');
          });
        });
      });
    }).catch(() => {
      const list = ov.querySelector('[data-cn="list"]');
      if (list) list.innerHTML = '<div class="p-6 text-sm text-rose-600">Network error — please try again.</div>';
    });
  }

  function initAdminProducts() {
    const tbody = $('#products-table tbody') || $('tbody');
    if (!tbody) return;
    function load() {
      api('/products').then(res => {
        if (!res.ok) return;
        tbody.innerHTML = res.data.map(p => `
          <tr class="hover:bg-slate-50/70 transition-colors" data-purpose="product-row">
            <td class="py-4 px-6 font-medium text-slate-900 whitespace-nowrap">${p.name}</td>
            <td class="py-4 px-6 text-slate-600">${p.category}</td>
            <td class="py-4 px-6 font-medium text-slate-800">${fmtINR(p.price)}</td>
            <td class="py-4 px-6 text-slate-700">${p.stock}</td>
            <td class="py-4 px-6"><span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${p.active ? 'bg-emerald-50 text-emerald-700 border border-emerald-200/60' : 'bg-rose-50 text-rose-600 border border-rose-200/60'}">${p.active ? 'Active' : 'Inactive'}</span></td>
            <td class="py-4 px-6"><div class="flex items-center justify-center gap-3">
              <button class="text-slate-500 hover:text-slate-800 p-1 rounded hover:bg-slate-100 as-edit" data-id="${p._id}" title="Edit Product" type="button">✏️</button>
              <button class="text-rose-500 hover:text-rose-700 p-1 rounded hover:bg-rose-50 as-del" data-id="${p._id}" title="Delete Product" type="button">🗑️</button>
            </div></td>
          </tr>`).join('');
      });
    }
    load();
    tbody.addEventListener('click', async e => {
      const del = e.target.closest('.as-del');
      const ed = e.target.closest('.as-edit');
      if (del) {
        if (!confirm('Delete this product?')) return;
        await api('/products/' + del.dataset.id, { method: 'DELETE' });
        toast('Product deleted'); load();
      }
      if (ed) {
        const list = await api('/products');
        const p = list.data.find(x => x._id === ed.dataset.id);
        if (!p) return;
        openModal('Edit Product', productFormHTML(p), async vals => {
          await api('/products/' + p._id, { method: 'PUT', body: JSON.stringify(vals) });
          toast('Product updated'); load();
        });
      }
    });
    const addBtn = $('[data-purpose="add-product-button"]');
    if (addBtn) addBtn.addEventListener('click', () => {
      openModal('Add New Product', productFormHTML(), async vals => {
        await api('/products', { method: 'POST', body: JSON.stringify(vals) });
        toast('Product added'); load();
      });
    });
  }

  function productFormHTML(p) {
    p = p || {};
    const cats = ['Single Masala', 'Blended Masala', 'Combo Pack', 'Special Masala', 'Pepper & Powders'];
    return `
      <label>Product Name<input name="name" value="${p.name || ''}" required style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;margin-top:4px"></label>
      <label>Category<select name="category" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;margin-top:4px">
        ${cats.map(c => `<option ${p.category === c ? 'selected' : ''}>${c}</option>`).join('')}
      </select></label>
      <div style="display:flex;gap:10px">
        <label style="flex:1">Price ₹<input name="price" type="number" min="0" value="${p.price || ''}" required style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;margin-top:4px"></label>
        <label style="flex:1">Stock<input name="stock" type="number" min="0" value="${p.stock != null ? p.stock : ''}" required style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;margin-top:4px"></label>
      </div>
      <div style="display:flex;gap:10px">
        <label style="flex:1">MRP ₹<input name="mrp" type="number" min="0" value="${p.mrp || ''}" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;margin-top:4px"></label>
        <label style="flex:1">Weight<input name="weight" value="${p.weight || '200g'}" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;margin-top:4px"></label>
      </div>`;
  }

  function initAdminCustomers() {
    const tbody = $('tbody');
    if (!tbody) return;
    let orders = [];
    function load() {
      Promise.all([api('/customers'), api('/orders')]).then(([cRes, oRes]) => {
        if (oRes.ok) orders = oRes.data;
        if (!cRes.ok) return;
        tbody.innerHTML = cRes.data.filter(c => c.role !== 'admin').map(c => {
          const n = orders.filter(o => o.customerEmail === c.email).length;
          return `
          <tr class="hover:bg-gray-50/50 transition-colors">
            <td class="py-3.5 px-4 font-medium text-gray-900">${c.fullName}</td>
            <td class="py-3.5 px-4 text-gray-500">${c.email}</td>
            <td class="py-3.5 px-4 text-gray-500">${c.phone || '—'}</td>
            <td class="py-3.5 px-4 text-center font-medium">${n}</td>
            <td class="py-3.5 px-4 text-gray-500">${fmtDate(c.createdAt)}</td>
            <td class="py-3.5 px-4 text-center"><div class="inline-flex items-center justify-center gap-3 text-gray-400">
              <button class="hover:text-blue-600 transition-colors as-view" data-id="${c._id}" title="View Details" type="button">👁️</button>
              <button class="hover:text-amber-600 transition-colors as-edit" data-id="${c._id}" title="Edit Customer" type="button">✏️</button>
              <button class="hover:text-red-600 transition-colors as-del" data-id="${c._id}" title="Delete Customer" type="button">🗑️</button>
            </div></td>
          </tr>`;
        }).join('');
      });
    }
    load();
    tbody.addEventListener('click', async e => {
      const del = e.target.closest('.as-del'), ed = e.target.closest('.as-edit'), vw = e.target.closest('.as-view');
      if (del) {
        if (!confirm('Delete this customer?')) return;
        await api('/customers/' + del.dataset.id, { method: 'DELETE' });
        toast('Customer deleted'); load();
      }
      if (ed || vw) {
        const list = await api('/customers');
        const c = list.data.find(x => x._id === (ed || vw).dataset.id);
        if (!c) return;
        if (vw) {
          const n = orders.filter(o => o.customerEmail === c.email);
          openModal(c.fullName,
            `<p>${c.email} · ${c.phone || ''}</p><p>Reward points: ${c.rewardPts || 0}</p>
             <p style="margin-top:8px"><b>Orders (${n.length})</b></p>
             ${n.map(o => `<div style="font-size:13px;padding:4px 0;border-bottom:1px solid #eee">${o.orderId} — ${o.status} — ${fmtINR(o.total)}</div>`).join('') || '<p style="font-size:13px;color:#888">No orders yet</p>'}`,
            null, 'Close');
        } else {
          openModal('Edit Customer', `
            <label>Full Name<input name="fullName" value="${c.fullName}" required style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;margin-top:4px"></label>
            <label>Email<input name="email" value="${c.email}" required style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;margin-top:4px"></label>
            <label>Phone<input name="phone" value="${c.phone || ''}" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;margin-top:4px"></label>`,
            async vals => {
              await api('/customers/' + c._id, { method: 'PUT', body: JSON.stringify(vals) });
              toast('Customer updated'); load();
            });
        }
      }
    });
    // add customer button if present in header
    $$('button').forEach(b => {
      if (/add customer/i.test(b.textContent) && !b.dataset.asWired) {
        b.dataset.asWired = '1';
        b.addEventListener('click', () => {
          openModal('Add New Customer', `
            <label>Full Name<input name="fullName" required style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;margin-top:4px"></label>
            <label>Email<input name="email" type="email" required style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;margin-top:4px"></label>
            <label>Phone<input name="phone" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;margin-top:4px"></label>
            <label>Password<input name="password" type="password" value="demo123" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;margin-top:4px"></label>`,
            async vals => {
              const r = await api('/customers/register', { method: 'POST', body: JSON.stringify(vals) });
              toast(r.ok ? 'Customer added' : (r.data.error || 'Failed')); load();
            });
        });
      }
    });
  }

  function initAdminOrders() {
    const tbody = $('tbody');
    if (!tbody) return;
    function load() {
      api('/orders').then(res => {
        if (!res.ok) return;
        tbody.innerHTML = res.data.map(o => `
          <tr class="hover:bg-gray-50/80 transition-colors">
            <td class="py-3.5 px-4 font-medium text-gray-700">${o.orderId}</td>
            <td class="py-3.5 px-4 text-gray-600">${o.customerName}</td>
            <td class="py-3.5 px-4 text-gray-500">${fmtDate(o.orderDate)}</td>
            <td class="py-3.5 px-4 text-gray-700 font-medium">${fmtINR(o.total)}</td>
            <td class="py-3.5 px-4"><span class="inline-block px-2.5 py-0.5 text-[11px] font-medium" style="${pillStyle(o.status)}">${o.status}</span>
              <span class="inline-block px-2 py-0.5 text-[10px] font-medium" style="${payPillStyle(o.paymentStatus)}" title="Payment status">${o.paymentStatus || 'Paid'}</span></td>
            <td class="py-3.5 px-4 text-center"><div class="flex items-center justify-center gap-3 text-gray-400">
              <button class="hover:text-blue-600 transition-colors as-view" data-id="${o.orderId}" title="View Details" type="button">👁️</button>
              <button class="hover:text-amber-600 transition-colors as-edit" data-id="${o.orderId}" title="Edit Order" type="button">✏️</button>
              <button class="hover:text-rose-600 transition-colors as-del" data-id="${o.orderId}" title="Delete Order" type="button">🗑️</button>
            </div></td>
          </tr>`).join('');
      });
    }
    load();
    tbody.addEventListener('click', async e => {
      const del = e.target.closest('.as-del'), ed = e.target.closest('.as-edit'), vw = e.target.closest('.as-view');
      if (del) {
        if (!confirm('Delete order ' + del.dataset.id + '?')) return;
        await api('/orders/' + encodeURIComponent(del.dataset.id), { method: 'DELETE' });
        toast('Order deleted'); load();
      }
      if (ed || vw) {
        const r = await api('/orders/' + encodeURIComponent((ed || vw).dataset.id));
        if (!r.ok) return toast('Order not found');
        const o = r.data;
        if (vw) {
          openModal('Order ' + o.orderId,
            `<p><b>${o.customerName}</b> · ${o.customerEmail || ''}</p>
             <p style="font-size:13px;color:#666">${(o.address && [o.address.street, o.address.city, o.address.state, o.address.pincode].filter(Boolean).join(', ')) || ''}</p>
             <table style="width:100%;margin-top:10px;font-size:13px;border-collapse:collapse">
             ${(o.items || []).map(i => `<tr style="border-bottom:1px solid #eee"><td style="padding:6px 0">${i.name} (${i.weight}) × ${i.qty}</td><td style="text-align:right">${fmtINR(i.price * i.qty)}</td></tr>`).join('')}
             <tr><td style="padding:6px 0"><b>Total</b></td><td style="text-align:right"><b>${fmtINR(o.total)}</b></td></tr></table>`,
            null, 'Close');
        } else {
          openModal('Update Order ' + o.orderId, `
            <label>Status
              <select name="status" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;margin-top:4px">
                ${['Processing', 'Shipped', 'Delivered', 'Cancelled'].map(s => `<option ${o.status === s ? 'selected' : ''}>${s}</option>`).join('')}
              </select></label>`,
            async vals => {
              await api('/orders/' + encodeURIComponent(o.orderId), { method: 'PUT', body: JSON.stringify(vals) });
              toast('Order status → ' + vals.status); load();
            });
        }
      }
    });
  }

  // ---------- generic modal ----------
  function openModal(title, fieldsHTML, onSave, saveLabel) {
    const old = $('#as-modal'); if (old) old.remove();
    const overlay = document.createElement('div');
    overlay.id = 'as-modal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:12px;max-width:440px;width:100%;padding:22px;font:14px/1.5 system-ui,sans-serif;box-shadow:0 25px 50px rgba(0,0,0,.3)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <h3 style="margin:0;font-size:17px;font-weight:700;color:#181d1a">${title}</h3>
          <button id="as-modal-x" style="background:none;border:none;font-size:20px;cursor:pointer;color:#666">✕</button>
        </div>
        <form id="as-modal-form" style="display:flex;flex-direction:column;gap:12px">${fieldsHTML}
          <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:6px">
            <button type="button" id="as-modal-cancel" style="padding:9px 16px;border:1px solid #d1d5db;background:#fff;border-radius:7px;cursor:pointer;font-weight:600">Cancel</button>
            ${onSave ? '<button type="submit" style="padding:9px 18px;border:none;background:#1b4d29;color:#fff;border-radius:7px;cursor:pointer;font-weight:700">' + (saveLabel || 'Save') + '</button>'
                     : '<button type="button" id="as-modal-close2" style="padding:9px 18px;border:none;background:#1b4d29;color:#fff;border-radius:7px;cursor:pointer;font-weight:700">Close</button>'}
          </div>
        </form>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    $('#as-modal-x', overlay).onclick = close;
    $('#as-modal-cancel', overlay).onclick = close;
    const c2 = $('#as-modal-close2', overlay); if (c2) c2.onclick = close;
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    const form = $('#as-modal-form', overlay);
    if (onSave) form.addEventListener('submit', e => {
      e.preventDefault();
      const vals = {};
      $$('input, select, textarea', form).forEach(i => { vals[i.name] = i.value; });
      onSave(vals);
      close();
    });
  }

  // ============================================================
  // BOOT
  // ============================================================
  // ============================================================
  // HEADER OFFSET — keep page content clear of the fixed header.
  // The static pt-36 (=144px) matches desktop only; below 1024px the
  // announcement bar wraps and the header grows (212-256px at 360).
  // Never shrinks below 144 → desktop layout stays byte-identical.
  // Pages without a fixed header (login/register/payment/admin) are skipped.
  // ============================================================
  function syncHeaderOffset() {
    var hdr = document.querySelector('header');
    if (!hdr || getComputedStyle(hdr).position !== 'fixed') return;
    // offset carrier: <main class="pt-36"> (home family) or <body class="pt-36">
    // (transplanted pages: cart/checkout/confirmation/profile/order-history/about/
    //  register/login/payment) — whichever the page actually uses.
    var main = document.querySelector('main');
    var el = (main && main.classList.contains('pt-36')) ? main
           : (document.body.classList.contains('pt-36')) ? document.body : null;
    if (!el) return;
    // Floor 116 (was 144): with the announcement bar removed the fixed
    // header is ~118px tall, so a 144 floor left a ~26px dead gap under
    // the header. The floor only guards against a too-short measurement;
    // when the header wraps taller (mobile), its real height still wins.
    var target = Math.max(116, Math.round(hdr.getBoundingClientRect().height)) + 'px';
    if (el.style.paddingTop !== target) el.style.paddingTop = target;
  }

  function boot() {
    // Step 9 — frontend route-level gate for session-required pages.
    // (Server JWT middleware on their APIs is the real security boundary.)
    if (!onAdmin && !isAuthed() && LOAD_GATED_PATHS.indexOf(path) !== -1) {
      location.replace('/register?redirect=' + encodeURIComponent(path + location.search));
      return;
    }
    wireRouting();
    wireSearchForms();
    initializeAuthState();
    syncHeaderOffset();
    wireProductCards();
    wireAuthGate();
    updateBadges();
    updateWishlistHearts();

    if (path === '/' || path === '/home') { /* home: cards + links only */ }
    else if (path === '/shop') initShop();
    else if (path === '/search') initSearch();
    else if (path === '/wishlist') initWishlist();
    else if (path === '/product') initProductDetails();
    else if (path === '/register') initRegister();
    else if (path === '/login') initLogin();
    else if (path === '/cart') initCartPage();
    else if (path === '/checkout') initCheckout();
    else if (path === '/payment') initPayment();
    else if (path === '/order-confirmation') initConfirmation();
    else if (path === '/profile') initProfile();
    else if (path === '/order-history') initOrderHistory();
    else if (path === '/admin/login') initAdminLogin();
    else if (path === '/admin' || path === '/admin/dashboard') initAdminDashboard();
    else if (path === '/admin/products') initAdminProducts();
    else if (path === '/admin/customers') initAdminCustomers();
    else if (path === '/admin/orders') initAdminOrders();
    else if (path === '/admin/reports') initAdminReports();
    else if (path === '/admin/settings') initAdminSettings();
    else if (path === '/admin/profile') initAdminProfile();

    // Admin Manager profile dropdown — real account control on every admin page
    if (onAdmin && path !== '/admin/login') initAdminProfileMenu();

    // guard admin pages softly: bounce to admin login if never authenticated
    if (onAdmin && path !== '/admin/login' && !getAdmin()) {
      // allow direct viewing but ensure login link works — no hard redirect for demo ease
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  // web fonts can re-wrap the announcement bar after boot; keep offset in sync
  window.addEventListener('load', syncHeaderOffset);
  var offsetTimer;
  window.addEventListener('resize', function () {
    clearTimeout(offsetTimer);
    offsetTimer = setTimeout(syncHeaderOffset, 100);
  });
})();
