// ============================================================
// AromaSpice E-Commerce — Node.js + Express.js + MongoDB
// MCA Project: stitch_aromaspice_e_commerce_ui_system
// ============================================================
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const payGateway = require('./payment-gateway');   // Phase B: razorpay | sandbox adapter

const app = express();
const PORT = process.env.PORT || 3000;
// NOTE: the default `aromaspice` DB already holds data from another app
// (different schema), so this project uses its own DB and leaves the old one untouched.
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/aromaspice_ui_system';

// ---------- Auth config (B-11) ----------
// JWT secret comes from the environment (.env). If absent (fresh clone),
// fall back to an ephemeral random secret so dev still works — sessions
// then invalidate on restart, and a warning is logged (secret never printed).
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET not set — using ephemeral dev secret (logins reset on restart). Copy .env.example → .env.');
}
const JWT_EXPIRES = process.env.JWT_EXPIRES || '12h';
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '';

// ---------- Middleware ----------
// Production security headers (helmet). CSP is tailored to the design pages:
// Tailwind CDN + unpkg icons + Google Fonts/cdnjs styles, inline scripts
// (15/18 pages) and inline onclick/onsubmit handlers, data: & lh3 images.
// Everything NOT allow-listed (foreign script hosts, objects, cross-frame) is blocked.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com', 'https://unpkg.com', 'https://checkout.razorpay.com', 'https://cdn.razorpay.com'],
      'script-src-attr': ["'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
      'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com', 'https://unpkg.com'],
      'img-src': ["'self'", 'data:', 'https:'],
      // Phase B/C: checkout.js (parent) + risk-detection bundle (cdn) must reach the gateway API
      'connect-src': ["'self'", 'https://api.razorpay.com', 'https://cdn.razorpay.com', 'https://lumberjack.razorpay.com'],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'self'"],
      // Phase B: Razorpay checkout modal (iframe) — only allowed hosts, nothing else
      'frame-src': ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com']
    }
  }
}));
app.use(cors(FRONTEND_ORIGIN ? { origin: FRONTEND_ORIGIN } : {}));
// rawBody kept for webhook HMAC verification (payment-gateway signs the exact bytes)
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = Buffer.from(buf); } }));
app.use(express.urlencoded({ extended: true }));
// Dev-truth: revalidate every time (ETag → cheap 304) so JS/CSS/HTML edits take
// effect immediately. Without this, browsers heuristically cache responses and
// keep running a STALE app.js (seen: old routing rules still firing).
const NO_CACHE = { 'Cache-Control': 'no-cache, must-revalidate' };
app.use('/public', express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => { for (const [k, v] of Object.entries(NO_CACHE)) res.setHeader(k, v); }
}));

// ---------- DEPLOYMENT: health probe (Phase E) ----------
// Deliberately exposes nothing but liveness — no DB status, no config, no secrets.
app.get('/health', (_req, res) => res.json({ ok: true, service: 'aromaspice-api' }));

// ---------- QA helpers (bug fixes B-01..B-06, B-09, B-10) ----------
// Map mongoose/dup errors to correct HTTP status codes instead of blanket 500
function apiError(res, e) {
  if (e && e.name === 'CastError')       return res.status(400).json({ error: 'Invalid ID format' });
  if (e && e.name === 'ValidationError') return res.status(400).json({ error: Object.values(e.errors || {}).map(v => v.message).join('; ') || 'Validation failed' });
  if (e && e.code === 11000)             return res.status(409).json({ error: 'Duplicate value: ' + JSON.stringify(e.keyValue || {}) });
  // 500s: log server-side, return a generic message (no internals/paths to clients)
  console.error('API error:', e && e.message);
  return res.status(500).json({ error: 'Internal server error' });
}
// Escape user input used inside $regex (prevents malformed-regex 500s)
const escapeRegex = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Never return password hashes/plain passwords to clients
function sanitizeCustomer(c) {
  const o = c && typeof c.toObject === 'function' ? c.toObject() : Object.assign({}, c);
  delete o.password;
  return o;
}
// Collision-proof order ID (#AS + 9 digits) with retry on duplicate key.
// Replaces count-based IDs (B-01) which broke order creation after any deletion.
async function createOrderIdDoc(payload) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const orderId = '#AS' + Math.floor(100000000 + Math.random() * 900000000);
    try { return await Order.create(Object.assign({}, payload, { orderId })); }
    catch (e) { if (e && e.code === 11000 && attempt < 7) continue; throw e; }
  }
}

// ---------- Phase-A: stock restoration (cancel/delete) ----------
// RULE (documented): stock is restored AT MOST ONCE per order, and only for
// orders that actually reserved stock at creation (stockReserved=true).
// Historical seed orders never decremented stock, so cancelling/deleting them
// does not inflate inventory. The atomic check-and-set on stockRestored makes
// double-cancel / cancel-then-delete impossible to double-credit.
async function restoreStockOnce(order) {
  if (!order.stockReserved) return false;                 // never reserved → nothing to restore
  const marked = await Order.updateOne(
    { _id: order._id, stockRestored: { $ne: true } },
    { $set: { stockRestored: true } }
  );
  if (marked.modifiedCount === 0) return false;           // already restored (second cancel = no-op)
  for (const i of order.items) {
    const qty = Number(i.qty);
    const prod = i.productId
      ? await Product.findById(i.productId)
      : await Product.findOne({ name: i.name, weight: i.weight });
    if (prod) await Product.updateOne({ _id: prod._id }, { $inc: { stock: qty } });
    // product deleted → nothing to restore into (quantity intentionally dropped)
  }
  return true;
}

// Inverse operation: leaving 'Cancelled' re-reserves the stock (atomic guard,
// full rollback on failure → status change rejected so inventory never drifts).
async function reReserveStock(order) {
  if (!order.stockRestored) return { ok: true };          // stock was never returned
  const done = [];
  try {
    for (const i of order.items) {
      const qty = Number(i.qty);
      const prod = i.productId
        ? await Product.findById(i.productId)
        : await Product.findOne({ name: i.name, weight: i.weight });
      if (!prod) throw new Error('product-missing');
      const r = await Product.updateOne({ _id: prod._id, stock: { $gte: qty } }, { $inc: { stock: -qty } });
      if (r.modifiedCount === 0) throw new Error('insufficient');
      done.push({ prod, qty });
    }
  } catch (e) {
    for (const d of done) await Product.updateOne({ _id: d.prod._id }, { $inc: { stock: d.qty } });
    return {
      ok: false,
      error: e.message === 'product-missing'
        ? 'Cannot reactivate order: a product from it no longer exists'
        : 'Cannot reactivate order: insufficient stock'
    };
  }
  await Order.updateOne({ _id: order._id }, { $set: { stockRestored: false } });
  return { ok: true };
}

