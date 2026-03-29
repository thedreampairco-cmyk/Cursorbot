const Order = require("../models/Order");
const { sendPaymentConfirmationMessage } = require("../services/whatsappService");

// The Razorpay events we care about for a "payment success" lifecycle
const PAYMENT_SUCCESS_EVENTS = new Set([
  "payment_link.paid",  // Fires when a Payment Link is fully paid
  "order.paid",         // Fires when a Razorpay Order is fully paid
  "payment.captured",   // Fires when a payment capture succeeds (fallback)
]);

/**
 * POST /api/webhooks/razorpay
 *
 * Handles inbound Razorpay webhook events.
 * Signature verification is already done by the verifyRazorpayWebhook middleware.
 *
 * Razorpay webhook payload shape (payment_link.paid):
 * {
 *   "entity": "event",
 *   "event": "payment_link.paid",
 *   "payload": {
 *     "payment_link": {
 *       "entity": { "id": "plink_xxx", "reference_id": "ORD-12345", ... }
 *     },
 *     "payment": {
 *       "entity": { "id": "pay_xxx", ... }
 *     }
 *   }
 * }
 */
async function handleRazorpayWebhook(req, res) {
  // ── 1. Always respond 200 immediately so Razorpay doesn't retry ─────────────
  // We do the heavy lifting after sending the response.
  res.status(200).json({ success: true, received: true });

  const event = req.body?.event;
  const payload = req.body?.payload;

  console.log(`[WebhookController] Received event: ${event}`);

  // ── 2. Ignore events we don't handle ────────────────────────────────────────
  if (!PAYMENT_SUCCESS_EVENTS.has(event)) {
    console.log(`[WebhookController] Ignoring unhandled event: ${event}`);
    return;
  }

  try {
    // ── 3. Extract order reference and payment ID ───────────────────────────
    const { orderId, razorpayPaymentId } = extractIdsFromPayload(event, payload);

    if (!orderId) {
      console.error("[WebhookController] Could not extract orderId from payload:", JSON.stringify(payload));
      return;
    }

    // ── 4. Find the order in our DB ─────────────────────────────────────────
    const order = await Order.findOne({ orderId });

    if (!order) {
      // The order might have originated outside this service — log and exit
      console.warn(`[WebhookController] Order not found in DB: ${orderId}`);
      return;
    }

    // Idempotency guard: don't process the same payment twice
    if (order.status === "paid") {
      console.log(`[WebhookController] Order ${orderId} is already marked paid. Skipping.`);
      return;
    }

    // ── 5. Update order status to "Paid" ────────────────────────────────────
    await Order.findOneAndUpdate(
      { orderId },
      {
        status: "paid",
        razorpayPaymentId,
        paidAt: new Date(),
      }
    );

    console.log(`[WebhookController] ✅ Order ${orderId} marked as PAID (payment: ${razorpayPaymentId})`);

    // ── 6. Send WhatsApp confirmation ────────────────────────────────────────
    await sendPaymentConfirmationMessage({
      customerPhone: order.customerPhone,
      orderId,
    });

    console.log(`[WebhookController] WhatsApp confirmation sent to ${order.customerPhone}`);
  } catch (error) {
    // Log the error but don't crash — we already sent 200 to Razorpay
    console.error("[WebhookController] Error processing webhook:", error?.message || error);
  }
}

/**
 * Extracts orderId and razorpayPaymentId from different event payload shapes.
 * Razorpay's payload structure varies slightly by event type.
 */
function extractIdsFromPayload(event, payload) {
  let orderId = null;
  let razorpayPaymentId = null;

  if (event === "payment_link.paid") {
    orderId = payload?.payment_link?.entity?.reference_id;
    razorpayPaymentId = payload?.payment?.entity?.id;
  } else if (event === "order.paid") {
    orderId = payload?.order?.entity?.receipt; // set receipt = orderId when creating Razorpay order
    razorpayPaymentId = payload?.payment?.entity?.id;
  } else if (event === "payment.captured") {
    // For direct payments, order_id is nested inside the payment entity notes
    orderId = payload?.payment?.entity?.notes?.order_id;
    razorpayPaymentId = payload?.payment?.entity?.id;
  }

  return { orderId, razorpayPaymentId };
}

module.exports = { handleRazorpayWebhook };
