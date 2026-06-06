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
} = process.env;

const whop = new Whop({
  appID: WHOP_APP_ID,
  apiKey: WHOP_API_KEY,
  webhookKey: Buffer.from(WHOP_WEBHOOK_SECRET || "").toString("base64"),
});

// The Shopify Admin token. Either provided via env, or captured by /auth.
let shopifyToken = SHOPIFY_ADMIN_TOKEN;
const processedPayments = new Set(); // de-dupe webhook retries (use a DB in prod)

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

    return res.json({
      sessionId: checkout.id,
      planId: checkout.plan.id,
      checkoutUrl: `https://whop.com/checkout/${checkout.plan.id}`,
    });
  } catch (err) {
    console.error("[/checkout/create]", err);
    return res.status(500).json({ error: "could not create checkout" });
  }
});

// ============================================================================
// 2) WHOP WEBHOOK  ->  create the PAID order in Shopify
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

  // Whop v1 names the "payment went through" event `invoice_paid`. We log every
  // event type so the first real payment confirms the exact name + payload shape.
  console.log("[webhook] received type:", event.type);
  const ORDER_TRIGGERS = new Set(["invoice_paid", "payment.succeeded", "payment_succeeded"]);
  if (!ORDER_TRIGGERS.has(event.type)) return; // membership_activated etc. -> logged only
  const payment = event.data;
  if (payment && processedPayments.has(payment.id)) return;
  if (payment) processedPayments.add(payment.id);

  try {
    console.log("[payment.succeeded] payload:", JSON.stringify(payment)); // VERIFY
    const meta = payment.metadata || {};
    const lineItems = JSON.parse(meta.shopify_line_items || "[]");
    const email = meta.email || payment.user?.email || payment.member?.email; // VERIFY
    const ship = payment.shipping_address || payment.address || {};           // VERIFY
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

app.get("/health", (_req, res) => res.send("ok"));
app.get("/", (_req, res) => res.send("Whop↔Shopify bridge is running."));
app.listen(PORT, () => console.log(`Bridge listening on :${PORT}`));