// ---------- Phase A/B SHARED: validate cart + server-authoritative pricing ----------
// Used by BOTH POST /api/orders (legacy direct) and POST /api/payments/create
// (Phase B gateway checkout) so pricing can never diverge between the two.
// Returns { error } (HTTP-ready message) or { resolved, snapshotItems, subtotal, discount, shipping, total, coupon }.

// Discount is COUPON-GATED: no automatic percentage. A discount exists only
// when the client sends a code from this whitelist (keep in sync with the
// client-side VALID_COUPONS in public/js/app.js — the server always wins).
const VALID_COUPONS = { SAVESPICE: 0.05 };   // code → rate

async function validateAndPrice(b) {
  // B-06: minimal server-side order validation (prevents empty junk orders)
  if (!Array.isArray(b.items) || b.items.length === 0) {
    return { error: 'Order must contain at least one item' };
  }
  // PHASE-A: SERVER-AUTHORITATIVE PRICING — client price/subtotal/discount/
  // shipping/total are ACCEPTED but IGNORED; every amount derives from MongoDB.
  const resolved = [];        // { prod, qty } for stock reservation
  const snapshotItems = [];   // price snapshot persisted on the order
  let subtotal = 0;
  for (const i of b.items) {
    const qty = Number(i.qty);
    if (!Number.isInteger(qty) || qty < 1) {
      return { error: 'Each item needs an integer qty >= 1' };
    }
    const prod = i.productId
      ? await Product.findById(i.productId)
      : await Product.findOne({ name: i.name, weight: i.weight });
    if (!prod) return { error: 'Product not available: ' + (i.name || 'unknown') };
    if (prod.stock < qty) {
      return { error: 'Insufficient stock for ' + prod.name + ' (available: ' + prod.stock + ')' };
    }
    const unitPrice = prod.price;           // authoritative price
    const lineTotal = unitPrice * qty;
    subtotal += lineTotal;
    resolved.push({ prod, qty });
    snapshotItems.push({ productId: prod._id, name: prod.name, weight: prod.weight, qty, price: unitPrice, lineTotal });
  }
  // COUPON-GATED discount (was: automatic floor 5%): only a VALID coupon code
  // earns a discount; unknown/absent code ⇒ discount 0. Free shipping per design.
  const couponCode = b.coupon ? String(b.coupon).trim().toUpperCase() : '';
  const rate = VALID_COUPONS[couponCode] || 0;
  const discount = rate && subtotal ? Math.floor(subtotal * rate) : 0;
  const shipping = 0;
  const total = subtotal - discount + shipping;
  return { resolved, snapshotItems, subtotal, discount, shipping, total, coupon: rate ? couponCode : '' };
}

// ---------- Phase A/B SHARED: create order doc + atomic stock reservation ----------
// Rolls back everything (decrements + the doc) if any stock guard fails.
// Throws Error('STOCK_UNAVAILABLE') after full rollback.
async function createOrderWithStock(fields, resolved) {
  const order = await createOrderIdDoc(fields);
  const done = [];
  try {
    for (const { prod, qty } of resolved) {
      const r = await Product.updateOne({ _id: prod._id, stock: { $gte: qty } }, { $inc: { stock: -qty } });
      if (r.modifiedCount === 0) throw new Error('stock-guard-failed');
      done.push({ prod, qty });
    }
  } catch (e) {
    for (const { prod, qty } of done) await Product.updateOne({ _id: prod._id }, { $inc: { stock: qty } });
    await Order.deleteOne({ _id: order._id });
    throw new Error('STOCK_UNAVAILABLE');
  }
  return order;
}

// ---------- Auth helpers (B-11: JWT + bcrypt + role middleware) ----------
// Kept inside server.js (not a middleware/ folder) to preserve the
// intentionally monolithic architecture of this project.
const hashPassword = pw => bcrypt.hash(String(pw), 10);

function signToken(c) {
  return jwt.sign(
    { id: String(c._id), email: c.email, role: c.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function bearerToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// Require a valid JWT — 401 if missing/invalid/expired
function authenticateToken(req, res, next) {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const p = jwt.verify(token, JWT_SECRET);
    req.user = { id: p.id, email: p.email, role: p.role };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Require req.user.role === 'admin' (runs after authenticateToken)
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// Attach req.user when a valid token is present, otherwise continue anonymously.
// Used by public-tracking endpoints (order lookup by unguessable ID).
function optionalAuth(req, _res, next) {
  const token = bearerToken(req);
  if (token) {
    try { const p = jwt.verify(token, JWT_SECRET); req.user = { id: p.id, email: p.email, role: p.role }; }
    catch (e) { /* invalid token → treat as anonymous */ }
  }
  next();
}

// ---------- Rate limiting for auth endpoints (production hardening) ----------
// In-memory sliding window per IP. Login counts ONLY failed attempts, so normal
// dev/test logins never trip the limit. Single-instance: for a multi-instance
// production deploy, move the counter to Redis (see report).
function rateLimit({ windowMs, max, failedOnly, label }) {
  const hits = new Map();   // ip -> [timestamps of counted attempts]
  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const key = label + '|' + ip;
    let arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) {
      const retryAfter = Math.ceil((windowMs - (now - arr[0])) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many attempts. Please try again in ' + retryAfter + ' seconds.' });
    }
    const record = () => {
      const a = (hits.get(key) || []).filter(t => Date.now() - t < windowMs);
      a.push(Date.now());
      hits.set(key, a);
    };
    if (failedOnly) {
      res.on('finish', () => { if (res.statusCode >= 400) record(); });
    } else {
      record();
    }
    // opportunistic prune so the map can't grow unbounded
    if (hits.size > 2000) {
      for (const [k, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(k);
    }
    next();
  };
}
const loginLimiter    = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, failedOnly: true,  label: 'login' });
const registerLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, failedOnly: false, label: 'reg' });
const contactLimiter   = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, failedOnly: false, label: 'contact' });

// ---------- MongoDB Connection ----------
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))   // URI not logged (may contain credentials in prod)
  .catch(err => console.error('❌ MongoDB connection error:', err.message));

