// ============================================================================
// TrueHealthic — Whop <-> Shopify checkout bridge  (the "Lasso-style" engine)
// ----------------------------------------------------------------------------
// What it does:
//   1) /checkout/create  — storefront calls this with the live Shopify cart.
//      It creates a Whop checkout for the EXACT cart total, turns on shipping-
//      address collection + your billing descriptor, and stashes the cart's
//      line items in metadata. Returns a Whop checkout URL to send the buyer to.
//   2) /webhooks/whop     — Whop calls this when a payment succeeds. We verify
//      it, read the shipping address + the line items from metadata, and create
//      a PAID order in Shopify so fulfillment / inventory run as normal.
//   3) /auth + /auth/callback — one-time Shopify install to mint the Admin API
//      token (offline). Visit HOST_URL/auth once after deploy, approve, and the
//      bridge captures the token. (Or paste a token into SHOPIFY_ADMIN_TOKEN.)
//
// Real values for TrueHealthic are pre-filled in .env.example. Secrets go in
// Railway's Variables tab — never in this file.
//
// NOTE: lines marked "VERIFY" are confirmed against the first real SANDBOX
// webhook before going live (the full payload is logged once so we can see the
// exact field names Whop sends).
// ============================================================================

import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Whop from "@whop/sdk";

const {
  // ---- Whop ----
  WHOP_API_KEY,
  WHOP_APP_ID,
  WHOP_COMPANY_ID,                 // biz_CPVXi316CCJ4iS
  WHOP_WEBHOOK_SECRET,
  WHOP_PRODUCT_EXTERNAL_ID = "shapedrops-store",
  STATEMENT_DESCRIPTOR = "TRUEHEALTH",   // shows on the buyer's card statement
  // ---- Shopify ----
  SHOPIFY_STORE,                   // dsf8fr-wr.myshopify.com
  SHOPIFY_API_KEY,                 // Whop Bridge app Client ID
  SHOPIFY_API_SECRET,              // Whop Bridge app Secret (Railway variable)
  SHOPIFY_SCOPES = "write_orders,read_products,read_orders",
  SHOPIFY_API_VERSION = "2025-01",
  SHOPIFY_ADMIN_TOKEN = "",        // optional — set after first /auth to persist
  // ---- Server ----
  HOST_URL,                        // public URL of THIS server (Railway gives it)
  ALLOWED_ORIGIN = "*",            // https://shoptruehealth.com
  PORT = 3000,
  // ---- Meta (Facebook) ads tracking ----
  META_PIXEL_ID = "",              // your Meta Pixel ID -> client-side Purchase event
  META_CAPI_TOKEN = "",            // optional: Conversions API token -> server-side match
  BRAND_NAME = "TrueHealthic",     // shown on the hosted checkout page
} = process.env;

const whop = new Whop({
  appID: WHOP_APP_ID,
  apiKey: WHOP_API_KEY,
  webhookKey: Buffer.from(WHOP_WEBHOOK_SECRET || "").toString("base64"),
});

// The Shopify Admin token. Either provided via env, or captured by /auth.
let shopifyToken = SHOPIFY_ADMIN_TOKEN;
const processedPayments = new Set(); // de-dupe webhook retries (use a DB in prod)
const cartByPlan = new Map();        // planId -> cart  (Whop doesn't echo our metadata back)

// --- Hardening: persist in-flight carts to a Railway Volume so a restart or
// redeploy between checkout and payment never drops an order. ---
const CART_FILE = process.env.CART_FILE || "/data/carts.json";
try {
  const saved = JSON.parse(fs.readFileSync(CART_FILE, "utf8"));
  for (const [k, v] of Object.entries(saved)) cartByPlan.set(k, v);
  console.log(`[carts] restored ${cartByPlan.size} cart(s) from ${CART_FILE}`);
} catch { /* no file yet — fine */ }
function persistCarts() {
  try {
    fs.mkdirSync(path.dirname(CART_FILE), { recursive: true });
    fs.writeFileSync(CART_FILE, JSON.stringify(Object.fromEntries(cartByPlan)));
  } catch (e) { console.error("[carts] persist failed:", e.message); }
}

