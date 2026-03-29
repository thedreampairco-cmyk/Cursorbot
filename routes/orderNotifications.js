/**
 * routes/orderNotifications.js  —  POST /api/webhooks/order
 *
 * Fires when a new order token is confirmed.
 * Triggers email to the customer AND Slack/SMS to the admin
 * simultaneously via Promise.allSettled.
 *
 * Security: shared-secret header check (X-Dream-Pair-Secret).
 * This endpoint is called by your own internal system (e.g. after
 * processPayment() confirms TOKEN_RECEIVED), NOT by Razorpay.
 * It therefore uses JSON body (not raw buffer) — no HMAC needed.
 *
 * Execution model:
 *
 *   POST /api/webhooks/order
 *         │
 *         ├── Validate secret header          (bail if wrong)
 *         ├── Validate required payload fields (bail if missing)
 *         ├── Return 200 OK immediately        ← webhook ACK
 *         │
 *         └── [non-blocking async]
 *               ├── sendOrderConfirmation()  ─── SendGrid email
 *               └── alertNewOrder()         ─── Slack + Twilio SMS
 *                         ↑
 *               Promise.allSettled: one failing never blocks the other
 *
 * Required env vars:
 *   ORDER_WEBHOOK_SECRET   — shared secret, set in your internal caller too
 *   SENDGRID_API_KEY
 *   SLACK_WEBHOOK_URL
 *
 * Optional:
 *   TWILIO_* / ADMIN_PHONE_NUMBER (if SMS alerts desired)
 *   LOW_STOCK_THRESHOLD           (default: 3)
 */

const express          = require("express");
const router           = express.Router();
const emailService     = require("../services/emailService");
const adminAlertService= require("../services/adminAlertService");
const { Order }        = require("../models/Order");

const LOW_STOCK_THRESHOLD = parseInt(process.env.LOW_STOCK_THRESHOLD || "3", 10);

