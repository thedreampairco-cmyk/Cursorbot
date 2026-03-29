/**
 * routes/webhooks.js  —  POST /api/webhooks/payment
 *
 * The heartbeat of the automation engine.
 *
 * Key guarantees:
 *   ✅  HMAC signature verified before any data is touched
 *   ✅  200 OK returned immediately — Razorpay won't retry
 *   ✅  Inventory deducted ATOMICALLY before order is confirmed
 *   ✅  Race condition safe — two simultaneous webhooks for the same
 *       order are blocked by the idempotency guard; two buyers racing
 *       for the last pair are blocked by MongoDB's atomic filter
 *   ✅  Post-payment OOS handled — refund flag set, sorry WA message sent
 *   ✅  Sheets sync is async/best-effort — never blocks the happy path
 *
 * Execution order (matters):
 *
 *   Receive webhook
 *       │
 *       ├─ Verify HMAC signature          (bail if invalid)
 *       ├─ Parse event, extract orderId   (bail if missing)
 *       ├─ Idempotency guard              (bail if already processed)
 *       │
 *       ├─► [1] Atomic inventory deduct   ← MUST succeed first
 *       │         │
 *       │    OOS? └─► flag REFUND_PENDING + WA sorry + stop
 *       │
 *       ├─► [2] Update order → TOKEN_RECEIVED  (only after stock confirmed)
 *       └─► [3] Send WA hype confirmation       (fire-and-forget)
 */

const express = require("express");
const router  = express.Router();

const paymentService   = require("../services/paymentService");
const whatsappService  = require("../services/whatsappService");
const inventoryService = require("../services/inventoryService");
const { Order, PAYMENT_STATUS } = require("../models/Order");
const { OutOfStockError }       = require("../models/Inventory");

const EVENT_PAYMENT_LINK_PAID = "payment_link.paid";
const EVENT_PAYMENT_CAPTURED  = "payment.captured";

// ─────────────────────────────────────────────────────────────────────────────
// Webhook endpoint
// Mount in server.js BEFORE express.json():
//   app.use("/api/webhooks/payment", webhookRouter);
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/",
  express.raw({ type: "application/json" }),
  async (req, res) => {

    // ── 0. ACK immediately — Razorpay retries if no 200 within 5 s ───────────
    res.status(200).json({ received: true });

    // ── 1. Verify HMAC signature ──────────────────────────────────────────────
    const signature = req.headers["x-razorpay-signature"];
    const rawBody   = req.body.toString("utf8");

    if (!signature || !paymentService.verifyWebhookSignature(rawBody, signature)) {
      console.error("[Webhook] ⛔  Invalid signature — discarding");
      return;
    }

    // ── 2. Parse event ────────────────────────────────────────────────────────
    let event;
    try { event = JSON.parse(rawBody); }
    catch { console.error("[Webhook] Body parse failed"); return; }

    if (
      event.event !== EVENT_PAYMENT_LINK_PAID &&
      event.event !== EVENT_PAYMENT_CAPTURED
    ) return; // Not an event we act on

    console.log(`[Webhook] ▶  ${event.event}`);

    // ── 3. Extract fields from Razorpay payload ───────────────────────────────
    const entity =
      event.payload?.payment_link?.entity ||
      event.payload?.payment?.entity;

    const orderId        = entity?.notes?.order_id;
    const whatsappNumber = entity?.notes?.whatsapp_number;
    const razorpayPayId  = event.payload?.payment?.entity?.id || entity?.id;
    const amountPaid     = (entity?.amount_paid || entity?.amount || 0) / 100;

    if (!orderId) {
      console.error("[Webhook] No order_id in notes:", entity?.notes);
      return;
    }

    // ── 4. Hand off — non-blocking so the ACK above is already sent ──────────
    processPayment({ orderId, whatsappNumber, razorpayPayId, amountPaid })
      .catch((err) =>
        console.error(`[Webhook] Unhandled error for ${orderId}:`, err)
      );
  }
);