// ============================================================
// SCHEMAS & MODELS
// ============================================================

// --- Product ---
const productSchema = new mongoose.Schema({
  name:         { type: String, required: true },
  category:     { type: String, required: true },   // Single Masala | Blended Masala | Combo Pack | Special Masala | Pepper & Powders
  description:  { type: String, default: '' },
  price:        { type: Number, required: true },
  mrp:          { type: Number, default: 0 },
  stock:        { type: Number, default: 0 },
  weight:       { type: String, default: '200g' },
  rating:       { type: Number, default: 0 },
  image:        { type: String, default: '' },
  active:       { type: Boolean, default: true },
  createdAt:    { type: Date, default: Date.now }
});
const Product = mongoose.model('Product', productSchema);

// --- Customer / User ---
const customerSchema = new mongoose.Schema({
  fullName:   { type: String, required: true },
  email:      { type: String, required: true, unique: true },
  phone:      { type: String, default: '' },
  password:   { type: String, default: '', select: false },   // bcrypt hash — never selected/returned by default
  addresses:  [{ label: String, street: String, area: String, city: String, state: String, pincode: String }],
  rewardPts:  { type: Number, default: 0 },
  role:       { type: String, enum: ['customer', 'admin'], default: 'customer' },
  createdAt:  { type: Date, default: Date.now }
});
const Customer = mongoose.model('Customer', customerSchema);

// --- Order ---
const orderItemSchema = new mongoose.Schema({
  productId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  name:       String,     // product name SNAPSHOT at purchase time
  weight:     String,
  qty:        Number,
  price:      Number,     // authoritative unit price SNAPSHOT (MongoDB price at order time)
  lineTotal:  Number      // server-computed price * qty
});

const orderSchema = new mongoose.Schema({
  orderId:      { type: String, required: true, unique: true },   // #AS987654321
  customer:     { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  customerName: String,
  customerEmail:String,
  items:        [orderItemSchema],
  subtotal:     Number,
  shipping:     { type: Number, default: 0 },
  discount:     { type: Number, default: 0 },
  coupon:       { type: String, default: '' },   // valid coupon code that earned the discount (if any)
  total:        Number,
  status:       { type: String, enum: ['Processing','Shipped','Delivered','Cancelled'], default: 'Processing' },
  paymentMethod:{ type: String, default: 'UPI' },
  address:      { street: String, area: String, city: String, state: String, pincode: String },
  // Phase-A stock bookkeeping: reserved = stock decremented at creation;
  // restored = stock returned at most once (cancel/delete guard)
  stockReserved:{ type: Boolean, default: false },
  stockRestored:{ type: Boolean, default: false },
  // ---- Phase B: payment state (SEPARATE from order status) ----
  // paymentStatus: Pending → Paid | Failed | Cancelled (Refunded reserved, not wired)
  // default 'Paid': orders created via the legacy direct API (admin/seed/tests)
  // are settled-without-gateway; gateway checkouts always set 'Pending' explicitly.
  paymentStatus: { type: String, enum: ['Pending','Paid','Failed','Cancelled','Refunded'], default: 'Paid' },
  paymentGateway:{ type: String, default: 'direct' },   // razorpay | sandbox | cod | direct
  gatewayOrderId:  { type: String, default: '', index: true },
  gatewayPaymentId:{ type: String, default: '' },
  paymentVerifiedAt: Date,
  idempotencyKey:  { type: String, unique: true, sparse: true },  // one order per checkout attempt
  orderDate:    { type: Date, default: Date.now }
});
const Order = mongoose.model('Order', orderSchema);

// ---- Contact-page messages (admin reads them via the topbar 🔔 Notifications) ----
const contactMessageSchema = new mongoose.Schema({
  name:    { type: String, required: true, trim: true, maxlength: 120 },
  email:   { type: String, required: true, trim: true, maxlength: 200 },
  phone:   { type: String, trim: true, maxlength: 30, default: '' },
  topic:   { type: String, trim: true, maxlength: 60, default: 'order' },
  message: { type: String, required: true, trim: true, maxlength: 3000 },
  read:    { type: Boolean, default: false }
}, { timestamps: true });
const ContactMessage = mongoose.model('ContactMessage', contactMessageSchema);

// ============================================================
// SEED — insert demo data only once
// ============================================================
async function seed() {
  const count = await Product.countDocuments();
  if (count > 0) return;

  const products = [
    { name:'Turmeric Powder',      category:'Single Masala',   price:149, mrp:179, stock:120, weight:'200g', rating:4.8 },
    { name:'Chilli Powder',        category:'Single Masala',   price:159, mrp:219, stock:80,  weight:'200g', rating:4.9 },
    { name:'Coriander Powder',     category:'Single Masala',   price:139, mrp:169, stock:90,  weight:'200g', rating:4.6 },
    { name:'Rasam Powder',         category:'Blended Masala',  price:129, mrp:159, stock:65,  weight:'200g', rating:4.7 },
    { name:'Sambar Powder',        category:'Blended Masala',  price:149, mrp:179, stock:72,  weight:'200g', rating:4.8 },
    { name:'Garam Masala',         category:'Blended Masala',  price:199, mrp:249, stock:70,  weight:'100g', rating:5.0 },
    { name:'Black Pepper Powder',  category:'Pepper & Powders',price:199, mrp:239, stock:55,  weight:'100g', rating:4.7 },
    { name:'Chat Masala',          category:'Special Masala',  price:129, mrp:159, stock:60,  weight:'100g', rating:4.8 },
    { name:'Aroma Combo Pack',     category:'Combo Pack',      price:499, mrp:649, stock:50,  weight:'Pack of 4', rating:5.0 }
  ];
  await Product.insertMany(products);

  const customers = [
    { fullName:'Riya Sharma',  email:'riya.sharma@email.com',  phone:'9876543210', rewardPts:250, password:'demo123' },
    { fullName:'Arjun Patel',  email:'arjun.patel@email.com',  phone:'9876501234', rewardPts:120, password:'demo123' },
    { fullName:'Neha Verma',   email:'neha.verma@email.com',   phone:'9876512345', rewardPts:80,  password:'demo123' },
    { fullName:'Karan Singh',  email:'karan.singh@email.com',  phone:'9876523456', rewardPts:200, password:'demo123' },
    { fullName:'Pooja Mehta',  email:'pooja.mehta@email.com',  phone:'9876534567', rewardPts:60,  password:'demo123' },
    { fullName:'Admin Manager',email:'admin@aromaspice.com',   phone:'9876500000', rewardPts:0,   password:'admin123', role:'admin' }
  ];
  for (const c of customers) c.password = await hashPassword(c.password);   // B-11: never seed plain text
  const custDocs = await Customer.insertMany(customers);

  const orders = [
    { orderId:'#AS987654321', customer:custDocs[0]._id, customerName:'Riya Sharma', items:[{name:'Chilli Powder',weight:'200g',qty:1,price:159},{name:'Turmeric Powder',weight:'200g',qty:1,price:149},{name:'Garam Masala',weight:'100g',qty:1,price:179}], subtotal:487, discount:24, total:463, status:'Delivered',    orderDate:new Date('2024-05-20') },
    { orderId:'#AS986543210', customer:custDocs[1]._id, customerName:'Arjun Patel', items:[{name:'Sambar Powder',weight:'200g',qty:1,price:149},{name:'Rasam Powder',weight:'200g',qty:1,price:129}], subtotal:349, discount:0, total:349, status:'Shipped',      orderDate:new Date('2024-05-20') },
    { orderId:'#AS985432109', customer:custDocs[2]._id, customerName:'Neha Verma',  items:[{name:'Aroma Combo Pack',weight:'Pack of 4',qty:1,price:499}], subtotal:599, discount:0, total:599, status:'Processing',   orderDate:new Date('2024-05-19') },
    { orderId:'#AS984321098', customer:custDocs[3]._id, customerName:'Karan Singh', items:[{name:'Chat Masala',weight:'100g',qty:1,price:129},{name:'Black Pepper Powder',weight:'100g',qty:1,price:199}], subtotal:249, discount:0, total:249, status:'Cancelled',    orderDate:new Date('2024-05-18') },
    { orderId:'#AS983210987', customer:custDocs[4]._id, customerName:'Pooja Mehta', items:[{name:'Turmeric Powder',weight:'200g',qty:1,price:149}], subtotal:199, discount:0, total:199, status:'Delivered',    orderDate:new Date('2024-05-17') }
  ];
  await Order.insertMany(orders);

  console.log('🌱 Seed data inserted (9 products, 6 customers incl. admin, 5 orders)');
}

// One-time startup migration: hash any legacy plain-text passwords already
// in the DB (demo accounts keep working — their stored value is just re-hashed).
async function migratePlainPasswords() {
  try {
    const all = await Customer.find({}).select('+password');
    let n = 0;
    for (const c of all) {
      if (c.password && !c.password.startsWith('$2')) {
        c.password = await hashPassword(c.password);
        await c.save();
        n++;
      }
    }
    if (n) console.log(`🔐 Migrated ${n} plain-text password(s) to bcrypt`);
  } catch (e) {
    console.error('Password migration failed:', e.message);
  }
}
seed().then(migratePlainPasswords);

// ============================================================
// API ROUTES (JSON — consumed by page JS)
// ============================================================

// ---- Products API ----
app.get('/api/products', async (req, res) => {
  try {
    const filter = {};
    if (req.query.category) filter.category = req.query.category;
    if (req.query.q) filter.name = { $regex: escapeRegex(req.query.q), $options: 'i' };
    let sort = {};
    if (req.query.sort === 'price-low')  sort = { price: 1 };
    if (req.query.sort === 'price-high') sort = { price: -1 };
    if (req.query.sort === 'rating')     sort = { rating: -1 };
    const products = await Product.find(filter).sort(sort);
    res.json(products);
  } catch (e) { apiError(res, e); }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const p = await Product.findById(req.params.id);
    if (!p) return res.status(404).json({ error: 'Product not found' });
    res.json(p);
  } catch (e) { apiError(res, e); }
});

