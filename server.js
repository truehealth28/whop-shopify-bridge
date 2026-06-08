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
// Google Places (New) key — injected into the checkout page for client-side
// address autocomplete. Stored ONLY as a Railway env var (never committed), and
// the key is locked to the shoptruehealth.com domain. Empty -> free Photon.
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || "";
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
// 0) APPLE PAY domain verification for embedded checkout.
//    Whop registers Apple Pay via a UNIVERSAL association file hosted at
//    whop.com/.well-known/apple-platform-integrator/... . We proxy those exact
//    bytes at the path Apple/Whop checks so this domain (and the apex it serves)
//    can be verified. See https://docs.whop.com/payments/apple-pay
// ============================================================================
const APPLE_PAY_ASSOC_URL =
  "https://whop.com/.well-known/apple-platform-integrator/apple-developer-merchantid-domain-association";
app.get("/.well-known/apple-developer-merchantid-domain-association", async (_req, res) => {
  try {
    const r = await fetch(APPLE_PAY_ASSOC_URL);
    if (!r.ok) throw new Error("upstream " + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    res.set("Content-Type", "application/octet-stream");
    res.set("Cache-Control", "public, max-age=3600");
    res.send(buf);
  } catch (e) {
    console.error("[apple-pay] association proxy failed:", e.message);
    res.status(502).send("association fetch failed");
  }
});

// ============================================================================
// 0b) LEGAL / POLICY PAGES — served on the checkout domain, linked in the footer.
// ============================================================================
const LEGAL_EMAIL = "support@shoptruehealth.com";
const LEGAL = {
  refund: { title: "Refund Policy", body: `<p>We stand behind every TrueHealthic product with a <strong>60-Day Money-Back Guarantee</strong>. If you are not completely satisfied with your purchase, we will make it right.</p><h2>Returns &amp; refunds</h2><p>You have 60 days from the date of delivery to request a refund. Simply email us at <a href="mailto:${LEGAL_EMAIL}">${LEGAL_EMAIL}</a> with your order number — opened or unopened, your satisfaction is covered.</p><p>Once your request is approved, your refund is issued to your original payment method within 5–10 business days. You'll receive an email confirmation once it has been processed.</p><h2>Late or missing refunds</h2><p>If you haven't received your refund after 10 business days, please check with your bank or card provider first, as processing times vary. If you still need help, contact us at <a href="mailto:${LEGAL_EMAIL}">${LEGAL_EMAIL}</a>.</p><h2>Damaged or wrong items</h2><p>If your order arrives damaged or incorrect, email us within 30 days of delivery with a photo and your order number and we'll send a replacement or full refund at no cost to you.</p>` },
  shipping: { title: "Shipping Policy", body: `<p>We're proud to ship TrueHealthic orders quickly from within the USA.</p><h2>Processing time</h2><p>Orders are processed within 1–2 business days (Monday–Friday, excluding holidays). You'll receive a confirmation email with tracking as soon as your order ships.</p><h2>Delivery time</h2><p>Standard Shipping within the United States typically arrives in <strong>10–14 business days</strong>. Priority Processing (Expedited Shipping) typically arrives in <strong>4–7 business days</strong>. Your available shipping options and rates are shown at checkout.</p><h2>Shipping rates</h2><p>Shipping is calculated at checkout based on your address. Orders over the threshold shown in your cart qualify for free standard shipping.</p><h2>Tracking</h2><p>A tracking number is emailed to you once your order ships. If you haven't received tracking within 3 business days, email us at <a href="mailto:${LEGAL_EMAIL}">${LEGAL_EMAIL}</a>.</p><h2>Questions</h2><p>For any shipping questions, reach us at <a href="mailto:${LEGAL_EMAIL}">${LEGAL_EMAIL}</a>.</p>` },
  privacy: { title: "Privacy Policy", body: `<p>TrueHealthic respects your privacy. This policy explains what information we collect and how we use it.</p><h2>Information we collect</h2><p>When you place an order we collect the information needed to fulfill it: your name, shipping address, email address, and payment details. Payment details are handled securely by our payment processor and are never stored on our servers.</p><h2>How we use your information</h2><p>We use your information to process and ship your order, provide customer support, send order updates, and — where you've opted in — share offers and news. We do not sell your personal information.</p><h2>Sharing</h2><p>We share information only with the partners required to complete your order, such as our payment processor and shipping carriers, and only as needed to provide the service.</p><h2>Security</h2><p>All transactions are encrypted using industry-standard SSL. We take reasonable measures to protect your information.</p><h2>Your rights &amp; contact</h2><p>You may request access to, correction of, or deletion of your personal information at any time by emailing <a href="mailto:${LEGAL_EMAIL}">${LEGAL_EMAIL}</a>.</p>` },
  terms: { title: "Terms of Service", body: `<p>This website is operated by TrueHealthic. By visiting our site and/or purchasing from us, you agree to be bound by the following terms and conditions.</p><h2>Online store terms</h2><p>By agreeing to these terms, you represent that you are at least the age of majority in your state or province of residence. You may not use our products for any illegal or unauthorized purpose.</p><h2>Products &amp; pricing</h2><p>Product descriptions and pricing are subject to change at any time without notice. We reserve the right to limit quantities or refuse any order at our sole discretion.</p><h2>Health disclaimer</h2><p>These statements have not been evaluated by the Food and Drug Administration. Our products are not intended to diagnose, treat, cure, or prevent any disease. Consult your physician before starting any supplement.</p><h2>Payment</h2><p>By submitting your payment information you authorize us to charge the applicable amount to your selected payment method. All payments are processed securely.</p><h2>Changes to these terms</h2><p>We may update these terms at any time by posting changes to this page. Continued use of the site constitutes acceptance of those changes.</p><h2>Contact</h2><p>Questions about these Terms of Service can be sent to <a href="mailto:${LEGAL_EMAIL}">${LEGAL_EMAIL}</a>.</p>` },
  cancellations: { title: "Cancellation Policy", body: `<p>Need to cancel? We process orders quickly, so please contact us as soon as possible.</p><h2>How to cancel</h2><p>To cancel an order, email <a href="mailto:${LEGAL_EMAIL}">${LEGAL_EMAIL}</a> with your order number within <strong>24 hours</strong> of placing it. If your order has not yet shipped, we'll cancel it and issue a full refund.</p><h2>After your order ships</h2><p>If your order has already shipped, it can't be canceled — but you're still fully covered by our 60-Day Money-Back Guarantee. Simply return it under our <a href="${HOST_URL}/legal/refund">Refund Policy</a>.</p><h2>Questions</h2><p>We're happy to help at <a href="mailto:${LEGAL_EMAIL}">${LEGAL_EMAIL}</a>.</p>` },
  contact: { title: "Contact Us", body: `<p>Questions about your order or our products? We're here to help.</p><p>Email us anytime at <a href="mailto:${LEGAL_EMAIL}">${LEGAL_EMAIL}</a> and our team will get back to you within 24 hours, 7 days a week.</p>` },
};
function legalPage(p){
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${p.title} — ${BRAND_NAME}</title>
<style>*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#222;line-height:1.7;background:#fff;-webkit-font-smoothing:antialiased}
.lh{border-bottom:1px solid #ececec;text-align:center;padding:20px}.lh a{font-size:22px;font-weight:800;color:${BRAND_ACCENT};text-decoration:none;letter-spacing:-.02em}
.lw{max-width:740px;margin:0 auto;padding:42px 22px 90px}.lw h1{font-size:28px;margin:0 0 4px;color:#111}.lw h2{font-size:18px;margin:26px 0 4px;color:#1a1a1a}.lw p{margin:10px 0;color:#454545}.lw a{color:${BRAND_ACCENT}}
.lb{display:inline-block;margin-top:34px;color:${BRAND_ACCENT};text-decoration:none;font-weight:600;font-size:14px}</style></head>
<body><div class="lh"><a href="${STORE_URL}">${BRAND_NAME}</a></div><div class="lw"><h1>${p.title}</h1>${p.body}<a class="lb" href="${STORE_URL}">&larr; Back to ${BRAND_NAME}</a></div></body></html>`;
}
app.get("/legal/:slug", (req, res) => {
  const p = LEGAL[String(req.params.slug || "").toLowerCase()];
  if (!p) return res.redirect(302, STORE_URL);
  res.set("Content-Type", "text/html").set("Cache-Control", "public, max-age=600").send(legalPage(p));
});

// ============================================================================
// 1) STOREFRONT  ->  stash the live cart, send buyer to the address step
// ============================================================================
app.post("/checkout/create", express.json(), async (req, res) => {
  try {
    const { items = [], cartToken = null, email = null, cartTotal = null } = req.body;
    if (!items.length) return res.status(400).json({ error: "empty cart" });

    // Charge the cart's REAL total AFTER discounts (Buy 2 Get 1, automatic
    // discounts, etc.). Prefer the exact discounted total the storefront sends;
    // otherwise sum the discounted per-line prices; only as a last resort fall
    // back to unit price x quantity (legacy snippet that didn't send discounts).
    const total = (cartTotal != null && Number(cartTotal) > 0)
      ? Number(cartTotal)
      : items.reduce((sum, it) => sum +
          (it.linePrice != null ? Number(it.linePrice)
                                : Number(it.price) * Number(it.quantity || 1)), 0);

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
          external_identifier: WHOP_PRODUCT_EXTERNAL_ID + "-th-noship",
          title: "TrueHealthic Order",
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
        price: Number(it.price) || 0,                 // discounted per-unit price
        linePrice: it.linePrice != null              // discounted line total
          ? Number(it.linePrice)
          : (Number(it.price) || 0) * (Number(it.quantity) || 1),
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

// Customer-facing names for the shipping options. Standard -> "Standard
// Shipping", any fast/expedited option -> "Priority Processing (Expedited
// Shipping)". Free options keep their own wording (prices are never changed).
function displayShippingTitle(title, price) {
  if (Number(price) === 0) return title; // leave free shipping as-is
  if (/express|expedited|priority|overnight|rush|next.?day|2.?day|fast/i.test(String(title || ""))) {
    return "Priority Processing (Expedited Shipping)";
  }
  return "Standard Shipping";
}
function relabelRates(rates) {
  return (rates || []).map((r) => ({ ...r, title: displayShippingTitle(r.title, r.price) }));
}

// Prefer live Shopify rates; fall back to the configured table so the checkout
// never blocks if the live lookup is unavailable. Titles are normalized to the
// customer-facing names; handle + price are preserved so finalize still matches.
async function shopifyShippingRates(lineItems, address) {
  const subtotal = (lineItems || []).reduce((s, li) => s + (Number(li.price) || 0) * (Number(li.quantity) || 1), 0);
  try {
    const live = await liveShopifyRates(lineItems, address);
    if (live.rates.length) return relabelRates(live.rates);
  } catch (e) { console.error("[rates] live lookup threw", e.message); }
  return relabelRates(builtinRates(subtotal));
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
          external_identifier: WHOP_PRODUCT_EXTERNAL_ID + "-th-noship",
          title: "TrueHealthic Order",
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
.pay-frames{position:relative}
.pf-incoming{position:absolute;left:0;top:0;width:100%;opacity:0;pointer-events:none}
.pf-hide{display:none}
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
.sf-ac{position:relative}
.ac-list{position:absolute;left:0;right:0;top:calc(100% - 6px);background:#fff;border:1px solid #d9d9d9;border-radius:8px;box-shadow:0 8px 26px rgba(0,0,0,.13);z-index:60;overflow:hidden;display:none}
.ac-list.show{display:block}
.ac-item{padding:11px 13px;font-size:14px;color:#1a1a1a;cursor:pointer;border-bottom:1px solid #f1f1f1;display:flex;gap:9px;align-items:flex-start;line-height:1.35}
.ac-item:last-child{border-bottom:0}
.ac-item:hover,.ac-item.active{background:#f4f7fb}
.ac-pin{flex:0 0 auto;font-size:13px;margin-top:1px}
.ac-main{font-weight:600}
.ac-sub{color:#8a8a8a;font-size:12.5px}
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
.ck-foot{max-width:1000px;margin:0 auto;padding:24px 20px 40px;display:flex;flex-wrap:wrap;gap:9px 22px;justify-content:center;border-top:1px solid #ededed}
.ck-foot a{color:#8a8a8a;font-size:13px;text-decoration:none}
.ck-foot a:hover{color:#16264a;text-decoration:underline}
.pol-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:none;align-items:flex-start;justify-content:center;z-index:2000;padding:40px 16px;overflow-y:auto;-webkit-overflow-scrolling:touch}
.pol-overlay.show{display:flex}
.pol-modal{background:#fff;border-radius:12px;max-width:560px;width:100%;padding:32px 32px 38px;position:relative;box-shadow:0 24px 70px rgba(0,0,0,.32);margin:auto}
.pol-x{position:absolute;top:14px;right:15px;background:none;border:0;font-size:27px;line-height:1;color:#999;cursor:pointer;padding:4px 8px;border-radius:8px}
.pol-x:hover{color:#222;background:#f3f3f3}
.pol-title{font-size:23px;font-weight:700;margin:0 0 8px;color:#111;padding-right:30px}
.pol-body{color:#454545;line-height:1.7;font-size:14.5px}
.pol-body h2{font-size:16px;font-weight:700;margin:20px 0 4px;color:#1a1a1a}
.pol-body p{margin:9px 0}
.pol-body ul,.pol-body ol{margin:9px 0;padding-left:22px}
.pol-body li{margin:4px 0}
.pol-body a{color:#16264a}
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
  const badges = `<div class="badges"><span>🇺🇸 Made in USA</span><span>✓ GMP Certified</span><span>✓ 60-Day Money-Back</span></div>`;

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
function sendHeight(){var last=document.querySelector('.trust')||document.getElementById('placeOrder')||document.body;var h=Math.ceil(last.getBoundingClientRect().bottom+window.scrollY+4);post({type:'wh-height',h:h});}
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
  post({type:'wh-complete'});
  if(parent===window){document.getElementById('pay-root').innerHTML='<div style="text-align:center;padding:50px 0"><div style="font-size:50px">✅</div><h2>Order confirmed</h2><p style="color:#555">Thank you! A confirmation is in your inbox.</p></div>';}
  // Create the Shopify order in the BACKGROUND so the buyer sees their confirmation
  // immediately. keepalive lets it finish even if the page changes; the Whop
  // webhook is a fallback if this request is ever dropped.
  try{fetch(ORIGIN+'/order-complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({planId:planId||'${plan}',receiptId:receiptId}),keepalive:true}).catch(function(){});}catch(e){}
};
try{new MutationObserver(sendHeight).observe(document.body,{childList:true,subtree:true,attributes:true});}catch(e){}
window.addEventListener('load',function(){sendHeight();setTimeout(sendHeight,600);setTimeout(sendHeight,1500);setTimeout(sendHeight,3000);});
</script>
</body></html>`);
    return;
  }

  // ---------- ADDRESS + SHIPPING STEP ----------
  const policiesJson = JSON.stringify(LEGAL).replace(/</g, "\\u003c");
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
        <div class="sf-row">
          <input class="sf-in" id="sf_fname" placeholder="First name" autocomplete="given-name">
          <input class="sf-in" id="sf_lname" placeholder="Last name" autocomplete="family-name">
        </div>
        <div class="sf-ac"><input class="sf-in" id="sf_line1" placeholder="Start typing your address…" autocomplete="off"><div class="ac-list" id="acList"></div></div>
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
        <div id="payFrames" class="pay-frames">
          <iframe id="payFrame" class="pay-frame pf-hide" allow="payment *" title="Payment"></iframe>
          <iframe id="payFrame2" class="pay-frame pf-hide" allow="payment *" title="Payment"></iframe>
        </div>
      </div>
    </div></main>
    <aside class="col-side"><div class="inner">${summary}</div></aside>
  </div>
  <footer class="ck-foot">
    <a href="${HOST_URL}/legal/refund" data-pol="refund">Refund policy</a>
    <a href="${HOST_URL}/legal/shipping" data-pol="shipping">Shipping policy</a>
    <a href="${HOST_URL}/legal/privacy" data-pol="privacy">Privacy policy</a>
    <a href="${HOST_URL}/legal/terms" data-pol="terms">Terms of service</a>
    <a href="${HOST_URL}/legal/cancellations" data-pol="cancellations">Cancellations</a>
    <a href="${HOST_URL}/legal/contact" data-pol="contact">Contact</a>
  </footer>
  <div id="polOverlay" class="pol-overlay"><div class="pol-modal"><button class="pol-x" id="polX" aria-label="Close">&times;</button><h2 class="pol-title" id="polTitle"></h2><div class="pol-body" id="polBody"></div></div></div>
</div>
<script>
var form=document.getElementById('shipForm');
var box=document.getElementById('shipMethods');
var paySection=document.getElementById('paySection');
var frames=[document.getElementById('payFrame'),document.getElementById('payFrame2')];
var activeIdx=0;
var payFrame=frames[0];   // always points at the visible/active payment frame
var payLoading=document.getElementById('payLoading');
var REQ=['sf_fname','sf_lname','sf_line1','sf_city','sf_state','sf_zip'];
var rates=[], selIdx=-1, ratesKey='', ratesLoading=false, finalizeKey='', payMode='', revealDeb, deb;
var SUBTOTAL=${subtotal};
var ORIGIN='${HOST_URL}';
var PLAN='${plan}';
var GMAPS_KEY=${JSON.stringify(GOOGLE_MAPS_KEY)};
var SESSION='${session}';
function gv(id){var el=document.getElementById(id);return el?el.value.trim():'';}
function readShip(){return {name:(gv('sf_fname')+' '+gv('sf_lname')).trim(),country:'US',line1:gv('sf_line1'),line2:gv('sf_line2'),city:gv('sf_city'),state:gv('sf_state'),postalCode:gv('sf_zip')};}
// validShip(): silent boolean check — never touches the red outline. Used to gate
// shipping-rate and payment loading as the buyer fills the form.
function validShip(){var ok=true;REQ.forEach(function(id){var el=document.getElementById(id);if(el&&!el.value.trim())ok=false;});return ok;}
// markInvalid(): the ONLY thing that applies the red outline + error note — fired
// only when the buyer tries to place the order with a required field still empty.
function markInvalid(){var ok=true;REQ.forEach(function(id){var el=document.getElementById(id);if(el){if(!el.value.trim()){el.classList.add('bad');ok=false;}else{el.classList.remove('bad');}}});form.classList.toggle('invalid',!ok);return ok;}
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
  loadPay(previewUrl());
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
  try{
    var resp=await fetch(ORIGIN+'/checkout/finalize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan:PLAN,address:addr,handle:rates[selIdx].handle,title:rates[selIdx].title})}).then(function(x){return x.json();});
    if(!resp||!resp.plan)throw new Error('finalize');
    if(finalizeKey!==key) return;
    payMode=key;                                    // live, payable frame for subtotal+shipping
    loadPay(ORIGIN+'/c?plan='+encodeURIComponent(resp.plan)+'&session='+encodeURIComponent(resp.session||'')+'&embed=1');
  }catch(e){ finalizeKey=''; payMode=''; }
}
// ---- Seamless payment swap: load the new total into the spare frame (rendered
// but invisible), then swap it in once ready, so the bottom half never blanks. ----
function activate(fr){
  fr.__incoming=false;
  fr.className='pay-frame';                          // visible, in normal flow
  var prev=frames[0]===fr?frames[1]:frames[0];
  if(prev && prev!==fr) prev.className='pay-frame pf-hide';
  activeIdx=frames[0]===fr?0:1;
  payFrame=fr;
  payLoading.style.display='none';
}
function payVisible(){ var f=frames[activeIdx]; return f && f.className.indexOf('pf-hide')<0 && f.className.indexOf('pf-incoming')<0; }
function loadPay(url){
  if(!payVisible()){
    // First payment on screen: show the loader until this frame is ready.
    var f0=frames[activeIdx];
    payLoading.style.display='block';
    f0.__incoming=false;
    f0.src=url;
    return;
  }
  // A frame is already visible — load the new total into the spare frame,
  // rendered but invisible, and only swap it in once it has loaded.
  var loader=frames[1-activeIdx];
  loader.__incoming=true;
  loader.className='pay-frame pf-incoming';
  clearTimeout(loader.__t);
  loader.src=url;
}
frames.forEach(function(fr){
  fr.addEventListener('load',function(){
    if(!(fr.src && fr.src.indexOf('embed=1')>-1)) return;
    if(fr.__incoming){ clearTimeout(fr.__t); fr.__t=setTimeout(function(){ activate(fr); },400); }
    else { activate(fr); }
  });
});
window.addEventListener('message',function(e){
  if(e.origin!==ORIGIN) return;
  var d=e.data||{};
  if(d.type==='wh-height' && d.h){ for(var _i=0;_i<frames.length;_i++){ if(e.source===frames[_i].contentWindow){ frames[_i].style.height=(Number(d.h)+6)+'px'; break; } } }
  else if(d.type==='wh-need-address'){
    // Buyer clicked the locked preview button — send them to the first missing field.
    markInvalid();
    var bad=form.querySelector('.bad')||document.getElementById('sf_fname');
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

// ---- Address autocomplete (Google Places New when key is set, free Photon fallback) ----
(function(){
  var acInput=document.getElementById('sf_line1');
  var acList=document.getElementById('acList');
  if(!acInput||!acList) return;
  var US_STATES=${JSON.stringify(US_STATES)};
  var STATE_BY_NAME={}; for(var _k in US_STATES){STATE_BY_NAME[US_STATES[_k].toLowerCase()]=_k;}
  var acDeb,acItems=[],acActive=-1,acLast='';
  function acHide(){acList.classList.remove('show');acList.innerHTML='';acActive=-1;}
  function setV(id,v){var el=document.getElementById(id);if(el&&v){el.value=v;el.classList.remove('bad');}}
  function esc(s){return String(s||'').replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function fillAddr(o){
    setV('sf_line1',o.line1); setV('sf_city',o.city); setV('sf_zip',o.zip);
    if(o.stateCode){var sel=document.getElementById('sf_state');if(sel)sel.value=o.stateCode;}
    acHide();
    if(form && !form.querySelector('.bad'))form.classList.remove('invalid');
    GSESSION=guid();   // fresh Places session token after each completed selection
    try{fetchRates();}catch(e){}
  }
  function acPick(it){
    if(it.placeId){ gDetails(it.placeId, it.main); }  // Google: look up the full address
    else { fillAddr(it); }                             // Photon: already has the parts
  }
  function acRender(){
    if(!acItems.length){acHide();return;}
    acList.innerHTML=acItems.map(function(it,i){return '<div class="ac-item'+(i===acActive?' active':'')+'" data-i="'+i+'"><span><span class="ac-main">'+esc(it.main)+'</span><br><span class="ac-sub">'+esc(it.sub)+'</span></span></div>';}).join('');
    acList.classList.add('show');
    [].forEach.call(acList.querySelectorAll('.ac-item'),function(el){el.addEventListener('mousedown',function(ev){ev.preventDefault();acPick(acItems[parseInt(el.getAttribute('data-i'),10)]);});});
  }
  // Google Places (New). The session token bundles autocomplete+details into one
  // cheap billable session. Any Google hiccup quietly falls back to free Photon.
  function guid(){return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0;return (c==='x'?r:(r&0x3|0x8)).toString(16);});}
  var GSESSION=guid();
  function gSearch(q){
    fetch('https://places.googleapis.com/v1/places:autocomplete',{method:'POST',headers:{'Content-Type':'application/json','X-Goog-Api-Key':GMAPS_KEY},body:JSON.stringify({input:q,includedRegionCodes:['us'],sessionToken:GSESSION})})
      .then(function(x){if(!x.ok)throw new Error('g'+x.status);return x.json();})
      .then(function(d){
        var sugs=(d&&d.suggestions)||[]; acItems=[];
        sugs.forEach(function(s){var p=s.placePrediction; if(!p)return;
          var sf=p.structuredFormat||{};
          var main=(sf.mainText&&sf.mainText.text)||(p.text&&p.text.text)||'';
          var sub=(sf.secondaryText&&sf.secondaryText.text)||'';
          if(main)acItems.push({placeId:p.placeId,main:main,sub:sub});
        });
        acActive=-1; acRender();
      }).catch(function(){ pSearch(q); });
  }
  function gDetails(placeId,fallbackMain){
    fetch('https://places.googleapis.com/v1/places/'+encodeURIComponent(placeId)+'?sessionToken='+encodeURIComponent(GSESSION),{headers:{'X-Goog-Api-Key':GMAPS_KEY,'X-Goog-FieldMask':'addressComponents'}})
      .then(function(x){return x.json();})
      .then(function(d){
        var comps=(d&&d.addressComponents)||[];
        function g(t,w){for(var i=0;i<comps.length;i++){if((comps[i].types||[]).indexOf(t)>=0)return w==='short'?comps[i].shortText:comps[i].longText;}return '';}
        var num=g('street_number'),route=g('route');
        fillAddr({line1:((num?num+' ':'')+route).trim()||fallbackMain,city:g('locality')||g('postal_town')||g('sublocality')||g('administrative_area_level_2'),stateCode:g('administrative_area_level_1','short'),zip:g('postal_code')});
      }).catch(function(){ fillAddr({line1:fallbackMain}); });
  }
  function pSearch(q){
    fetch('https://photon.komoot.io/api/?q='+encodeURIComponent(q)+'&limit=6&lang=en&lat=39.8&lon=-98.6').then(function(x){return x.json();}).then(function(r){
      var feats=(r&&r.features)||[]; acItems=[];
      feats.forEach(function(f){
        var p=f.properties||{};
        if(p.countrycode&&p.countrycode!=='US')return;
        var street=((p.housenumber?p.housenumber+' ':'')+(p.street||p.name||'')).trim();
        if(!street)return;
        var city=p.city||p.town||p.village||p.county||'';
        var stateCode=STATE_BY_NAME[(p.state||'').toLowerCase()]||'';
        var zip=p.postcode||'';
        acItems.push({line1:street,city:city,zip:zip,stateCode:stateCode,main:street,sub:[city,(stateCode||p.state||''),zip].filter(Boolean).join(', ')});
      });
      acActive=-1; acRender();
    }).catch(function(){acHide();});
  }
  function acSearch(q){ if(GMAPS_KEY){gSearch(q);}else{pSearch(q);} }
  acInput.addEventListener('input',function(){
    var q=acInput.value.trim(); if(q===acLast)return; acLast=q;
    clearTimeout(acDeb);
    if(q.length<4){acHide();return;}
    acDeb=setTimeout(function(){acSearch(q);},260);
  });
  acInput.addEventListener('keydown',function(e){
    if(!acList.classList.contains('show'))return;
    if(e.key==='ArrowDown'){e.preventDefault();acActive=Math.min(acActive+1,acItems.length-1);acRender();}
    else if(e.key==='ArrowUp'){e.preventDefault();acActive=Math.max(acActive-1,0);acRender();}
    else if(e.key==='Enter'){if(acActive>=0){e.preventDefault();acPick(acItems[acActive]);}}
    else if(e.key==='Escape'){acHide();}
  });
  acInput.addEventListener('blur',function(){setTimeout(acHide,160);});
})();

// ---- Policy popups: open Refund/Shipping/Privacy/Terms/Cancellations/Contact
// in a modal over the checkout instead of navigating to a separate page ----
var POLICIES = ${policiesJson};
(function(){
  var ov=document.getElementById('polOverlay');
  if(!ov) return;
  var pt=document.getElementById('polTitle'), pb=document.getElementById('polBody'), px=document.getElementById('polX');
  function openPol(slug){var p=POLICIES[slug];if(!p)return;pt.textContent=p.title;pb.innerHTML=p.body;ov.classList.add('show');document.body.style.overflow='hidden';ov.scrollTop=0;}
  function closePol(){ov.classList.remove('show');document.body.style.overflow='';}
  document.querySelectorAll('[data-pol]').forEach(function(a){a.addEventListener('click',function(e){e.preventDefault();openPol(a.getAttribute('data-pol'));});});
  px.addEventListener('click',closePol);
  ov.addEventListener('click',function(e){if(e.target===ov)closePol();});
  document.addEventListener('keydown',function(e){if(e.key==='Escape')closePol();});
  // links inside a policy (e.g. Cancellations -> Refund) also open in the modal
  pb.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href*="/legal/"]');if(!a)return;var m=a.getAttribute('href').match(/\\/legal\\/([a-z]+)/);if(m&&POLICIES[m[1]]){e.preventDefault();openPol(m[1]);}});
})();

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
  // The buyer enters their email in the Whop payment step (not our address
  // form), so pull it from the Whop payment before creating the Shopify order.
  // Without this, the on-page path records the order with no email.
  let email = cart.email || null;
  if (!email && receiptId && WHOP_API_KEY) {
    try {
      const pr = await fetch(`https://api.whop.com/api/v1/payments/${receiptId}`, {
        headers: { Authorization: `Bearer ${WHOP_API_KEY}` },
      });
      if (pr.ok) {
        const pd = await pr.json();
        email = (pd && pd.user && pd.user.email) || (pd && pd.email) || null;
      } else {
        console.error("[order-complete] whop payment lookup", pr.status);
      }
    } catch (e) { console.error("[order-complete] email lookup failed:", e.message); }
  }
  processedPayments.add(planId); // claim; released below if the order fails
  try {
    await createShopifyOrder({
      payment: { id: receiptId || planId, amount: cart.amount },
      lineItems, email, ship, shipping: cart.shipping || null,
    });
    fireMetaPurchase({ value: cart.amount, email, address: ship }).catch((e) => console.error("[meta]", e));
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
      line_items: lineItems.map((li) => {
        const qty = Number(li.quantity) || 1;
        const li_obj = { variant_id: Number(li.variant_id), quantity: qty };
        // Override the line price with the DISCOUNTED unit price so the Shopify
        // order total matches what Whop actually charged. Without this, Shopify
        // bills the full variant price (e.g. 3x$34.99) and marks the order
        // "partially paid" even though the bundle (Buy 2 Get 1) was $69.99.
        let unit = null;
        if (li.linePrice != null && qty) unit = Number(li.linePrice) / qty;
        else if (li.price != null) unit = Number(li.price);
        if (unit != null && unit >= 0 && isFinite(unit)) li_obj.price = unit.toFixed(2);
        return li_obj;
      }),
      email: email || undefined,
      send_receipt: true,                  // email the buyer Shopify's order confirmation
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