const app = express();
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ============================================================================
// 1) STOREFRONT  ->  create a Whop checkout for the live cart
// ============================================================================
app.post("/checkout/create", express.json(), async (req, res) => {
  try {
    const { items = [], cartToken = null, email = null } = req.body;
    if (!items.length) return res.status(400).json({ error: "empty cart" });

    const total = items.reduce(
      (sum, it) => sum + Number(it.price) * Number(it.quantity || 1),
      0
    );

    const checkout = await whop.checkoutConfigurations.create({
      currency: "usd",
      plan: {
        company_id: WHOP_COMPANY_ID,
        currency: "usd",
        initial_price: Number(total.toFixed(2)),
        plan_type: "one_time",
        force_create_new_plan: true, // unique plan per cart, so the webhook can map it back
        // Attach to (or create) one physical product that collects shipping
        // and uses your own statement descriptor.
        product: {
          external_identifier: WHOP_PRODUCT_EXTERNAL_ID,
          title: "ShapeDrops Order",
          collect_shipping_address: true,
          custom_statement_descriptor: STATEMENT_DESCRIPTOR,
        },
      },
      metadata: {
        cart_token: cartToken || "",
        shopify_line_items: JSON.stringify(
          items.map((it) => ({ variant_id: it.variantId, quantity: it.quantity || 1 }))
        ),
        ...(email ? { email } : {}),
      },
    });

    // Remember this cart so the webhook can rebuild the Shopify order later,
    // keyed by the unique plan id (Whop doesn't pass our metadata to the webhook).
    cartByPlan.set(checkout.plan.id, {
      lineItems: items.map((it) => ({ variant_id: it.variantId, quantity: it.quantity || 1 })),
      cartToken: cartToken || "",
      email: email || null,
      amount: Number(total.toFixed(2)),
    });
    persistCarts();

    return res.json({
      sessionId: checkout.id,
      planId: checkout.plan.id,
      // v2: send buyers to OUR on-domain embedded checkout, not whop.com
      checkoutUrl: `${HOST_URL}/c?plan=${checkout.plan.id}&session=${checkout.id}`,
    });
  } catch (err) {
    console.error("[/checkout/create]", err);
    return res.status(500).json({ error: "could not create checkout" });
  }
});

// ============================================================================
// 1b) ON-DOMAIN EMBEDDED CHECKOUT  (keeps buyers on your site + collects address)
// ============================================================================
app.get("/c", (req, res) => {
  const plan = String(req.query.plan || "");
  const session = String(req.query.session || "");
  const cart = cartByPlan.get(plan) || {};
  const amount = cart.amount || 0;
  const pixel = META_PIXEL_ID
    ? `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${META_PIXEL_ID}');fbq('track','PageView');fbq('track','InitiateCheckout',{value:${amount},currency:'USD'});</script>`
    : "";
  res.set("Content-Type", "text/html").send(`<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Secure Checkout — ${BRAND_NAME}</title>
<script async defer src="https://js.whop.com/static/checkout/loader.js"></script>${pixel}
<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#f7f7f8;color:#111}
.wrap{max-width:540px;margin:0 auto;padding:20px}.bar{font-weight:700;font-size:18px;padding:8px 0 16px}
#placeOrder{width:100%;padding:16px;border:0;border-radius:10px;background:#111;color:#fff;font-size:17px;font-weight:600;cursor:pointer;margin-top:12px}
.sec{text-align:center;color:#888;font-size:13px;margin-top:10px}</style>
</head><body><div class="wrap">
<div class="bar">${BRAND_NAME}</div>
<div id="whop-embedded-checkout" data-whop-checkout-plan-id="${plan}"${session ? ` data-whop-checkout-session="${session}"` : ""} data-whop-checkout-return-url="${HOST_URL}/thanks" data-whop-checkout-hide-submit-button="true" data-whop-checkout-on-state-change="onWhopState" data-whop-checkout-on-complete="onWhopComplete"></div>
<button id="placeOrder">Place Order &middot; $${amount.toFixed(2)}</button>
<div class="sec">🔒 Secure checkout</div>
</div>
<script>
var btn=document.getElementById('placeOrder');
btn.addEventListener('click',function(){btn.disabled=true;btn.textContent='Processing…';try{wco.submit('whop-embedded-checkout')}catch(e){console.error(e);btn.disabled=false;btn.textContent='Place Order · $${amount.toFixed(2)}';}});
window.onWhopState=function(state){try{if(state==='ready'){btn.disabled=false;}else if(state==='disabled'){btn.disabled=true;}}catch(e){}};
window.onWhopComplete=async function(planId,receiptId){
  try{${META_PIXEL_ID ? `fbq('track','Purchase',{value:${amount},currency:'USD'});` : ""}}catch(e){}
  var address={};try{address=await wco.getAddress('whop-embedded-checkout')}catch(e){}
  try{await fetch('${HOST_URL}/order-complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({planId:planId||'${plan}',receiptId:receiptId,address:address})})}catch(e){}
  document.querySelector('.wrap').innerHTML='<h2>✅ Order confirmed</h2><p>Thank you! Your order is on its way and a confirmation is in your inbox.</p>';
};
</script></body></html>`);
});