app.post('/api/products', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    if (body.price !== undefined && !(Number(body.price) > 0)) {
      return res.status(400).json({ error: 'Price must be a positive number' });
    }
    if (body.stock !== undefined && Number(body.stock) < 0) {
      return res.status(400).json({ error: 'Stock cannot be negative' });
    }
    const p = await Product.create(body);
    res.status(201).json(p);
  } catch (e) { apiError(res, e); }
});

app.put('/api/products/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const p = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!p) return res.status(404).json({ error: 'Product not found' });
    res.json(p);
  } catch (e) { apiError(res, e); }
});

app.delete('/api/products/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const r = await Product.findByIdAndDelete(req.params.id);
    if (!r) return res.status(404).json({ error: 'Product not found' });
    res.json({ success: true });
  } catch (e) { apiError(res, e); }
});

// ---- Customers API ----
app.get('/api/customers', authenticateToken, requireAdmin, async (_req, res) => {
  try { res.json(await Customer.find().select('-password').sort({ createdAt: -1 })); }
  catch (e) { apiError(res, e); }
});

app.post('/api/customers/register', registerLimiter, async (req, res) => {
  try {
    // B-03: whitelist fields — role can never be set via public register (mass-assignment fix)
    const { fullName, email, phone, password } = req.body || {};
    if (!fullName || !email || !password) {
      return res.status(400).json({ error: 'Full name, email and password are required' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const exists = await Customer.findOne({ email });
    if (exists) return res.status(400).json({ error: 'Email already registered' });
    // B-11: store bcrypt hash, never plain text; role forced to customer (B-03)
    const c = await Customer.create({ fullName, email, phone: phone || '', password: await hashPassword(password), role: 'customer' });
    res.status(201).json(Object.assign(sanitizeCustomer(c), { token: signToken(c) }));
  } catch (e) { apiError(res, e); }
});

app.post('/api/customers/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const c = await Customer.findOne({ email }).select('+password');
    // B-11: same generic 401 for unknown email / wrong password (no user enumeration)
    if (!c || !c.password) return res.status(401).json({ error: 'Invalid email or password' });
    const isHash = c.password.startsWith('$2');
    const match = isHash
      ? await bcrypt.compare(String(password), c.password)
      : c.password === String(password);   // legacy plain-text (pre-migration) fallback
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });
    if (!isHash) {                          // lazy upgrade: rehash on successful login
      try { c.password = await hashPassword(password); await c.save(); } catch (e) { /* non-fatal */ }
    }
    res.json({ id: c._id, fullName: c.fullName, email: c.email, role: c.role, token: signToken(c) });
  } catch (e) { apiError(res, e); }
});