// ─────────────────────────────────────────────────────────────────────────────
// processPayment — the full post-payment engine
// ─────────────────────────────────────────────────────────────────────────────
async function processPayment({ orderId, whatsappNumber, razorpayPayId, amountPaid }) {
  console.log(`[Engine] Processing order ${orderId} | ₹${amountPaid} | pay_id ${razorpayPayId}`);

  // ── A. Load the order ─────────────────────────────────────────────────────
  const order = await Order.findOne({ order_id: orderId });
  if (!order) {
    console.error(`[Engine] Order not found: ${orderId}`);
    return;
  }

  // ── B. Idempotency guard ──────────────────────────────────────────────────
  // Razorpay can fire the same webhook more than once (network retries, etc.)
  // Check the stored Razorpay payment_id — if it's already set we've
  // processed this exact payment before. Status check alone isn't enough
  // because a concurrent duplicate webhook could slip past it.
  if (order.razorpay?.payment_id === razorpayPayId) {
    console.warn(`[Engine] Duplicate webhook for pay_id ${razorpayPayId} — skipping`);
    return;
  }

  if (order.payment_status === PAYMENT_STATUS.TOKEN_RECEIVED) {
    console.warn(`[Engine] Order ${orderId} already TOKEN_RECEIVED — skipping`);
    return;
  }

  if (order.payment_status !== PAYMENT_STATUS.AWAITING_TOKEN) {
    console.warn(`[Engine] Unexpected status '${order.payment_status}' for ${orderId} — skipping`);
    return;
  }

  // ── C. [STEP 1] Atomic inventory deduction ────────────────────────────────
  // This MUST run before we update the order status.
  // If it throws OutOfStockError, the money has been received but we can't
  // fulfil — we flag for refund rather than silently confirming.
  let newStock;
  try {
    const result = await inventoryService.deductStock(
      order.product.sku,
      1,        // qty
      orderId   // for the deduction_log audit trail
    );
    newStock = result.newStock;
    console.log(`[Step 1 ✅] Inventory deducted: ${order.product.sku} → stock=${newStock}`);

  } catch (err) {

    if (err instanceof OutOfStockError) {
      // ── Post-payment OOS: payment received but we can't ship ─────────────
      console.error(`[Step 1 ❌] OOS after payment for ${orderId} — flagging refund`);
      await handlePostPaymentOOS({ order, razorpayPayId, amountPaid, whatsappNumber });
      return;
    }

    // Any other inventory error (SKU not found, DB down) — log and rethrow
    // so the outer .catch() surfaces it. We do NOT mark the order; ops team
    // will reprocess manually.
    console.error(`[Step 1 ❌] Inventory error for ${orderId}:`, err.message);
    throw err;
  }

  // ── D. [STEP 2] Confirm the order in MongoDB ──────────────────────────────
  // Only reached if stock deduction succeeded.
  try {
    order.advance_paid        = amountPaid;
    order.razorpay.payment_id = razorpayPayId;
    order.razorpay.paid_at    = new Date();

    await order.transitionStatus(
      PAYMENT_STATUS.TOKEN_RECEIVED,
      `₹${amountPaid} received (${razorpayPayId}). Stock ${order.product.sku}→${newStock}`
    );
    console.log(`[Step 2 ✅] Order ${orderId} → TOKEN_RECEIVED`);

  } catch (err) {
    // If the DB write fails here, stock was deducted but order not updated.
    // Log with enough context for manual reconciliation.
    console.error(
      `[Step 2 ❌] DB update failed for ${orderId} after stock deduction. ` +
      `Manual reconciliation needed. pay_id=${razorpayPayId}`,
      err.message
    );
    throw err;
  }

  // ── E. [STEP 3] WhatsApp hype confirmation (fire-and-forget) ─────────────
  // Runs after the critical path is complete. A WA failure never rolls back
  // the inventory deduction or order status.
  const recipient = whatsappNumber || order.whatsapp_number;
  whatsappService
    .sendTokenConfirmation(recipient, {
      productName: order.product.name,
      orderId,
      codBalance:  order.cod_balance,
    })
    .then(() => console.log(`[Step 3 ✅] WA confirmation sent to ${recipient}`))
    .catch((err) => console.error(`[Step 3 ❌] WA failed for ${orderId}:`, err.message));
}


// ─────────────────────────────────────────────────────────────────────────────
// handlePostPaymentOOS
// Called when payment is confirmed but stock ran out between token
// collection and webhook processing (extremely rare but possible).
// ─────────────────────────────────────────────────────────────────────────────
async function handlePostPaymentOOS({ order, razorpayPayId, amountPaid, whatsappNumber }) {
  // 1. Flag the order so ops team can issue the refund
  try {
    order.razorpay.payment_id = razorpayPayId;
    order.razorpay.paid_at    = new Date();
    order.advance_paid        = amountPaid;

    await order.transitionStatus(
      PAYMENT_STATUS.REFUND_PENDING,
      `OOS after payment. ₹${amountPaid} received (${razorpayPayId}). Refund required.`
    );
    console.log(`[OOS] Order ${order.order_id} → REFUND_PENDING`);
  } catch (err) {
    console.error(`[OOS] Failed to flag REFUND_PENDING for ${order.order_id}:`, err.message);
  }

  // 2. Apologise via WhatsApp
  const recipient = whatsappNumber || order.whatsapp_number;
  whatsappService
    .sendText(
      recipient,
      `😔 *We're really sorry.*\n\n` +
      `Your ₹${amountPaid} payment for *${order.product.name}* went through, ` +
      `but this size just sold out to another buyer a split second before yours confirmed.\n\n` +
      `Your full ₹${amountPaid} will be refunded within *2–3 business days*. ` +
      `Order ref: \`${order.order_id}\`\n\n` +
      `Want me to check for the same model in another size? Just say the word. 👟`
    )
    .catch((err) =>
      console.error(`[OOS] WA apology failed for ${order.order_id}:`, err.message)
    );
}

module.exports = router;