// On completion the page posts here WITH the shipping address -> create the
// paid Shopify order (with address) and fire Meta server-side.
app.post("/order-complete", express.json(), async (req, res) => {
  try {
    const { planId, receiptId, address } = req.body || {};
    if (!planId) return res.status(400).json({ error: "missing plan" });
    if (processedPayments.has(planId)) return res.json({ ok: true, deduped: true });
    processedPayments.add(planId);
    const cart = cartByPlan.get(planId) || {};
    const lineItems = cart.lineItems || [];
    if (!lineItems.length) { console.error("[order-complete] no cart for", planId); return res.status(404).json({ error: "no cart" }); }
    await createShopifyOrder({
      payment: { id: receiptId || planId, amount: cart.amount },
      lineItems, email: cart.email, ship: address || {},
    });
    fireMetaPurchase({ value: cart.amount, email: cart.email, address }).catch((e) => console.error("[meta]", e));
    res.json({ ok: true });
  } catch (err) {
    console.error("[order-complete]", err);
    res.status(500).json({ error: "failed" });
  }
});

// Meta Conversions API (server-side Purchase) — only fires when a token is set.
async function fireMetaPurchase({ value, email, address }) {
  if (!META_PIXEL_ID || !META_CAPI_TOKEN) return;
  const h = (s) => crypto.createHash("sha256").update(String(s || "").trim().toLowerCase()).digest("hex");
  const user_data = {};
  if (email) user_data.em = [h(email)];
  if (address && address.city) user_data.ct = [h(address.city)];
  if (address && address.postalCode) user_data.zp = [h(address.postalCode)];
  const body = { data: [{ event_name: "Purchase", event_time: Math.floor(Date.now() / 1000),
    action_source: "website", user_data, custom_data: { currency: "usd", value: Number(value) || 0 } }] };
  const r = await fetch(`https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events?access_token=${META_CAPI_TOKEN}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) console.error("[meta] CAPI", r.status, await r.text());
}

// ============================================================================
// 2) WHOP WEBHOOK  ->  create the PAID order in Shopify (fallback / no address)
// ============================================================================
app.post("/webhooks/whop", express.text({ type: "*/*" }), async (req, res) => {
  let event;
  try {
    event = whop.webhooks.unwrap(req.body, { headers: req.headers });
  } catch (err) {
    console.error("[webhook] signature check failed", err);
    return res.sendStatus(401);
  }
  res.sendStatus(200); // ack fast so Whop doesn't retry

  // The SDK delivers event.type in DOT notation ("invoice.paid",
  // "membership.activated") — NOT the underscore names shown in the dashboard.
  // Log the full payload of every event so we can confirm the field shapes.
  console.log("[webhook] type:", event.type, "| data:", JSON.stringify(event.data));
  const ORDER_TRIGGERS = new Set(["invoice.paid", "membership.activated", "payment.succeeded"]);
  if (!ORDER_TRIGGERS.has(event.type)) return;
  const payment = event.data || {};
  // Correlate the cart ourselves via the unique plan id. This also de-dupes
  // invoice.paid + membership.activated for the SAME purchase down to one order.
  const planId = payment.plan && payment.plan.id;
  const dedupeKey = planId || payment.id;
  if (dedupeKey && processedPayments.has(dedupeKey)) return;
  if (dedupeKey) processedPayments.add(dedupeKey);

  try {
    const stored = (planId && cartByPlan.get(planId)) || {};
    const meta = payment.metadata || {};
    const lineItems = stored.lineItems || JSON.parse(meta.shopify_line_items || "[]");
    const email = (payment.user && payment.user.email) || stored.email || meta.email;
    const ship = payment.shipping_address || payment.address || {}; // empty on membership.activated
    if (!lineItems.length) { console.error("[webhook] no cart on file for plan", planId); return; }
    await createShopifyOrder({ payment, lineItems, email, ship });
  } catch (err) {
    console.error("[webhook] Shopify order failed", err);
    processedPayments.delete(payment.id); // allow a retry to recover
  }
});

async function createShopifyOrder({ payment, lineItems, email, ship }) {
  if (!shopifyToken) throw new Error("No Shopify token yet — visit HOST_URL/auth once.");
  const hasAddr = ship && (ship.line1 || ship.address1);
  const order = {
    order: {
      line_items: lineItems.map((li) => ({
        variant_id: Number(li.variant_id),
        quantity: Number(li.quantity) || 1,
      })),
      email: email || undefined,
      financial_status: "paid",
      source_name: "whop",
      tags: "Whop",
      note: `Paid via Whop — payment ${payment.id}`,
      transactions: [{ kind: "sale", status: "success", gateway: "Whop",
        amount: payment.amount ?? payment.final_amount ?? undefined }],
      shipping_address: hasAddr ? {
        name: ship.name,
        address1: ship.line1 || ship.address1,
        address2: ship.line2 || ship.address2 || "",
        city: ship.city,
        province_code: ship.state || ship.province_code,
        country_code: ship.country || ship.country_code,
        zip: ship.postalCode || ship.postal_code || ship.zip,
      } : undefined,
    },
  };
  const r = await shopifyAdmin("/orders.json", "POST", order);
  console.log("[shopify] order created:", r.order?.name);
}

async function shopifyAdmin(path, method, body) {
  const resp = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}${path}`,
    { method, headers: {
        "X-Shopify-Access-Token": shopifyToken,
        "Content-Type": "application/json",
      }, body: body ? JSON.stringify(body) : undefined }
  );
  if (!resp.ok) throw new Error(`Shopify ${method} ${path} -> ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

// ============================================================================
// 3) ONE-TIME SHOPIFY INSTALL  ->  mint the Admin API (offline) token
//    Visit HOST_URL/auth once after deploy, approve, done.
// ============================================================================
app.get("/auth", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = `${HOST_URL}/auth/callback`;
  const url =
    `https://${SHOPIFY_STORE}/admin/oauth/authorize` +
    `?client_id=${SHOPIFY_API_KEY}` +
    `&scope=${encodeURIComponent(SHOPIFY_SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}` +
    `&grant_options[]=`; // offline (permanent) token
  res.cookie?.("shopify_state", state);
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  try {
    const { hmac, signature, ...rest } = req.query;
    const code = req.query.code;
    // Verify HMAC over ALL query params except hmac/signature (code MUST stay in).
    const msg = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join("&");
    const digest = crypto.createHmac("sha256", SHOPIFY_API_SECRET).update(msg).digest("hex");
    if (digest !== hmac) return res.status(400).send("HMAC validation failed");

    const tokenResp = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code,
      }),
    });
    const data = await tokenResp.json();
    shopifyToken = data.access_token;
    console.log("[auth] Shopify offline token captured.");
    res.send(
      "<h2>✅ Connected to Shopify.</h2><p>You can close this tab. " +
      "For persistence across restarts, copy this token into the " +
      "<code>SHOPIFY_ADMIN_TOKEN</code> Railway variable:</p>" +
      `<pre>${shopifyToken}</pre>`
    );
  } catch (err) {
    console.error("[auth/callback]", err);
    res.status(500).send("Auth failed — check server logs.");
  }
});

// Landing page for external-payment redirects (PayPal, etc.) that can't stay
// in-frame. Card payments never reach this — they use the in-page on-complete.
app.get("/thanks", (req, res) => {
  const pixel = META_PIXEL_ID
    ? `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${META_PIXEL_ID}');fbq('track','PageView');fbq('track','Purchase',{currency:'USD'});</script>`
    : "";
  res.set("Content-Type", "text/html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Thank you — ${BRAND_NAME}</title>${pixel}<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f7f7f8;color:#111;text-align:center;padding:60px 20px}</style></head><body><h2>✅ Order confirmed</h2><p>Thank you! Your order is on its way and a confirmation is in your inbox.</p></body></html>`);
});

app.get("/health", (_req, res) => res.send("ok"));
app.get("/", (_req, res) => res.send("Whop↔Shopify bridge is running."));
app.listen(PORT, () => console.log(`Bridge listening on :${PORT}`));