app.put('/api/customers/:id', authenticateToken, async (req, res) => {
  try {
    // B-11: only the owner (JWT id) or an admin may update; role/password never accepted
    if (req.user.role !== 'admin' && String(req.user.id) !== String(req.params.id)) {
      return res.status(403).json({ error: 'You can only edit your own profile' });
    }
    const body = Object.assign({}, req.body || {});
    delete body.role; delete body.password;
    const c = await Customer.findByIdAndUpdate(req.params.id, body, { new: true, runValidators: true }).select('-password');
    if (!c) return res.status(404).json({ error: 'Customer not found' });
    res.json(c);
  } catch (e) { apiError(res, e); }
});

app.delete('/api/customers/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const r = await Customer.findByIdAndDelete(req.params.id);
    if (!r) return res.status(404).json({ error: 'Customer not found' });
    res.json({ success: true });
  } catch (e) { apiError(res, e); }
});

// ---- Orders API ----
app.get('/api/orders', authenticateToken, async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.user.role === 'admin') {
      // admin sees everything (client ?customerEmail= is never trusted)
    } else {
      // B-11: scope strictly to the JWT identity — other customers' orders are unreachable
      filter.$or = [{ customer: req.user.id }, { customerEmail: req.user.email }];
    }
    const orders = await Order.find(filter).sort({ orderDate: -1 });
    res.json(orders);
  } catch (e) { apiError(res, e); }
});

app.get('/api/orders/:orderId', optionalAuth, async (req, res) => {
  try {
    const o = await Order.findOne({ orderId: req.params.orderId });
    if (!o) return res.status(404).json({ error: 'Order not found' });
    // Logged-in customers may only fetch their own order; admins any;
    // anonymous lookup stays allowed (public Track Order form, unguessable #AS id)
    if (req.user && req.user.role !== 'admin') {
      const owns = (o.customer && String(o.customer) === String(req.user.id)) ||
                   (o.customerEmail && o.customerEmail === req.user.email);
      if (!owns) return res.status(403).json({ error: 'You do not have access to this order' });
    }
    res.json(o);
  } catch (e) { apiError(res, e); }
});

app.post('/api/orders', optionalAuth, async (req, res) => {
  try {
    const b = req.body || {};
    // Shared Phase-A validate + server-authoritative pricing (see validateAndPrice)
    const priced = await validateAndPrice(b);
    if (priced.error) return res.status(400).json({ error: priced.error });
    // B-01: collision-proof order ID; B-11: identity from JWT when present
    let order;
    try {
      order = await createOrderWithStock({
        customer: req.user ? req.user.id : (b.customer || null),
        customerName: b.customerName || 'Guest',
        customerEmail: req.user ? req.user.email : (b.customerEmail || ''),
        items: priced.snapshotItems,
        subtotal: priced.subtotal,
        shipping: priced.shipping,
        discount: priced.discount,
        coupon: priced.coupon,
        total: priced.total,
        paymentMethod: b.paymentMethod || 'UPI',
        address: b.address || {},
        status: 'Processing',
        stockReserved: true            // atomic decrement inside; rolled back on failure
      }, priced.resolved);
    } catch (e) {
      if (e.message === 'STOCK_UNAVAILABLE') {
        return res.status(400).json({ error: 'Insufficient stock (availability changed while ordering) — please retry' });
      }
      throw e;
    }
    res.status(201).json(order);
  } catch (e) { apiError(res, e); }
});

// Update order status (admin)
// STATUS STOCK RULE (Phase-A, statuses unchanged):
//   * entering 'Cancelled'      → restore stock ONCE (at-most-once guard)
//   * leaving  'Cancelled'      → re-reserve stock (rejected with 400 if impossible)
//   * Processing/Shipped/Delivered transitions → no stock effect
//   * same-status update        → no-op (no double restore possible)
app.put('/api/orders/:orderId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // B-04: validate status against enum before persisting
    const allowed = ['Processing', 'Shipped', 'Delivered', 'Cancelled'];
    if (!allowed.includes(req.body.status)) {
      return res.status(400).json({ error: 'Invalid status. Allowed: ' + allowed.join(', ') });
    }
    const o = await Order.findOne({ orderId: req.params.orderId });
    if (!o) return res.status(404).json({ error: 'Order not found' });
    if (o.status !== req.body.status) {
      if (req.body.status === 'Cancelled') {
        await restoreStockOnce(o);                       // no-op if already restored / never reserved
      } else if (o.status === 'Cancelled') {
        const r = await reReserveStock(o);               // un-cancel: take the stock back
        if (!r.ok) return res.status(400).json({ error: r.error });
      }
      // Phase B: COD payment is collected on delivery → settle it when delivered
      // (payment status is derived from the event, never from the client)
      if (req.body.status === 'Delivered' && o.paymentStatus === 'Pending' && o.paymentGateway === 'cod') {
        o.paymentStatus = 'Paid';
        o.paymentVerifiedAt = new Date();
      }
      o.status = req.body.status;
      await o.save();
      // reload: restoreStockOnce/reReserveStock updated stockRestored directly
      // in the DB, so the in-memory doc above would be stale in the response
      const fresh = await Order.findOne({ orderId: req.params.orderId });
      return res.json(fresh);
    }
    res.json(o);
  } catch (e) { apiError(res, e); }
});

app.delete('/api/orders/:orderId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const o = await Order.findOne({ orderId: req.params.orderId });
    if (!o) return res.status(404).json({ error: 'Order not found' });
    // restore first (at-most-once; skipped if the order was already cancelled/restored)
    await restoreStockOnce(o);
    await Order.deleteOne({ _id: o._id });
    res.json({ success: true });
  } catch (e) { apiError(res, e); }
});

// ============================================================
// PHASE B: PAYMENTS (TEST/SANDBOX MODE — see payment-gateway.js)
// EXACT TRANSACTION FLOW (documented before implementation):
//  1. Client  POST /api/payments/create {items, address, paymentMethod, idempotencyKey}
//  2. Server  Phase-A validate + authoritative pricing → idempotency replay check
//            → create Order (paymentStatus=Pending, status=Processing, stockReserved)
//              with ATOMIC stock reservation (full rollback on guard failure)
//            → create gateway order (amount = server total × 100 paise)
//            → return safe init info only (no secrets; keyId is publishable)
//  3. Client  opens gateway checkout (Razorpay modal | sandbox auto-complete)
//  4. Client  POST /api/payments/verify {gatewayOrderId, paymentId, signature}
//            server RECOMPUTES the HMAC signature, fetches the payment FROM the
//            gateway, verifies amount/currency/order → Paid (idempotent) or
//            Failed/Cancelled (+ stock released exactly once)
//  5. Webhook POST /api/payments/webhook (signed raw body) = non-browser source
//            of truth → same markPaid/unpaid helpers, fully idempotent
// STOCK: reserved ONLY at create. Paid → reservation kept. Failed/Cancelled/
//  expired → restoreStockOnce (Phase-A at-most-once guard). A later order
//  status=Cancelled is then a no-op restore. Verified payments never release stock.
// ============================================================
const PAY_PENDING_TTL_MIN = Number(process.env.PAYMENT_PENDING_TTL_MIN || 30);

