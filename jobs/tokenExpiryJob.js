/**
 * tokenExpiryJob.js
 * Runs every minute to manage the 15-minute token window:
 *
 *   T-5 min  → Send "Hurry!" reminder via WhatsApp
 *   T+0      → Mark order EXPIRED, release size back to catalog
 *
 * Register in server.js:
 *   require("./jobs/tokenExpiryJob");
 */

const cron           = require("node-cron");
const { Order, PAYMENT_STATUS } = require("../models/Order");
const whatsappService = require("../services/whatsappService");

const REMINDER_WINDOW_MS = 5 * 60 * 1000; // send reminder when 5 min remain

/**
 * Find orders in AWAITING_TOKEN whose expiry is approaching or has passed,
 * then take the appropriate action.
 */
async function runExpiryCheck() {
  const now = new Date();

  // ── 1. Find all AWAITING_TOKEN orders ─────────────────────────────────────
  const pendingOrders = await Order.find({
    payment_status:   PAYMENT_STATUS.AWAITING_TOKEN,
    token_expires_at: { $ne: null },
  });

  for (const order of pendingOrders) {
    const msRemaining = order.token_expires_at - now;

    if (msRemaining <= 0) {
      // ── EXPIRED ────────────────────────────────────────────────────────────
      try {
        await order.transitionStatus(PAYMENT_STATUS.EXPIRED, "Token window lapsed");
        console.log(`[ExpiryJob] ⏰ Expired: ${order.order_id}`);

        await whatsappService.sendExpiredMessage(order.whatsapp_number, {
          productName: order.product.name,
        });
      } catch (err) {
        console.error(`[ExpiryJob] Failed to expire ${order.order_id}:`, err.message);
      }
    } else if (msRemaining <= REMINDER_WINDOW_MS && !order._reminderSent) {
      // ── T-5 REMINDER ───────────────────────────────────────────────────────
      // We use a lightweight flag field to avoid spamming the reminder.
      // In production, add a `reminder_sent: Boolean` field to the schema.
      try {
        const minutesLeft = Math.ceil(msRemaining / 60_000);
        await whatsappService.sendExpiryReminder(order.whatsapp_number, {
          productName:  order.product.name,
          paymentUrl:   order.razorpay.payment_link_url,
          minutesLeft,
        });

        // Mark that reminder was sent to avoid sending it again next tick
        await Order.updateOne(
          { _id: order._id },
          { $set: { "meta.reminder_sent": true } }
        );

        console.log(`[ExpiryJob] ⚠️  Reminder sent for ${order.order_id} (${minutesLeft} min left)`);
      } catch (err) {
        console.error(`[ExpiryJob] Failed to send reminder for ${order.order_id}:`, err.message);
      }
    }
  }
}

// ── Schedule: every minute ────────────────────────────────────────────────────
cron.schedule("* * * * *", () => {
  runExpiryCheck().catch((err) =>
    console.error("[ExpiryJob] Unexpected error:", err)
  );
});

console.log("[ExpiryJob] Token expiry watcher started (runs every 60 s)");

module.exports = { runExpiryCheck };
