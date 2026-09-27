// api/checkout.js
// Creates a ToroPay order server-side so the secret API key is never exposed to the browser.
//
// The client sends only WHICH sets it wants (id + quantity). Prices are looked up here,
// in this file, so a tampered request cannot change what the customer is charged.
//
// The page falls back to the public payment link if this endpoint is unreachable,
// so a booking is never blocked by a failure here.
//
// Env vars (set in Vercel -> Project -> Settings -> Environment Variables):
//   TP_SECRET_KEY  (required) ToroPay API key. Server-only. Never put this in any HTML file.
//   TP_MODE        optional   'test' (default) or 'live'
//   TP_API_BASE    optional   default 'https://staging.toropay.co.in'
//   TP_DEPOSIT_AMOUNT
//                  optional   default 0. When 0, the customer pays the full
//                             order total. Set e.g. 500 to charge a deposit instead.

const crypto = require('crypto');

const API_BASE = (process.env.TP_API_BASE || 'https://staging.toropay.co.in').replace(/\/+$/, '');
const MODE = process.env.TP_MODE || 'test';
const DEPOSIT = Number(process.env.TP_DEPOSIT_AMOUNT === undefined ? 0 : process.env.TP_DEPOSIT_AMOUNT);
const MAX_QTY_PER_SET = 20;
const MAX_SETS = 25;

// Single source of truth for pricing. Keep in sync with the prices shown on the page.
const CATALOG = {};
for (let n = 1; n <= 14; n++) {
  const id = String(n).padStart(2, '0');
  CATALOG[id] = { id, name: 'Set ' + id, price: n <= 5 ? 1499 : n <= 10 ? 1899 : 2299 };
}

const rateLimit = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const hits = (rateLimit.get(ip) || []).filter(t => now - t < windowMs);
  if (hits.length >= 20) return true;
  hits.push(now);
  rateLimit.set(ip, hits);
  if (rateLimit.size > 5000) rateLimit.clear();
  return false;
}

function clean(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const key = process.env.TP_SECRET_KEY;
  if (!key) {
    return res.status(503).json({ error: 'Payments not configured yet' });
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Too many attempts, please try again shortly' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const customer = body.customer || {};
  const name = clean(customer.name, 120);
  const email = clean(customer.email, 160);
  const contact = clean(customer.contact, 120);
  const date = clean(customer.date, 40);
  const notes = clean(customer.notes, 500);

  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required for the payment receipt' });
  }

  const rawSets = Array.isArray(body.sets) ? body.sets : [];
  if (!rawSets.length) return res.status(400).json({ error: 'Your bag is empty' });
  if (rawSets.length > MAX_SETS) return res.status(400).json({ error: 'Too many sets in one order' });

  const sets = [];
  let orderTotal = 0;
  for (const entry of rawSets) {
    const item = CATALOG[String(entry && entry.id)];
    if (!item) return res.status(400).json({ error: 'Unknown set' });
    const qty = Number(entry.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_SET) {
      return res.status(400).json({ error: 'Invalid quantity' });
    }
    sets.push({ id: item.id, name: item.name, price: item.price, qty });
    orderTotal += item.price * qty;
  }

  const setCount = sets.reduce((sum, s) => sum + s.qty, 0);
  const summary = sets.map(s => s.name + (s.qty > 1 ? ' x' + s.qty : '')).join(', ');

  // Charge the deposit by default; charge the full total if TP_DEPOSIT_AMOUNT is 0.
  const chargeTotal = DEPOSIT > 0 ? DEPOSIT : orderTotal;
  const items = DEPOSIT > 0
    ? [{ name: 'Booking deposit (' + setCount + ' set' + (setCount === 1 ? '' : 's') + ') - ' + summary, quantity: 1, unit_price: DEPOSIT }]
    : sets.map(s => ({ name: s.name, quantity: s.qty, unit_price: s.price }));

  const reference = 'MBN-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();

  try {
    const upstream = await fetch(API_BASE + '/api/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
        'x-toropay-mode': MODE,
      },
      body: JSON.stringify({
        merchant_order_reference: reference,
        customer: { name: name, email: email },
        items,
        idempotency_key: reference,
      }),
    });

    const text = await upstream.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (e) {
      data = {};
    }

    if (!upstream.ok) {
      const detail = clean(data.message || data.error || text, 200);
      console.error('toropay error', upstream.status, detail);
      return res.status(502).json({ error: 'Could not start payment', detail: detail });
    }

    const checkoutUrl = data.checkout_url || data.payment_url || (data.data && (data.data.checkout_url || data.data.payment_url));
    if (!checkoutUrl) {
      console.error('toropay response had no checkout_url', text.slice(0, 300));
      return res.status(502).json({ error: 'Payment link missing from response' });
    }

    return res.status(200).json({
      checkout_url: checkoutUrl,
      reference: reference,
      charge: chargeTotal,
      order_total: orderTotal,
      deposit: DEPOSIT,
      balance: DEPOSIT > 0 ? Math.max(0, orderTotal - DEPOSIT) : 0,
      sets: summary,
    });
  } catch (err) {
    console.error('toropay request failed', err && err.message);
    return res.status(502).json({ error: 'Could not reach the payment provider' });
  }
};