function sendPaymentInit(order, httpStatus, res) {
  const init = {
    gateway: order.paymentGateway,                         // razorpay | sandbox | cod
    mode: order.paymentGateway === 'cod' ? 'cod' : payGateway.MODE,
    internalOrderId: order.orderId,
    gatewayOrderId: order.gatewayOrderId || null,
    keyId: payGateway.MODE === 'razorpay' ? payGateway.keyId() : null,  // publishable only
    amount: Math.round(order.total * 100),                 // paise — server-authoritative
    currency: 'INR',
    paymentStatus: order.paymentStatus
  };
  if (order.paymentGateway === 'cod') init.order = order;  // COD needs no gateway round-trip
  return res.status(httpStatus).json(init);
}

// Idempotent "settled" transition — callable from verify AND webhook any number of times.
async function markOrderPaid(order, paymentId) {
  if (order.paymentStatus === 'Paid') return order;        // repeat callback → no-op
  if (order.stockRestored && order.stockReserved) {
    // paid AFTER stock was released (failed-then-paid race): money is captured,
    // so try to take the reservation back; if impossible, log loudly for ops.
    const r = await reReserveStock(order);
    if (!r.ok) console.error('CRITICAL: payment captured but stock re-reserve failed for ' + order.orderId + ': ' + r.error);
  }
  order.paymentStatus = 'Paid';
  if (paymentId) order.gatewayPaymentId = paymentId;
  order.paymentVerifiedAt = new Date();
  await order.save();
  return order;
}
// Idempotent "unsettled" transition: Failed | Cancelled → release stock at most once.
async function markOrderUnpaid(order, paymentId, status) {
  if (order.paymentStatus === 'Paid') return order;        // paid wins — never demote, never restore
  if (order.paymentStatus !== status) {
    order.paymentStatus = status;
    if (paymentId) order.gatewayPaymentId = paymentId;
    await order.save();
  }
  await restoreStockOnce(order);                           // no-op when already restored
  return order;
}

// ---- 1. CREATE checkout attempt (idempotent) ----
app.post('/api/payments/create', optionalAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const idem = typeof b.idempotencyKey === 'string' ? b.idempotencyKey.trim() : '';
    if (idem.length < 8 || idem.length > 128) {
      return res.status(400).json({ error: 'idempotencyKey (8-128 chars) is required' });
    }
    // IDEMPOTENCY: same checkout attempt → same order, no second reservation
    const existing = await Order.findOne({ idempotencyKey: idem });
    if (existing) return sendPaymentInit(existing, 200, res);

    const priced = await validateAndPrice(b);              // Phase-A authoritative pricing
    if (priced.error) return res.status(400).json({ error: priced.error });

    const method = String(b.paymentMethod || 'UPI').toUpperCase();
    const isCod = method === 'COD';
    let order;
    try {
      order = await createOrderWithStock({
        customer: req.user ? req.user.id : (b.customer || null),
        customerName: b.customerName || 'Guest',
        customerEmail: req.user ? req.user.email : (b.customerEmail || ''),
        items: priced.snapshotItems,
        subtotal: priced.subtotal,
        shipping: priced.shipping,
        discount: priced.discount,
        coupon: priced.coupon,
        total: priced.total,
        paymentMethod: method,
        address: b.address || {},
        status: 'Processing',
        paymentStatus: 'Pending',                          // NOT paid until gateway confirms
        paymentGateway: isCod ? 'cod' : (payGateway.MODE === 'razorpay' ? 'razorpay' : 'sandbox'),
        idempotencyKey: idem,
        stockReserved: true
      }, priced.resolved);
    } catch (e) {
      if (e.message === 'STOCK_UNAVAILABLE') {
        return res.status(400).json({ error: 'Insufficient stock (availability changed while ordering) — please retry' });
      }
      // parallel duplicate lost the unique idempotencyKey race → return the winner's result
      if (e && e.code === 11000 && e.keyValue && 'idempotencyKey' in e.keyValue) {
        let win = await Order.findOne({ idempotencyKey: idem });
        for (let i = 0; i < 12 && win && !win.gatewayOrderId && win.paymentGateway !== 'cod'; i++) {
          await new Promise(r => setTimeout(r, 150));
          win = await Order.findOne({ idempotencyKey: idem });
        }
        if (win) return sendPaymentInit(win, 200, res);
        return res.status(409).json({ error: 'Duplicate checkout in progress — retry' });
      }
      throw e;
    }
    if (isCod) return sendPaymentInit(order, 201, res);     // no gateway for COD

    let g;
    try {
      g = await payGateway.createGatewayOrder({
        amountPaise: Math.round(order.total * 100),        // authoritative amount
        currency: 'INR', receipt: order.orderId, internalOrderId: order.orderId
      });
    } catch (e) {
      // gateway unreachable → don't hold stock hostage; roll this attempt back entirely
      await restoreStockOnce(order);
      await Order.deleteOne({ _id: order._id });
      return res.status(502).json({ error: 'Payment gateway unavailable — please retry' });
    }
    order.gatewayOrderId = g.id;
    await order.save();
    return sendPaymentInit(order, 201, res);
  } catch (e) { apiError(res, e); }
});