// ─── Shared Secret Middleware ─────────────────────────────────────────────────
function validateSecret(req, res, next) {
  const secret   = process.env.ORDER_WEBHOOK_SECRET;
  const provided = req.headers["x-dream-pair-secret"];

  if (!secret) {
    // Misconfiguration — fail closed rather than open
    console.error("[OrderWebhook] ORDER_WEBHOOK_SECRET env var not set");
    return res.status(500).json({ error: "Server misconfiguration" });
  }

  // Constant-time comparison to prevent timing attacks
  const crypto = require("crypto");
  const expected = crypto.createHash("sha256").update(secret).digest("hex");
  const received = crypto.createHash("sha256").update(provided || "").digest("hex");

  if (expected !== received) {
    console.warn("[OrderWebhook] ⛔  Invalid secret — rejecting request");
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

// ─── Payload Validator ────────────────────────────────────────────────────────
function extractAndValidate(body) {
  const errors = [];

  // Support two payload shapes:
  //   (a) the raw MongoDB Order document / object
  //   (b) a slim summary object for lightweight callers
  const order_id        = body.order_id;
  const customerEmail   = body.customer_email   || body.email;
  const customerName    = body.customer_name    || body.name  || "Sneakerhead";
  const product         = body.product          || {};
  const total_amount    = body.total_amount;
  const advance_paid    = body.advance_paid      ?? 0;
  const cod_balance     = body.cod_balance       ?? (total_amount - advance_paid);
  const whatsapp_number = body.whatsapp_number;
  const newStock        = body.new_stock         ?? null; // present when low-stock alert needed

  if (!order_id)                     errors.push("order_id");
  if (!customerEmail)                errors.push("customer_email");
  if (!product.name || !product.sku) errors.push("product.name / product.sku");
  if (total_amount == null)          errors.push("total_amount");
  if (!whatsapp_number)              errors.push("whatsapp_number");

  if (errors.length) {
    throw new Error(`Missing required fields: ${errors.join(", ")}`);
  }

  return {
    order_id,
    customerEmail,
    customerName,
    whatsapp_number,
    product: {
      name:      product.name,
      size:      product.size || "?",
      sku:       product.sku,
      color:     product.color || "",
      image_url: product.image_url || "",
    },
    total_amount,
    advance_paid,
    cod_balance,
    newStock,
  };
}


// ─── POST /api/webhooks/order ─────────────────────────────────────────────────
router.post("/", validateSecret, async (req, res) => {

  // ── 1. Validate payload ───────────────────────────────────────────────────
  let data;
  try {
    data = extractAndValidate(req.body);
  } catch (err) {
    console.error("[OrderWebhook] Bad payload:", err.message);
    return res.status(400).json({ error: err.message });
  }

  // ── 2. ACK immediately — internal callers shouldn't have to wait ──────────
  res.status(200).json({
    received: true,
    order_id: data.order_id,
  });

  // ── 3. Fire both tasks simultaneously (non-blocking) ─────────────────────
  notifyAll(data).catch((err) =>
    console.error(`[OrderWebhook] Unhandled error for ${data.order_id}:`, err)
  );
});


// ─── notifyAll — the concurrent notification engine ───────────────────────────
async function notifyAll(data) {
  const {
    order_id, customerEmail, customerName,
    product, total_amount, advance_paid, cod_balance,
    whatsapp_number, newStock,
  } = data;

  // Shape that both services consume
  const orderPayload = {
    order_id,
    product,
    total_amount,
    advance_paid,
    cod_balance,
    whatsapp_number,
  };

  console.log(`[OrderWebhook] Dispatching notifications for ${order_id}...`);

  // ── Task A: Customer email ───────────────────────────────────────────────
  const emailTask = emailService
    .sendOrderConfirmation(customerEmail, customerName, orderPayload)
    .then(() => ({ task: "email",       status: "ok" }))
    .catch((err) => ({ task: "email",   status: "failed", error: err.message }));

  // ── Task B: Admin Slack + SMS alert ─────────────────────────────────────
  const alertTask = adminAlertService
    .alertNewOrder(orderPayload)
    .then(() => ({ task: "admin_alert", status: "ok" }))
    .catch((err) => ({ task: "admin_alert", status: "failed", error: err.message }));

  // ── Task C: Low-stock alert (fires only when threshold crossed) ──────────
  const lowStockTask = (newStock !== null && newStock <= LOW_STOCK_THRESHOLD)
    ? adminAlertService
        .alertLowStock(product.sku, product.name, newStock)
        .then(() => ({ task: "low_stock_alert", status: "ok"  }))
        .catch((err) => ({ task: "low_stock_alert", status: "failed", error: err.message }))
    : Promise.resolve({ task: "low_stock_alert", status: "skipped" });

  // ── Collect results — Promise.allSettled never short-circuits ────────────
  const results = await Promise.allSettled([emailTask, alertTask, lowStockTask]);

  results.forEach(({ status, value, reason }) => {
    if (status === "fulfilled") {
      const r = value;
      if (r.status === "ok")      console.log(`[OrderWebhook] ✅  ${r.task}`);
      if (r.status === "skipped") console.log(`[OrderWebhook] ⏭️  ${r.task} (not needed)`);
      if (r.status === "failed")  console.error(`[OrderWebhook] ❌  ${r.task}: ${r.error}`);
    } else {
      console.error(`[OrderWebhook] ❌  Unexpected rejection:`, reason);
    }
  });

  const failed = results.filter(
    ({ status, value }) => status === "rejected" || value?.status === "failed"
  );
  if (failed.length === 0) {
    console.log(`[OrderWebhook] 🎉  All notifications delivered for ${order_id}`);
  } else {
    console.warn(`[OrderWebhook] ⚠️  ${failed.length} notification(s) failed for ${order_id}`);
  }
}

module.exports = router;
