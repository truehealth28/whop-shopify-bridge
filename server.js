// ============================================================================
// TrueHealthic — Whop <-> Shopify checkout bridge  (the "Lasso-style" engine)
// ----------------------------------------------------------------------------
// Flow (Shopify-style stepped checkout, on your own domain):
//   1) /checkout/create — storefront posts the live Shopify cart. We stash the
//      line items + subtotal and send the buyer to /c (address step).
//   2) /c (address step) — buyer enters their shipping address; the page calls
//      /shipping/rates to show YOUR real Shopify shipping options (Standard /
//      Expedited). Buyer picks one.
//   3) /checkout/finalize — locks the chosen rate, creates a Whop checkout for
//      (subtotal + shipping), stores address + shipping, and returns the plan to
//      mount the payment embed for.
//   4) /c?step=pay — mounts the Whop embedded checkout for the full total. On
//      success the page posts /order-complete (and the Whop webhook is a
//      fallback), which creates a PAID Shopify order WITH the shipping line +
//      shipping address so fulfillment / inventory run as normal.
//
// Secrets live in Railway's Variables tab — never in this file.
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
const STORE_URL = (ALLOWED_ORIGIN && ALLOWED_ORIGIN.indexOf("http") === 0) ? ALLOWED_ORIGIN : "https://shoptruehealth.com";

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
// 1) STOREFRONT  ->  stash the live cart, send buyer to the address step
// ============================================================================
app.post("/checkout/create", express.json(), async (req, res) => {
  try {
    const { items = [], cartToken = null, email = null } = req.body;
    if (!items.length) return res.status(400).json({ error: "empty cart" });

    const total = items.reduce(
      (sum, it) => sum + Number(it.price) * Number(it.quantity || 1),
      0
    );

    // A Whop checkout for the SUBTOTAL (shipping is added at /checkout/finalize
    // once the buyer picks a rate). This plan id is our cart key for the address
    // step; the real payment runs on the finalize plan.
    const checkout = await whop.checkoutConfigurations.create({
      currency: "usd",
      plan: {
        company_id: WHOP_COMPANY_ID,
        currency: "usd",
        initial_price: Number(total.toFixed(2)),
        plan_type: "one_time",
        force_create_new_plan: true,
        product: {
          external_identifier: WHOP_PRODUCT_EXTERNAL_ID + "-noship",
          title: "ShapeDrops Order",
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
      amount: Number(total.toFixed(2)),   // subtotal at this stage
      subtotal: Number(total.toFixed(2)),
    });
    persistCarts();

    return res.json({
      sessionId: checkout.id,
      planId: checkout.plan.id,
      checkoutUrl: `${HOST_URL}/c?plan=${checkout.plan.id}&session=${checkout.id}`,
    });
  } catch (err) {
    console.error("[/checkout/create]", err);
    return res.status(500).json({ error: "could not create checkout" });
  }
});

// ============================================================================
// 1a) SHIPPING RATES  ->  ask Shopify for the real options for this address
// ============================================================================
// Uses draftOrderCalculate, which returns exactly what Shopify's own checkout
// would show (your configured Standard / Expedited / free-over-threshold rates).
// Configured shipping rates — a reliable fallback that mirrors the store's
// Shopify Shipping settings (Standard $4.95 under $48, Free Standard $48+,
// Expedited $8.95). Used when the live draftOrderCalculate lookup isn't
// available (the Admin token lacks the draft_orders scope). The flow upgrades
// to pulling live from Shopify automatically the moment that scope is present.
function builtinRates(subtotal) {
  const sub = Number(subtotal) || 0;
  const out = [];
  if (sub >= 48) out.push({ handle: "builtin-free-standard", title: "Free Standard Shipping", price: 0 });
  else out.push({ handle: "builtin-standard", title: "Standard", price: 4.95 });
  out.push({ handle: "builtin-expedited", title: "Expedited Shipping", price: 8.95 });
  return out;
}

let lastRatesDebug = null;
// Live shipping rates straight from Shopify (exactly what its checkout shows).
// Requires the draft_orders scope on the Admin token.
async function liveShopifyRates(lineItems, address) {
  const liGql = (lineItems || []).filter((li) => li.variant_id).map((li) => ({
    variantId: `gid://shopify/ProductVariant/${li.variant_id}`,
    quantity: Number(li.quantity) || 1,
  }));
  if (!liGql.length) return { rates: [] };
  const shippingAddress = {
    address1: address.line1 || address.address1 || "",
    address2: address.line2 || address.address2 || "",
    city: address.city || "",
    province: address.state || address.province || "",
    country: "United States",
    zip: address.postalCode || address.zip || "",
  };
  const query = `mutation calc($input: DraftOrderInput!) {
    draftOrderCalculate(input: $input) {
      calculatedDraftOrder { availableShippingRates { handle title price { amount currencyCode } } }
      userErrors { field message }
    }
  }`;
  const resp = await fetch(`https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": shopifyToken, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { input: { lineItems: liGql, shippingAddress } } }),
  });
  const data = await resp.json();
  const calc = ((data.data || {}).draftOrderCalculate) || {};
  const userErrors = (calc.userErrors && calc.userErrors.length ? calc.userErrors : (data.errors || []));
  const rates = (((calc.calculatedDraftOrder || {}).availableShippingRates) || [])
    .map((r) => ({ handle: r.handle, title: r.title, price: Number(r.price.amount) || 0 }));
  lastRatesDebug = { status: resp.status, rateCount: rates.length, userErrors };
  if (userErrors.length) console.error("[rates] live lookup errors", JSON.stringify(userErrors));
  return { rates };
}

// Prefer live Shopify rates; fall back to the configured table so the checkout
// never blocks if the live lookup is unavailable.
async function shopifyShippingRates(lineItems, address) {
  const subtotal = (lineItems || []).reduce((s, li) => s + (Number(li.price) || 0) * (Number(li.quantity) || 1), 0);
  try {
    const live = await liveShopifyRates(lineItems, address);
    if (live.rates.length) return live.rates;
  } catch (e) { console.error("[rates] live lookup threw", e.message); }
  return builtinRates(subtotal);
}

app.post("/shipping/rates", express.json(), async (req, res) => {
  try {
    const { plan, address } = req.body || {};
    const cart = cartByPlan.get(String(plan || "")) || {};
    if (!cart.lineItems || !cart.lineItems.length) return res.status(404).json({ error: "no cart" });
    if (!address || !(address.postalCode || address.zip)) return res.status(400).json({ error: "address required" });
    const rates = await shopifyShippingRates(cart.lineItems, address);
    res.json({ rates });
  } catch (err) {
    console.error("[/shipping/rates]", err);
    res.status(500).json({ error: "rates failed" });
  }
});

// Diagnostic: shows why the last live rate lookup did/didn't return rates.
app.get("/shipping/rates-debug", (_req, res) => res.json({ lastRatesDebug }));

// ============================================================================
// 1b) FINALIZE  ->  lock the rate, build the Whop charge for subtotal+shipping
// ============================================================================
app.post("/checkout/finalize", express.json(), async (req, res) => {
  try {
    const { plan, address, handle, title } = req.body || {};
    const cart = cartByPlan.get(String(plan || ""));
    if (!cart || !cart.lineItems || !cart.lineItems.length) return res.status(404).json({ error: "no cart" });
    if (!address || !(address.line1 || address.address1)) return res.status(400).json({ error: "address required" });

    // Re-fetch rates server-side and match the chosen handle (never trust a
    // client-supplied price). Fall back to title, then the cheapest rate.
    const rates = await shopifyShippingRates(cart.lineItems, address);
    const chosen = rates.find((r) => r.handle === handle)
      || rates.find((r) => r.title === title)
      || rates.sort((a, b) => a.price - b.price)[0];
    if (!chosen) return res.status(409).json({ error: "no shipping rate" });

    const subtotal = Number(cart.subtotal != null ? cart.subtotal : cart.amount)
      || cart.lineItems.reduce((s, li) => s + (Number(li.price) || 0) * (Number(li.quantity) || 1), 0);
    const newAmount = Math.round((subtotal + Number(chosen.price)) * 100) / 100;

    const checkout = await whop.checkoutConfigurations.create({
      currency: "usd",
      plan: {
        company_id: WHOP_COMPANY_ID,
        currency: "usd",
        initial_price: newAmount,
        plan_type: "one_time",
        force_create_new_plan: true,
        product: {
          external_identifier: WHOP_PRODUCT_EXTERNAL_ID + "-noship",
          title: "ShapeDrops Order",
          collect_shipping_address: false,
          custom_statement_descriptor: STATEMENT_DESCRIPTOR,
        },
      },
      metadata: {
        cart_token: cart.cartToken || "",
        shopify_line_items: JSON.stringify(cart.lineItems.map((li) => ({ variant_id: li.variant_id, quantity: li.quantity }))),
        ...(cart.email ? { email: cart.email } : {}),
      },
    });

    const addr = {
      name: address.name || "",
      line1: address.line1 || address.address1 || "",
      line2: address.line2 || address.address2 || "",
      city: address.city || "",
      state: address.state || address.province || "",
      postalCode: address.postalCode || address.zip || "",
      country: "US",
    };
    cartByPlan.set(checkout.plan.id, {
      ...cart,
      subtotal,
      amount: newAmount,
      shipping: { title: chosen.title, price: Number(chosen.price), handle: chosen.handle },
      address: addr,
    });
    persistCarts();

    res.json({
      plan: checkout.plan.id,
      session: checkout.id,
      amount: newAmount,
      shipping: { title: chosen.title, price: Number(chosen.price) },
    });
  } catch (err) {
    console.error("[/checkout/finalize]", err);
    res.status(500).json({ error: "finalize failed" });
  }
});

// ============================================================================
// 1c) ON-DOMAIN CHECKOUT PAGE  (address+shipping step, then payment step)
// ============================================================================
app.get("/c", (req, res) => {
  const plan = String(req.query.plan || "");
  const session = String(req.query.session || "");
  const embedMode = req.query.embed === "1";
  // Preview = the payment embed is mounted immediately on page load (subtotal
  // only, before an address/shipping rate exists). It's fully visible but its
  // "Place Order" stays locked until the buyer's address + shipping selection
  // swap it for the finalized (subtotal + shipping) plan.
  const previewMode = req.query.preview === "1";
  const cart = cartByPlan.get(plan);
  // Anyone landing here without a live cart (e.g. the bare domain) is sent to
  // the store, not a blank page.
  if (!cart || !Array.isArray(cart.lineItems) || !cart.lineItems.length) {
    return res.redirect(302, STORE_URL);
  }
  const amount = Number(cart.amount) || 0;                 // pay step: incl. shipping
  const subtotal = Number(cart.subtotal != null ? cart.subtotal : amount) || 0;
  const shipping = cart.shipping || null;                  // {title, price} at pay step
  const addr = cart.address || null;
  const items = Array.isArray(cart.lineItems) ? cart.lineItems : [];
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n) => "$" + (Number(n) || 0).toFixed(2);
  const US_STATES = { AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",DC:"District of Columbia",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming" };
  const stateOptions = (sel) => Object.keys(US_STATES).map((c) => `<option value="${c}"${sel === c ? " selected" : ""}>${US_STATES[c]}</option>`).join("");
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
  }).join("") || `<div class="os-item"><div class="os-name">Your order</div><div class="os-price">${money(subtotal)}</div></div>`;
  savings = Math.round(savings * 100) / 100;

  const pixel = META_PIXEL_ID
    ? `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${META_PIXEL_ID}');fbq('track','PageView');${!embedMode ? `fbq('track','InitiateCheckout',{value:${subtotal},currency:'USD'});` : ""}</script>`
    : "";

  // ---- shared chrome (head + styles + header) ----
  const head = `<!doctype html><html lang="en"><head>
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
#whop-embedded-checkout{min-height:300px}
.pay-section{margin-top:2px}
.pay-frame{width:100%;border:0;min-height:300px;display:block;background:transparent}
.pay-loading{padding:22px 2px;color:#8a8a8a;font-size:14px}
.cta{width:100%;padding:15px;border:0;border-radius:8px;background:${BRAND_ACCENT};color:#fff;font-size:16px;font-weight:600;cursor:pointer;margin-top:14px;transition:opacity .15s}
.cta:hover{opacity:.88}.cta:disabled{opacity:.45;cursor:default}
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
.sec-h{font-size:15px;font-weight:600;margin:22px 0 12px;color:#1a1a1a}
.ship-methods{margin:4px 0 2px}
.ship-opt{display:flex;align-items:center;gap:11px;border:1px solid #cdcdcd;border-radius:8px;padding:13px 14px;margin-bottom:10px;cursor:pointer;transition:border-color .12s,box-shadow .12s}
.ship-opt:hover{border-color:#9aa4b8}
.ship-opt.sel{border-color:#16264a;box-shadow:0 0 0 1px #16264a;background:#f7f9fc}
.ship-opt input{accent-color:#16264a;width:17px;height:17px;margin:0}
.ship-opt .so-t{flex:1;font-size:14.5px;font-weight:500;color:#1a1a1a}
.ship-opt .so-p{font-size:14.5px;font-weight:600;color:#1a1a1a}
.ship-note{font-size:13.5px;color:#8a8a8a;padding:9px 2px}
.shipto{border:1px solid #e6e6e6;border-radius:9px;padding:14px 16px;margin:2px 0 16px;font-size:14px;line-height:1.5;color:#333}
.shipto .st-row{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid #f0f0f0}
.shipto .st-row:last-child{border-bottom:0;padding-bottom:0}.shipto .st-row:first-child{padding-top:0}
.shipto .st-lbl{color:#8a8a8a;flex:0 0 64px}
.shipto .st-val{text-align:right;color:#1a1a1a;flex:1}
.shipto .st-edit{color:#16264a;font-weight:600;cursor:pointer;font-size:13px;text-decoration:none;white-space:nowrap}
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
  <header class="hdr"><div class="hdr-in">${BRAND_LOGO_URL ? `<img src="${esc(BRAND_LOGO_URL)}" alt="${esc(BRAND_NAME)}" class="logo-img">` : `<span class="logo">${esc(BRAND_NAME)}<span class="tm">™</span></span>`}</div></header>`;

  const savingsHtml = savings > 0.001
    ? `<div class="os-savings"><span class="os-savings-tag">🏷️ TOTAL SAVINGS</span><span>${money(savings)}</span></div>`
    : "";
  const badges = `<div class="badges"><span>🇺🇸 Made in USA</span><span>✓ GMP Certified</span><span>✓ 90-Day Money-Back</span></div>`;

  if (embedMode) {
    // ---- MINIMAL PAYMENT FRAME (rendered inside the inline frame on /c) ----
    // Always mounts cleanly because it's a fresh page load; the main page swaps
    // this frame's src whenever shipping changes.
    const efbq = META_PIXEL_ID
      ? `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${META_PIXEL_ID}');</script>`
      : "";
    res.set("Content-Type", "text/html").send(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment</title>
<script async defer src="https://js.whop.com/static/checkout/loader.js"></script>${efbq}
<style>
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:transparent;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;-webkit-font-smoothing:antialiased}
#whop-embedded-checkout{min-height:280px}
#placeOrder{width:100%;padding:15px;border:0;border-radius:8px;background:${BRAND_ACCENT};color:#fff;font-size:16px;font-weight:600;cursor:pointer;margin-top:14px;transition:opacity .15s}
#placeOrder:hover{opacity:.88}#placeOrder:disabled{opacity:.45;cursor:default}
.trust{text-align:center;color:#8a8a8a;font-size:12.5px;margin-top:16px;line-height:1.7}
.trust b{color:#5a5a5a;font-weight:600}
</style></head><body>
<div id="pay-root">
  <div id="whop-embedded-checkout" data-whop-checkout-plan-id="${plan}"${session ? ` data-whop-checkout-session="${session}"` : ""} data-whop-checkout-theme="light" data-whop-checkout-hide-address="true" data-whop-checkout-style-container-padding-x="0" data-whop-checkout-style-container-padding-top="0" data-whop-checkout-return-url="${HOST_URL}/thanks" data-whop-checkout-hide-submit-button="true" data-whop-checkout-on-state-change="onWhopState" data-whop-checkout-on-complete="onWhopComplete"></div>
  <button id="placeOrder" disabled>Place Order &middot; ${money(amount)}</button>
  <div class="trust">🔒 <b>Secure SSL checkout</b> — your info is encrypted &amp; never stored.</div>
</div>
<script>
var ORIGIN='${HOST_URL}';
var PREVIEW=${previewMode ? "true" : "false"};
var btn=document.getElementById('placeOrder');
function post(m){try{parent.postMessage(m,ORIGIN);}catch(e){}}
function sendHeight(){post({type:'wh-height',h:Math.max(document.body.scrollHeight,document.documentElement.scrollHeight)});}
btn.addEventListener('click',function(){
  // Preview frame can't take payment — it has no shipping/address yet. Nudge the
  // buyer up to the address form instead of submitting a shipping-less charge.
  if(PREVIEW){ post({type:'wh-need-address'}); return; }
  btn.disabled=true;btn.textContent='Processing…';
  try{wco.submit('whop-embedded-checkout')}catch(e){console.error(e);btn.disabled=false;btn.textContent='Place Order · ${money(amount)}';}
});
window.onWhopState=function(state){
  // Button looks/behaves the same in preview and final (enabled once the card
  // is ready). In preview a click is intercepted above and routed to the address
  // form instead of charging, so no shipping-less order can slip through.
  try{if(state==='ready'){btn.disabled=false;}else if(state==='disabled'){btn.disabled=true;}}catch(e){}
  sendHeight();
};
window.onWhopComplete=async function(planId,receiptId){
  ${META_PIXEL_ID ? `try{fbq('track','Purchase',{value:${amount},currency:'USD'});}catch(e){}` : ""}
  try{await fetch(ORIGIN+'/order-complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({planId:planId||'${plan}',receiptId:receiptId})})}catch(e){}
  post({type:'wh-complete'});
  if(parent===window){document.getElementById('pay-root').innerHTML='<div style="text-align:center;padding:50px 0"><div style="font-size:50px">✅</div><h2>Order confirmed</h2><p style="color:#555">Thank you! A confirmation is in your inbox.</p></div>';}
};
try{new MutationObserver(sendHeight).observe(document.body,{childList:true,subtree:true,attributes:true});}catch(e){}
window.addEventListener('load',function(){sendHeight();setTimeout(sendHeight,600);setTimeout(sendHeight,1500);setTimeout(sendHeight,3000);});
</script>
</body></html>`);
    return;
  }

  // ---------- ADDRESS + SHIPPING STEP ----------
  const summary = `
      <button type="button" class="os-toggle" onclick="this.closest('.col-side').classList.toggle('open')"><span class="os-toggle-l">Order summary <span class="chev">⌄</span></span><span class="os-toggle-r" id="toggleTotal">${money(subtotal)}</span></button>
      <div class="os-body">
      <h2 class="os-h">Order summary</h2>
      <div class="os-items">${itemsHtml}</div>
      <div class="os-rows">
        <div class="os-row"><span>Subtotal</span><span>${money(subtotal)}</span></div>
        <div class="os-row"><span>Shipping</span><span id="sumShip">Enter address</span></div>
      </div>
      <div class="os-total"><span>Total</span><span><span class="os-cur">USD</span><span id="sumTotal">${money(subtotal)}</span></span></div>
      ${savingsHtml}
      ${badges}
      </div>`;
  res.set("Content-Type", "text/html").send(`${head}
  <div class="page">
    <main class="col-main"><div class="inner">
      <form id="shipForm" class="shipform" onsubmit="return false">
        <h2 class="sf-h">Shipping address</h2>
        <input class="sf-in" id="sf_name" placeholder="Full name" autocomplete="name">
        <input class="sf-in" id="sf_line1" placeholder="Address" autocomplete="address-line1">
        <input class="sf-in" id="sf_line2" placeholder="Apartment, suite, etc. (optional)" autocomplete="address-line2">
        <div class="sf-row">
          <input class="sf-in" id="sf_city" placeholder="City" autocomplete="address-level2">
          <select class="sf-in sf-country" id="sf_state" autocomplete="address-level1"><option value="" selected disabled>State</option>${stateOptions("")}</select>
          <input class="sf-in" id="sf_zip" placeholder="ZIP code" autocomplete="postal-code" inputmode="numeric">
        </div>
        <select class="sf-in sf-country" id="sf_country" autocomplete="country"><option value="US" selected>United States</option></select>
        <div id="sf_err" class="sf-err">Please complete your shipping address above.</div>
      </form>
      <h2 class="sec-h">Shipping method</h2>
      <div id="shipMethods" class="ship-methods"><div class="ship-note">Enter your shipping address to see available shipping methods.</div></div>
      <div id="paySection" class="pay-section">
        <div class="sf-paylabel">Contact &amp; payment</div>
        <div id="payLoading" class="pay-loading">Loading secure payment…</div>
        <iframe id="payFrame" class="pay-frame" allow="payment *" style="display:none" title="Payment"></iframe>
      </div>
    </div></main>
    <aside class="col-side"><div class="inner">${summary}</div></aside>
  </div>
</div>
<script>
var form=document.getElementById('shipForm');
var box=document.getElementById('shipMethods');
var paySection=document.getElementById('paySection');
var payFrame=document.getElementById('payFrame');
var payLoading=document.getElementById('payLoading');
var REQ=['sf_name','sf_line1','sf_city','sf_state','sf_zip'];
var rates=[], selIdx=-1, ratesKey='', ratesLoading=false, finalizeKey='', payMode='', revealDeb, deb;
var SUBTOTAL=${subtotal};
var ORIGIN='${HOST_URL}';
var PLAN='${plan}';
var SESSION='${session}';
function gv(id){var el=document.getElementById(id);return el?el.value.trim():'';}
function readShip(){return {name:gv('sf_name'),country:'US',line1:gv('sf_line1'),line2:gv('sf_line2'),city:gv('sf_city'),state:gv('sf_state'),postalCode:gv('sf_zip')};}
function validShip(){var ok=true;REQ.forEach(function(id){var el=document.getElementById(id);if(el){if(!el.value.trim()){el.classList.add('bad');ok=false;}else{el.classList.remove('bad');}}});form.classList.toggle('invalid',!ok);return ok;}
function money(n){return '$'+(Number(n)||0).toFixed(2);}
function updateSummary(){
  var ship = selIdx>=0 ? rates[selIdx].price : null;
  var shipCell=document.getElementById('sumShip');
  var totalCell=document.getElementById('sumTotal');
  var toggleR=document.getElementById('toggleTotal');
  if(ship==null){ if(shipCell){shipCell.textContent='Enter address';shipCell.className='';} }
  else if(shipCell){ shipCell.textContent = ship===0?'FREE':money(ship); shipCell.className = ship===0?'os-free':''; }
  var tot = SUBTOTAL + (ship||0);
  if(totalCell)totalCell.textContent=money(tot);
  if(toggleR)toggleR.textContent=money(tot);
}
function previewUrl(){ return ORIGIN+'/c?plan='+encodeURIComponent(PLAN)+'&session='+encodeURIComponent(SESSION)+'&embed=1&preview=1'; }
// Payment is always on screen. When there's no valid address/shipping yet we
// show the PREVIEW frame (subtotal only; a Place Order click routes to the
// address form) instead of hiding it.
function showPreview(){
  if(payMode==='preview') return;        // already showing the preview frame
  payMode='preview'; finalizeKey='';
  payLoading.style.display='block'; payLoading.textContent='Loading secure payment…';
  payFrame.style.display='none';
  payFrame.src=previewUrl();
}
function renderRates(list){
  rates=list||[]; selIdx = rates.length?0:-1;
  if(!rates.length){ box.innerHTML='<div class="ship-note">No shipping options are available for this address.</div>'; updateSummary(); showPreview(); return; }
  var html='';
  rates.forEach(function(r,i){
    html += '<label class="ship-opt'+(i===0?' sel':'')+'" data-i="'+i+'"><input type="radio" name="shipopt" '+(i===0?'checked':'')+'><span class="so-t">'+r.title+'</span><span class="so-p">'+(r.price===0?'FREE':money(r.price))+'</span></label>';
  });
  box.innerHTML=html;
  [].forEach.call(box.querySelectorAll('.ship-opt'),function(el){
    el.addEventListener('click',function(){
      selIdx=parseInt(el.getAttribute('data-i'),10);
      [].forEach.call(box.querySelectorAll('.ship-opt'),function(o){o.classList.remove('sel');});
      el.classList.add('sel'); var radio=el.querySelector('input'); if(radio)radio.checked=true;
      updateSummary(); revealPayment();
    });
  });
  updateSummary(); revealPayment();
}
async function fetchRates(){
  if(!validShip()){ box.innerHTML='<div class="ship-note">Enter your shipping address to see available shipping methods.</div>'; rates=[];selIdx=-1; updateSummary(); showPreview(); return; }
  var addr=readShip();
  var key=[addr.line1,addr.city,addr.state,addr.postalCode].join('|');
  if(key===ratesKey && rates.length){ revealPayment(); return; }
  ratesKey=key; ratesLoading=true;
  box.innerHTML='<div class="ship-note">Calculating shipping…</div>';
  try{
    var r=await fetch(ORIGIN+'/shipping/rates',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan:PLAN,address:addr})}).then(function(x){return x.json();});
    ratesLoading=false;
    if(key!==ratesKey) return;
    renderRates(r.rates||[]);
  }catch(e){ ratesLoading=false; box.innerHTML='<div class="ship-note">Could not load shipping — please re-check your address.</div>'; showPreview(); }
}
function revealPayment(){
  if(!(validShip() && rates.length && selIdx>=0)){ showPreview(); return; }
  clearTimeout(revealDeb); revealDeb=setTimeout(doFinalize,350);
}
async function doFinalize(){
  if(!(validShip() && rates.length && selIdx>=0)) return;
  var addr=readShip();
  var key=[addr.name,addr.line1,addr.line2,addr.city,addr.state,addr.postalCode,rates[selIdx].handle].join('|');
  if(key===finalizeKey && payMode===key) return;   // already mounted for this exact selection
  finalizeKey=key;
  payLoading.style.display='block'; payLoading.textContent='Updating total…'; payFrame.style.display='none';
  try{
    var resp=await fetch(ORIGIN+'/checkout/finalize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan:PLAN,address:addr,handle:rates[selIdx].handle,title:rates[selIdx].title})}).then(function(x){return x.json();});
    if(!resp||!resp.plan)throw new Error('finalize');
    if(finalizeKey!==key) return;
    payMode=key;                                    // live, payable frame for subtotal+shipping
    payFrame.src=ORIGIN+'/c?plan='+encodeURIComponent(resp.plan)+'&session='+encodeURIComponent(resp.session||'')+'&embed=1';
  }catch(e){ payLoading.textContent='Could not load payment — please try again.'; finalizeKey=''; payMode=''; }
}
payFrame.addEventListener('load',function(){ try{ if(payFrame.src && payFrame.src.indexOf('embed=1')>-1){ payFrame.style.display='block'; payLoading.style.display='none'; } }catch(e){} });
window.addEventListener('message',function(e){
  if(e.origin!==ORIGIN) return;
  var d=e.data||{};
  if(d.type==='wh-height' && d.h){ payFrame.style.height=(Number(d.h)+6)+'px'; }
  else if(d.type==='wh-need-address'){
    // Buyer clicked the locked preview button — send them to the first missing field.
    validShip();
    var bad=form.querySelector('.bad')||document.getElementById('sf_name');
    if(bad){ try{bad.focus();}catch(_){} bad.scrollIntoView({behavior:'smooth',block:'center'}); }
  }
  else if(d.type==='wh-complete'){
    ${META_PIXEL_ID ? `try{fbq('track','Purchase',{value:SUBTOTAL+(selIdx>=0?rates[selIdx].price:0),currency:'USD'});}catch(e){}` : ""}
    document.getElementById('checkout-root').innerHTML='<div style="max-width:520px;margin:80px auto;padding:0 24px;text-align:center"><div style="font-size:54px;line-height:1">✅</div><h1 style="font-size:24px;margin:14px 0 8px">Order confirmed</h1><p style="color:#555;font-size:15px;line-height:1.6">Thank you for your order! It\\'s on its way and a confirmation email is in your inbox.</p></div>';
  }
});
REQ.concat(['sf_line2']).forEach(function(id){var el=document.getElementById(id);if(el){
  el.addEventListener('input',function(){el.classList.remove('bad');if(!form.querySelector('.bad'))form.classList.remove('invalid');clearTimeout(deb);deb=setTimeout(fetchRates,500);});
  el.addEventListener('change',function(){clearTimeout(deb);fetchRates();});
}});
updateSummary();
showPreview();   // mount the visible payment embed immediately on load (subtotal)
</script>
</body></html>`);
});

// On completion the page posts here -> create the paid Shopify order (with the
// stored shipping address + shipping line) and fire Meta server-side.
app.post("/order-complete", express.json(), async (req, res) => {
  const { planId, receiptId, address } = req.body || {};
  if (!planId) return res.status(400).json({ error: "missing plan" });
  if (processedPayments.has(planId)) return res.json({ ok: true, deduped: true });
  const cart = cartByPlan.get(planId) || {};
  const lineItems = cart.lineItems || [];
  if (!lineItems.length) { console.error("[order-complete] no cart for", planId); return res.status(404).json({ error: "no cart" }); }
  const ship = cart.address || address || {};
  processedPayments.add(planId); // claim; released below if the order fails
  try {
    await createShopifyOrder({
      payment: { id: receiptId || planId, amount: cart.amount },
      lineItems, email: cart.email, ship, shipping: cart.shipping || null,
    });
    fireMetaPurchase({ value: cart.amount, email: cart.email, address: ship }).catch((e) => console.error("[meta]", e));
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
  if (address && (address.postalCode || address.zip)) user_data.zp = [h(address.postalCode || address.zip)];
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

  console.log("[webhook] type:", event.type, "| data:", JSON.stringify(event.data));
  const ORDER_TRIGGERS = new Set(["invoice.paid", "membership.activated", "payment.succeeded"]);
  if (!ORDER_TRIGGERS.has(event.type)) return;
  const payment = event.data || {};
  const planId = payment.plan && payment.plan.id;
  const dedupeKey = planId || payment.id;
  // Give the on-page /order-complete a head start so the order is created from
  // our stored cart (with shipping + address). The webhook is the fallback.
  await new Promise((r) => setTimeout(r, 8000));
  if (dedupeKey && processedPayments.has(dedupeKey)) return;
  if (dedupeKey) processedPayments.add(dedupeKey);

  try {
    const stored = (planId && cartByPlan.get(planId)) || {};
    const meta = payment.metadata || {};
    const lineItems = stored.lineItems || JSON.parse(meta.shopify_line_items || "[]");
    const email = (payment.user && payment.user.email) || stored.email || meta.email;
    const ship = stored.address || payment.shipping_address || payment.address || {};
    if (!lineItems.length) { console.error("[webhook] no cart on file for plan", planId); return; }
    const amount = Number(payment && payment.amount) > 0 ? Number(payment.amount) : stored.amount;
    await createShopifyOrder({ payment: { id: payment.id, amount }, lineItems, email, ship, shipping: stored.shipping || null });
  } catch (err) {
    console.error("[webhook] Shopify order failed", err);
    if (dedupeKey) processedPayments.delete(dedupeKey); // release so /order-complete or a retry can recover
  }
});

async function createShopifyOrder({ payment, lineItems, email, ship, shipping }) {
  if (!shopifyToken) throw new Error("No Shopify token yet — visit HOST_URL/auth once.");
  const hasAddr = ship && (ship.line1 || ship.address1);
  const shipPrice = shipping && Number(shipping.price) > 0 ? Math.round(Number(shipping.price) * 100) / 100 : 0;
  // Whop's membership.activated webhook sends amount 0, which Shopify rejects
  // ("Amount must be greater than zero"). Fall back to the cart's line-item
  // total + shipping so the transaction always carries the real amount.
  let txAmount = Number(payment && (payment.amount ?? payment.final_amount));
  if (!(txAmount > 0)) {
    txAmount = lineItems.reduce((s, li) => s + (Number(li.price) || 0) * (Number(li.quantity) || 1), 0) + shipPrice;
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
      shipping_lines: shipping ? [{
        title: shipping.title || "Shipping",
        price: shipPrice.toFixed(2),
        code: shipping.title || "Shipping",
        source: "Whop",
      }] : undefined,
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
  console.log("[shopify] order created:", r.order?.name, "| shipping:", shipping ? `${shipping.title} ${shipPrice}` : "none");
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
  // Request the full scope set incl. write_draft_orders (needed for live
  // shipping-rate lookups via draftOrderCalculate). Hardcoded so it's correct
  // regardless of any SHOPIFY_SCOPES env override.
  const authScopes = "write_orders,read_orders,read_products,write_draft_orders";
  const url =
    `https://${SHOPIFY_STORE}/admin/oauth/authorize` +
    `?client_id=${SHOPIFY_API_KEY}` +
    `&scope=${encodeURIComponent(authScopes)}` +
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
// Apple sees it at our domain, with zero downtime and no DNS repointing.
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
app.get("/", (_req, res) => res.redirect(302, STORE_URL));
app.listen(PORT, () => console.log(`Bridge listening on :${PORT}`));