// ---- 2. VERIFY browser callback (never trusts the frontend) ----
app.post('/api/payments/verify', async (req, res) => {
  try {
    const { gatewayOrderId, paymentId, signature } = req.body || {};
    if (!gatewayOrderId || !paymentId || !signature) {
      return res.status(400).json({ error: 'gatewayOrderId, paymentId and signature are required' });
    }
    const order = await Order.findOne({ gatewayOrderId });
    if (!order) return res.status(404).json({ error: 'Unknown gateway order' });
    // (a) signature recomputed server-side — client cannot forge it
    if (!payGateway.verifyCheckoutSignature(gatewayOrderId, paymentId, signature)) {
      return res.status(400).json({ error: 'Invalid payment signature' });   // NO state change
    }
    // (b) payment fetched FROM THE GATEWAY — amount/currency/status verified there
    let gp;
    try { gp = await payGateway.fetchGatewayPayment(paymentId); }
    catch (e) { return res.status(502).json({ error: 'Payment verification unavailable — retry or wait for webhook' }); }
    if (!gp || gp.order_id !== gatewayOrderId) {
      return res.status(400).json({ error: 'Payment does not belong to this order' });  // NO state change
    }
    const expected = Math.round(order.total * 100);
    if (gp.currency !== 'INR' || Number(gp.amount) !== expected) {
      await markOrderUnpaid(order, paymentId, 'Failed');    // untrusted amount → release stock once
      return res.status(400).json({ error: 'Payment amount/currency mismatch' });
    }
    if (gp.status === 'captured') { await markOrderPaid(order, paymentId); return res.json(order); }
    if (gp.status === 'failed')    { await markOrderUnpaid(order, paymentId, 'Failed');    return res.status(400).json({ error: 'Payment failed' }); }
    if (gp.status === 'cancelled'){ await markOrderUnpaid(order, paymentId, 'Cancelled'); return res.status(400).json({ error: 'Payment cancelled' }); }
    return res.status(400).json({ error: 'Payment not captured yet — wait for confirmation' }); // authorized: no state change
  } catch (e) { apiError(res, e); }
});

// ---- 3. WEBHOOK (signed raw body) — browser is never the only source of truth ----
app.post('/api/payments/webhook', async (req, res) => {
  try {
    const sig = req.get('x-razorpay-signature') || '';
    const raw = req.rawBody;
    if (!raw || !sig || !payGateway.verifyWebhookSignature(raw, sig)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
    let evt;
    try { evt = JSON.parse(raw.toString('utf8')); }
    catch (e) { return res.status(400).json({ error: 'Invalid webhook payload' }); }
    const ev = String((evt && evt.event) || '');
    const ent = (evt && evt.payload && evt.payload.payment && evt.payload.payment.entity) || {};
    const gwOrderId = ent.order_id, payId = ent.id;
    if (!gwOrderId || !payId) return res.json({ received: true, ignored: true });
    const order = await Order.findOne({ gatewayOrderId: gwOrderId });
    if (!order) { console.warn('Webhook for unknown gateway order:', gwOrderId); return res.json({ received: true, ignored: true }); }
    if (/failed/i.test(ev)) {
      await markOrderUnpaid(order, payId, 'Failed');
    } else if (/^(payment\.captured|order\.paid)$/.test(ev)) {
      const expected = Math.round(order.total * 100);
      if (ent.currency === 'INR' && Number(ent.amount) === expected) {
        await markOrderPaid(order, payId);                  // idempotent
      } else {
        console.error('Webhook amount mismatch for ' + order.orderId + ' — releasing stock');
        await markOrderUnpaid(order, payId, 'Failed');
      }
    }
    // any other event (refund.*) → acknowledge without state change
    res.json({ received: true });
  } catch (e) { apiError(res, e); }
});

// ---- 4. SANDBOX-ONLY payment completion (404 in razorpay mode) ----
app.post('/api/payments/mock/complete', async (req, res) => {
  if (payGateway.MODE !== 'sandbox') return res.status(404).json({ error: 'Not found' });
  try {
    const b = req.body || {};
    if (!b.gatewayOrderId) return res.status(400).json({ error: 'gatewayOrderId required' });
    res.json(payGateway.sandboxComplete({ gatewayOrderId: b.gatewayOrderId, outcome: b.outcome, amount: b.amount }));
  } catch (e) {
    if (e.code === 'NO_GATEWAY_ORDER') return res.status(404).json({ error: 'Unknown gateway order' });
    apiError(res, e);
  }
});

// ---- 5. Payment status by unguessable order id (same trust model as Track Order) ----
app.get('/api/payments/:orderId/status', async (req, res) => {
  try {
    const o = await Order.findOne({ orderId: req.params.orderId });
    if (!o) return res.status(404).json({ error: 'Order not found' });
    res.json({
      orderId: o.orderId, orderStatus: o.status,
      paymentStatus: o.paymentStatus, paymentGateway: o.paymentGateway,
      gatewayOrderId: o.gatewayOrderId || null, paid: o.paymentStatus === 'Paid'
    });
  } catch (e) { apiError(res, e); }
});

// ---- 6. Expired-pending release: stock must never be held forever ----
async function releaseExpiredPendingPayments() {
  const cutoff = new Date(Date.now() - PAY_PENDING_TTL_MIN * 60000);
  const stale = await Order.find({ paymentStatus: 'Pending', gatewayOrderId: { $ne: '' }, orderDate: { $lt: cutoff } });
  for (const o of stale) {
    await markOrderUnpaid(o, o.gatewayPaymentId, 'Cancelled');
    console.log('💳 Released expired pending payment ' + o.orderId + ' (stock restored once)');
  }
  return stale.length;
}
// admin-triggered sweep (also used by tests / ops tooling)
app.post('/api/payments/sweep', authenticateToken, requireAdmin, async (_req, res) => {
  try { res.json({ released: await releaseExpiredPendingPayments() }); } catch (e) { apiError(res, e); }
});
setInterval(() => {
  releaseExpiredPendingPayments().catch(e => console.error('payment sweep error:', e.message));
}, Math.max(30000, Number(process.env.PAYMENT_SWEEP_MS || 300000))).unref();

// ---- Admin stats for dashboard ----
app.get('/api/admin/stats', authenticateToken, requireAdmin, async (_req, res) => {
  try {
    const totalOrders = await Order.countDocuments();
    const totalCustomers = await Customer.countDocuments();
    const totalProducts = await Product.countDocuments();
    const revenueAgg = await Order.aggregate([
      { $group: { _id: null, revenue: { $sum: '$total' } } }
    ]);
    const totalRevenue = revenueAgg.length ? revenueAgg[0].revenue : 0;
    const recentOrders = await Order.find().sort({ orderDate: -1 }).limit(5);
    res.json({ totalOrders, totalCustomers, totalProducts, totalRevenue, recentOrders });
  } catch (e) { apiError(res, e); }
});

// ---- Contact messages API ----
// POST is public (the contact page), GET/PUT are admin-only.
app.post('/api/contact', contactLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim(), email = String(b.email || '').trim(), message = String(b.message || '').trim();
    if (!name || !email || !message) return res.status(400).json({ error: 'Name, email and message are required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address' });
    const doc = await ContactMessage.create({
      name, email, message,
      phone: String(b.phone || '').trim().slice(0, 30),
      topic: String(b.topic || 'order').trim().slice(0, 60)
    });
    res.status(201).json(doc);
  } catch (e) { apiError(res, e); }
});

