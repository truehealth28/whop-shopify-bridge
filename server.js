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
  BRAND_LOGO_URL = "https://cdn.shopify.com/s/files/1/0986/7673/6369/files/Screenshot_2026-04-14_at_11.06.29_PM_x320.png", // header logo image
  BRAND_ACCENT = "#16264a",        // navy brand color for the Place Order button
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
          // Fresh product id so collect_shipping_address:false actually applies
          // (the original product had address collection baked in and ignored
          // the per-checkout flag). We collect shipping on the /c page instead.
          external_identifier: WHOP_PRODUCT_EXTERNAL_ID + "-noship",
          title: "ShapeDrops Order",
          // We collect the shipping address ourselves on the /c page (Whop's
          // embed gives no reliable way to read its address field back), so the
          // Whop checkout only needs to handle email + payment.
          collect_shipping_address: false,
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
    const compareMap = await fetchCompareAt(items.map((it) => it.variantId));
    cartByPlan.set(checkout.plan.id, {
      lineItems: items.map((it) => ({
        variant_id: it.variantId,
        quantity: it.quantity || 1,
        title: it.title || "",
        price: Number(it.price) || 0,
        compareAt: Number(compareMap[String(it.variantId)]) || 0,
        image: it.image || "",
      })),
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
  const items = Array.isArray(cart.lineItems) ? cart.lineItems : [];
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n) => "$" + (Number(n) || 0).toFixed(2);
  const US_STATES = { AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",DC:"District of Columbia",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming" };
  const stateOptions = Object.keys(US_STATES).map((c) => `<option value="${c}">${US_STATES[c]}</option>`).join("");
  let savings = 0;
  const itemsHtml = items.map((it) => {
    const qty = Number(it.quantity) || 1;
    const line = (Number(it.price) || 0) * qty;
    const cmp = (Number(it.compareAt) || 0) * qty;
    if (cmp > line) savings += (cmp - line);
    const img = it.image
      ? `<img src="${esc(it.image)}" alt="" class="os-img">`
      : `<div class="os-img os-img--ph"></div>`;
    const priceCell = cmp > line
      ? `<div class="os-price"><span class="os-was">${money(cmp)}</span>${money(line)}</div>`
      : `<div class="os-price">${money(line)}</div>`;
    return `<div class="os-item"><div class="os-thumb">${img}<span class="os-qty">${qty}</span></div>` +
      `<div class="os-name">${esc(it.title || "Item")}</div>` + priceCell + `</div>`;
  }).join("") || `<div class="os-item"><div class="os-name">Your order</div><div class="os-price">${money(amount)}</div></div>`;
  savings = Math.round(savings * 100) / 100;
  const regularTotal = amount + savings;
  const pixel = META_PIXEL_ID
    ? `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${META_PIXEL_ID}');fbq('track','PageView');fbq('track','InitiateCheckout',{value:${amount},currency:'USD'});</script>`
    : "";
  res.set("Content-Type", "text/html").send(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Secure Checkout — ${esc(BRAND_NAME)}</title>
<script async defer src="https://js.whop.com/static/checkout/loader.js"></script>${pixel}
<style>
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;background:#fff;-webkit-font-smoothing:antialiased}
a{color:inherit}
.hdr{border-bottom:1px solid #e6e6e6;background:#fff}
.hdr-in{max-width:1000px;margin:0 auto;padding:22px 20px;text-align:center}
.logo{font-size:24px;font-weight:800;letter-spacing:-.02em;color:#111}
.tm{font-size:.55em;vertical-align:super;font-weight:600;margin-left:1px}
.logo-img{height:30px;width:auto;max-width:80%;display:inline-block;vertical-align:middle}
.page{display:flex;align-items:stretch;min-height:calc(100vh - 67px)}
.col-main{flex:1.15;display:flex;justify-content:flex-end;background:#fff}
.col-side{flex:.85;background:#fafbfc;border-left:1px solid #e6e6e6}
.col-main>.inner{width:100%;max-width:560px;padding:30px 44px 56px 24px}
.col-side>.inner{width:100%;max-width:430px;padding:34px 24px 56px 44px;position:sticky;top:0}
#whop-embedded-checkout{min-height:380px}
#placeOrder{width:100%;padding:15px;border:0;border-radius:8px;background:${BRAND_ACCENT};color:#fff;font-size:16px;font-weight:600;cursor:pointer;margin-top:14px;transition:opacity .15s}
#placeOrder:hover{opacity:.88}#placeOrder:disabled{opacity:.45;cursor:default}
.trust{text-align:center;color:#8a8a8a;font-size:12.5px;margin-top:16px;line-height:1.7}
.trust b{color:#5a5a5a;font-weight:600}
.shipform{margin-bottom:6px}
.sf-h{font-size:15px;font-weight:600;margin:0 0 14px;color:#1a1a1a}
.sf-in{width:100%;padding:13px 12px;border:1px solid #cdcdcd;border-radius:7px;font-size:15px;font-family:inherit;margin-bottom:10px;color:#1a1a1a;background:#fff;outline:none;-webkit-appearance:none;appearance:none}
.sf-in::placeholder{color:#9b9b9b}
.sf-in:focus{border-color:#16264a;box-shadow:0 0 0 1px #16264a}
.sf-row{display:flex;gap:10px}
.sf-row .sf-in{flex:1;min-width:0}
.sf-country{-webkit-appearance:auto;appearance:auto}
.sf-err{color:#c0392b;font-size:13px;margin:-2px 0 8px;display:none}
.shipform.invalid .sf-err{display:block}
.shipform.invalid .sf-in.bad{border-color:#c0392b;box-shadow:0 0 0 1px #c0392b}
.sf-paylabel{font-size:15px;font-weight:600;margin:14px 0 12px;color:#1a1a1a}
.os-h{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#8a8a8a;margin:0 0 18px}
.os-item{display:flex;align-items:center;gap:14px;margin-bottom:18px}
.os-thumb{position:relative;flex:0 0 auto}
.os-img{width:58px;height:58px;border-radius:9px;object-fit:cover;border:1px solid #e2e2e2;background:#fff;display:block}
.os-img--ph{background:linear-gradient(135deg,#eee,#e3e3e3)}
.os-qty{position:absolute;top:-9px;right:-9px;min-width:21px;height:21px;padding:0 6px;background:#6b7280;color:#fff;border-radius:999px;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 2px rgba(0,0,0,.2)}
.os-name{flex:1;font-size:14px;font-weight:500;line-height:1.35;color:#222}
.os-price{font-size:14px;font-weight:600;white-space:nowrap;color:#222}
.os-rows{border-top:1px solid #e6e6e6;padding-top:18px;margin-top:6px}
.os-row{display:flex;justify-content:space-between;font-size:14px;color:#555;margin-bottom:12px}
.os-free{color:#1a7f37;font-weight:600}
.os-total{display:flex;justify-content:space-between;align-items:baseline;border-top:1px solid #e6e6e6;padding-top:18px;margin-top:6px;font-size:21px;font-weight:700;color:#111}
.os-cur{font-size:12px;color:#999;font-weight:600;margin-right:5px}
.os-was{color:#9a9a9a;text-decoration:line-through;font-weight:500;margin-right:7px;font-size:13px}
.os-savings{display:flex;align-items:center;justify-content:space-between;margin-top:14px;padding:11px 14px;background:#eaf7ee;border:1px solid #cdebd6;border-radius:9px;color:#1a7f37;font-size:13.5px;font-weight:700}
.os-savings-tag{display:flex;align-items:center;gap:6px;letter-spacing:.02em}
.os-toggle{display:none;align-items:center;justify-content:space-between;width:100%;background:none;border:0;cursor:pointer;font-family:inherit;color:#16264a;font-weight:600;font-size:15px;padding:0}
.os-toggle-l{display:flex;align-items:center;gap:7px}
.os-toggle .chev{display:inline-block;transition:transform .2s;font-size:13px}
.os-toggle-r{font-weight:700;color:#111;font-size:16px}
.col-side.open .os-toggle .chev{transform:rotate(180deg)}
.badges{margin-top:22px;padding-top:18px;border-top:1px solid #ededed;display:flex;flex-wrap:wrap;gap:10px 16px;font-size:12.5px;color:#777}
.badges span{display:flex;align-items:center;gap:5px}
@media(max-width:820px){
  .page{flex-direction:column;min-height:0}
  .col-main,.col-side{display:block;flex:none}
  .col-main>.inner,.col-side>.inner{max-width:640px;margin:0 auto;padding:24px 20px;position:static}
  .col-side{order:-1;border-left:0;border-bottom:1px solid #e6e6e6}
  .col-side>.inner{padding:15px 20px}
  .os-toggle{display:flex}
  .os-h{display:none}
  .os-body{display:none}
  .col-side.open .os-body{display:block;margin-top:18px}
}
</style>
</head><body>
<div id="checkout-root">
  <header class="hdr"><div class="hdr-in">${BRAND_LOGO_URL ? `<img src="${esc(BRAND_LOGO_URL)}" alt="${esc(BRAND_NAME)}" class="logo-img">` : `<span class="logo">${esc(BRAND_NAME)}<span class="tm">™</span></span>`}</div></header>
  <div class="page">
    <main class="col-main"><div class="inner">
      <form id="shipForm" class="shipform" onsubmit="return false">
        <h2 class="sf-h">Shipping address</h2>
        <input class="sf-in" id="sf_name" placeholder="Full name" autocomplete="name">
        <input class="sf-in" id="sf_line1" placeholder="Address" autocomplete="address-line1">
        <input class="sf-in" id="sf_line2" placeholder="Apartment, suite, etc. (optional)" autocomplete="address-line2">
        <div class="sf-row">
          <input class="sf-in" id="sf_city" placeholder="City" autocomplete="address-level2">
          <select class="sf-in sf-country" id="sf_state" autocomplete="address-level1"><option value="" selected disabled>State</option>${stateOptions}</select>
          <input class="sf-in" id="sf_zip" placeholder="ZIP code" autocomplete="postal-code" inputmode="numeric">
        </div>
        <select class="sf-in sf-country" id="sf_country" autocomplete="country"><option value="US" selected>United States</option></select>
        <div id="sf_err" class="sf-err">Please complete your shipping address above.</div>
      </form>
      <div class="sf-paylabel">Contact &amp; payment</div>
      <div id="whop-embedded-checkout" data-whop-checkout-plan-id="${plan}"${session ? ` data-whop-checkout-session="${session}"` : ""} data-whop-checkout-theme="light" data-whop-checkout-hide-address="true" data-whop-checkout-style-container-padding-x="0" data-whop-checkout-style-container-padding-top="0" data-whop-checkout-return-url="${HOST_URL}/thanks" data-whop-checkout-hide-submit-button="true" data-whop-checkout-on-state-change="onWhopState" data-whop-checkout-on-complete="onWhopComplete"></div>
      <button id="placeOrder" disabled>Place Order &middot; ${money(amount)}</button>
      <div class="trust">🔒 <b>Secure SSL checkout</b> — your info is encrypted &amp; never stored.</div>
    </div></main>
    <aside class="col-side"><div class="inner">
      <button type="button" class="os-toggle" onclick="this.closest('.col-side').classList.toggle('open')"><span class="os-toggle-l">Order summary <span class="chev">⌄</span></span><span class="os-toggle-r">${money(amount)}</span></button>
      <div class="os-body">
      <h2 class="os-h">Order summary</h2>
      <div class="os-items">${itemsHtml}</div>
      <div class="os-rows">
        <div class="os-row"><span>Subtotal</span><span>${money(amount)}</span></div>
        <div class="os-row"><span>Shipping</span><span class="os-free">FREE</span></div>
      </div>
      <div class="os-total"><span>Total</span><span><span class="os-cur">USD</span>${money(amount)}</span></div>
      ${savings > 0.001 ? `<div class="os-savings"><span class="os-savings-tag">🏷️ TOTAL SAVINGS</span><span>${money(savings)}</span></div>` : ""}
      <div class="badges"><span>🇺🇸 Made in USA</span><span>✓ GMP Certified</span><span>✓ 90-Day Money-Back</span></div>
      </div>
    </div></aside>
  </div>
</div>
<script>
var btn=document.getElementById('placeOrder');
var form=document.getElementById('shipForm');
var capturedAddress=null;
var REQ=['sf_name','sf_line1','sf_city','sf_state','sf_zip'];
function gv(id){var el=document.getElementById(id);return el?el.value.trim():'';}
function readShip(){return {name:gv('sf_name'),country:gv('sf_country')||'US',line1:gv('sf_line1'),line2:gv('sf_line2'),city:gv('sf_city'),state:gv('sf_state'),postalCode:gv('sf_zip')};}
function validShip(){var ok=true;REQ.forEach(function(id){var el=document.getElementById(id);if(el){if(!el.value.trim()){el.classList.add('bad');ok=false;}else{el.classList.remove('bad');}}});form.classList.toggle('invalid',!ok);return ok;}
REQ.forEach(function(id){var el=document.getElementById(id);if(el){var clr=function(){el.classList.remove('bad');if(!form.querySelector('.bad'))form.classList.remove('invalid');};el.addEventListener('input',clr);el.addEventListener('change',clr);}});
btn.addEventListener('click',async function(){
  if(!validShip()){var b=form.querySelector('.bad');if(b)b.focus();return;}
  capturedAddress=readShip();
  btn.disabled=true;btn.textContent='Processing…';
  try{await wco.setAddress('whop-embedded-checkout',capturedAddress);}catch(e){console.warn('setAddress',e);}
  try{wco.submit('whop-embedded-checkout')}catch(e){console.error(e);btn.disabled=false;btn.textContent='Place Order · ${money(amount)}';}
});
window.onWhopState=function(state){try{if(state==='ready'){btn.disabled=false;}else if(state==='disabled'){btn.disabled=true;}}catch(e){}};
window.onWhopComplete=async function(planId,receiptId){
  try{${META_PIXEL_ID ? `fbq('track','Purchase',{value:${amount},currency:'USD'});` : ""}}catch(e){}
  var address=capturedAddress||readShip();
  try{await fetch('${HOST_URL}/order-complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({planId:planId||'${plan}',receiptId:receiptId,address:address})})}catch(e){}
  document.getElementById('checkout-root').innerHTML='<div style="max-width:520px;margin:80px auto;padding:0 24px;text-align:center"><div style="font-size:54px;line-height:1">✅</div><h1 style="font-size:24px;margin:14px 0 8px">Order confirmed</h1><p style="color:#555;font-size:15px;line-height:1.6">Thank you for your order! It\\'s on its way and a confirmation email is in your inbox.</p></div>';
};
</script>
</body></html>`);
});

// On completion the page posts here WITH the shipping address -> create the
// paid Shopify order (with address) and fire Meta server-side.
app.post("/order-complete", express.json(), async (req, res) => {
  const { planId, receiptId, address } = req.body || {};
  if (!planId) return res.status(400).json({ error: "missing plan" });
  if (processedPayments.has(planId)) return res.json({ ok: true, deduped: true });
  const cart = cartByPlan.get(planId) || {};
  const lineItems = cart.lineItems || [];
  if (!lineItems.length) { console.error("[order-complete] no cart for", planId); return res.status(404).json({ error: "no cart" }); }
  processedPayments.add(planId); // claim; released below if the order fails
  try {
    await createShopifyOrder({
      payment: { id: receiptId || planId, amount: cart.amount },
      lineItems, email: cart.email, ship: address || {},
    });
    fireMetaPurchase({ value: cart.amount, email: cart.email, address }).catch((e) => console.error("[meta]", e));
    res.json({ ok: true });
  } catch (err) {
    processedPayments.delete(planId); // release so the webhook fallback / a retry can recover
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
  // Give the on-page /order-complete (which carries the shipping address) a head
  // start to win this purchase, so the order is created WITH the address. The
  // webhook is the fallback for buyers who close the tab before it fires.
  await new Promise((r) => setTimeout(r, 8000));
  if (dedupeKey && processedPayments.has(dedupeKey)) return;
  if (dedupeKey) processedPayments.add(dedupeKey);

  try {
    const stored = (planId && cartByPlan.get(planId)) || {};
    const meta = payment.metadata || {};
    const lineItems = stored.lineItems || JSON.parse(meta.shopify_line_items || "[]");
    const email = (payment.user && payment.user.email) || stored.email || meta.email;
    const ship = payment.shipping_address || payment.address || {}; // empty on membership.activated
    if (!lineItems.length) { console.error("[webhook] no cart on file for plan", planId); return; }
    const amount = Number(payment && payment.amount) > 0 ? Number(payment.amount) : stored.amount;
    await createShopifyOrder({ payment: { id: payment.id, amount }, lineItems, email, ship });
  } catch (err) {
    console.error("[webhook] Shopify order failed", err);
    if (dedupeKey) processedPayments.delete(dedupeKey); // release so /order-complete or a retry can recover
  }
});

async function createShopifyOrder({ payment, lineItems, email, ship }) {
  if (!shopifyToken) throw new Error("No Shopify token yet — visit HOST_URL/auth once.");
  const hasAddr = ship && (ship.line1 || ship.address1);
  // Whop's membership.activated webhook sends amount 0, which Shopify rejects
  // ("Amount must be greater than zero for sale transaction"). Fall back to the
  // cart's line-item total so the transaction always carries a real amount.
  let txAmount = Number(payment && (payment.amount ?? payment.final_amount));
  if (!(txAmount > 0)) {
    txAmount = lineItems.reduce((s, li) => s + (Number(li.price) || 0) * (Number(li.quantity) || 1), 0);
  }
  txAmount = Math.round((Number(txAmount) || 0) * 100) / 100;
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
      transactions: txAmount > 0
        ? [{ kind: "sale", status: "success", gateway: "Whop", amount: txAmount }]
        : undefined,
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

// Look up compare-at (original) prices for the cart's variants straight from
// Shopify, so the summary can show the struck-through price + savings
// automatically. Best-effort — never blocks checkout creation.
async function fetchCompareAt(variantIds) {
  const out = {};
  try {
    const ids = [...new Set((variantIds || []).filter(Boolean).map(String))];
    if (!shopifyToken || !ids.length) return out;
    const gids = ids.map((id) => `gid://shopify/ProductVariant/${id}`);
    const query = `query($ids:[ID!]!){nodes(ids:$ids){... on ProductVariant{id compareAtPrice}}}`;
    const resp = await fetch(`https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": shopifyToken, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { ids: gids } }),
    });
    const data = await resp.json();
    for (const n of (data && data.data && data.data.nodes) || []) {
      if (n && n.id) out[String(n.id).split("/").pop()] = n.compareAtPrice ? Number(n.compareAtPrice) : 0;
    }
  } catch (e) { console.error("[compareAt]", e.message); }
  return out;
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

// Apple Pay domain verification (self-hosted) — proxy Whop's association file so
// Apple sees it at our domain, with zero downtime and no DNS repointing. Stays in
// sync automatically if Whop rotates the file.
app.get("/.well-known/apple-developer-merchantid-domain-association", async (_req, res) => {
  try {
    const r = await fetch("https://whop.com/.well-known/apple-platform-integrator/apple-developer-merchantid-domain-association/");
    const buf = Buffer.from(await r.arrayBuffer());
    res.set("Content-Type", "text/plain").send(buf);
  } catch (e) {
    console.error("[apple-pay] association file proxy failed:", e.message);
    res.status(502).send("verification file unavailable");
  }
});

app.get("/health", (_req, res) => res.send("ok"));
app.get("/", (_req, res) => res.send("Whop↔Shopify bridge is running."));
app.listen(PORT, () => console.log(`Bridge listening on :${PORT}`));