app.get('/api/contact', authenticateToken, requireAdmin, async (_req, res) => {
  try {
    res.json(await ContactMessage.find().sort({ createdAt: -1 }).limit(50));
  } catch (e) { apiError(res, e); }
});

app.put('/api/contact/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const m = await ContactMessage.findByIdAndUpdate(req.params.id, { read: true }, { new: true, runValidators: true });
    if (!m) return res.status(404).json({ error: 'Message not found' });
    res.json(m);
  } catch (e) { apiError(res, e); }
});

// ============================================================
// HTML PAGE ROUTES — one per screen (originals untouched)
// ============================================================
const SCREENS = [
  { route: '/',                            file: '1._home_page/code.html' },
  { route: '/home',                        file: '1._home_page/code.html' },
  { route: '/shop',                        file: '2._products_shop_page/code.html' },
  { route: '/product',                     file: '3._product_details_page/code.html' },
  { route: '/search',                      file: '4._search_filter_page/code.html' },
  { route: '/register',                    file: '5._register_page/code.html' },
  { route: '/login',                       file: '6._login_page/code.html' },
  { route: '/cart',                        file: '7._cart_page/code.html' },
  { route: '/checkout',                    file: '8._checkout_page/code.html' },
  { route: '/payment',                     file: '9._payment_page/code.html' },
  { route: '/order-confirmation',          file: '10._order_confirmation_page/code.html' },
  { route: '/profile',                     file: '11._customer_profile_page/code.html' },
  { route: '/order-history',               file: '12._order_history_tracking_page/code.html' },
  { route: '/about',                       file: '13._about_us_page/code.html' },
  { route: '/contact',                     file: '23._contact_us_page/code.html' },
  { route: '/privacy',                     file: '24._privacy_policy_page/code.html' },
  { route: '/terms',                       file: '25._terms_of_service_page/code.html' },
  { route: '/returns',                     file: '26._return_refund_policy_page/code.html' },
  { route: '/wishlist',                    file: '19._wishlist_page/code.html' },
  { route: '/admin/login',                 file: '14._admin_login_page/code.html' },
  { route: '/admin',                       file: '15._admin_dashboard/code.html' },
  { route: '/admin/dashboard',             file: '15._admin_dashboard/code.html' },
  { route: '/admin/products',              file: '16._admin_product_management/code.html' },
  { route: '/admin/customers',             file: '17._admin_customer_management/code.html' },
  { route: '/admin/orders',                file: '18._admin_order_management/code.html' },
  { route: '/admin/reports',               file: '20._admin_reports/code.html' },
  { route: '/admin/settings',              file: '21._admin_settings/code.html' },
  { route: '/admin/profile',               file: '22._admin_profile/code.html' }
];

// Original code.html files are read and served with a shared runtime
// script appended before </body>. Files on disk are NEVER modified.
const RUNTIME_TAG = '<script src="/public/js/app.js"></script>';

// B-07: the hotlinked Google avatar URL is rate-limited (HTTP 429 → browser
// blocks it as ORB) so the header shows a broken image on every page.
// Swap it for a local inline-SVG avatar at serve time (design files untouched).
const DEAD_AVATAR = 'https://lh3.googleusercontent.com/aida/AEtjO1Un9x8CHR_-p-CIgmaBKkaPyMph2iSd5AhpOqf1jwrYYwPbD-hrhLoaGlek1w-YJmy676HGivMA7_GmqATGmcdbzOwrKGg2pIWcZryZDf1Zm1Z2F-8J05_TonA2NSO48NzGXl-96wrmb_cGYLQfjPmxOmuOws4Ak26XQM0oChFh-F47qFtYNh3G4aTnYqUFa4KHQ-n6rSbm6F3JSLWvPNS8_TIkaghURpjO8vb_WO3-puebtETUHyIY2tTUX-_lE2pObRu727WE-A';
const AVATAR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="#e5e9e4"/><circle cx="20" cy="15.5" r="6.5" fill="#717970"/><path d="M7.5 35c1.8-6.8 7.2-10 12.5-10s10.7 3.2 12.5 10" fill="#717970"/></svg>';
const SAFE_AVATAR = 'data:image/svg+xml,' + encodeURIComponent(AVATAR_SVG);

SCREENS.forEach(({ route, file }) => {
  app.get(route, (req, res) => {
    for (const [k, v] of Object.entries(NO_CACHE)) res.setHeader(k, v);
    const filePath = path.join(__dirname, file);
    fs.readFile(filePath, 'utf8', (err, html) => {
      if (err) return res.status(404).send('Screen not found: ' + file);
      html = html.split(DEAD_AVATAR).join(SAFE_AVATAR);
      if (html.indexOf('</body>') !== -1) html = html.replace('</body>', RUNTIME_TAG + '</body>');
      else html += RUNTIME_TAG;
      res.type('html').send(html);
    });
  });
});

// Favicon: inline SVG (previously /favicon.ico → 404 console error on every visit)
app.get('/favicon.ico', (_req, res) => {
  res.type('image/svg+xml').send(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#8b1d1d"/><text x="16" y="23" font-size="20" text-anchor="middle" fill="#ffffff" font-family="Georgia,serif">A</text></svg>'
  );
});

// ============================================================
// GLOBAL ERROR HANDLER — production-safe (no stack traces to clients)
// Catches malformed JSON (entity.parse.failed → 400) and anything else
// that slips past route try/catch (→ generic 500 JSON, details logged here).
// ============================================================
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  console.error('Unhandled error:', err && err.message);
  res.status((err && err.status) || 500).json({ error: 'Internal server error' });
});

// ============================================================
// START
// ============================================================
// PORT comes from the environment (deployment-required); bind 0.0.0.0 so the
// hosting provider's port-forwarding/routing can reach the process.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 AromaSpice server running → http://localhost:${PORT}`);
  console.log('📄 Screen routes:');
  SCREENS.forEach(s => console.log(`   ${s.route.padEnd(24)} → ${s.file}`));
});
