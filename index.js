/**
 * Anti-Fraud Shield — module entry point
 *
 * Shields:
 *   1. Partial COD Protocol   — ₹500 deposit intercept
 *   2. Verification Ping      — WhatsApp Live Location vs order pincode
 *   3. Psychological Defense  — Unboxing contract on OFD
 *
 * Usage:
 *   const fraud = require('./src/fraud');
 *
 *   // 1. On checkout with COD selected:
 *   await fraud.onCODSelected({ orderId, phone, orderTotal, itemName, size });
 *
 *   // 2. On Razorpay webhook (POST /webhooks/razorpay/deposit-paid):
 *   await fraud.onDepositWebhook(req.body, req.headers['x-razorpay-signature']);
 *
 *   // 3. On incoming WhatsApp message (from webhook router):
 *   await fraud.onIncomingWhatsAppMessage(message);
 *
 *   // 4. On Shiprocket webhook (POST /webhooks/shiprocket):
 *   await fraud.onShiprocketWebhook(req.body);
 */

const { interceptCOD, handleDepositPaid, waiveDeposit, retryDepositPrompt } = require('./codInterceptor');
const { handleIncomingLocation, setOrderPincode, handleLocationRefusal } = require('./locationVerifier');
const { handleOutForDelivery, receiveUnboxingVideo, parseShiprocketWebhook } = require('./unboxingContract');
const { verifyWebhookSignature, parseDepositWebhook } = require('./depositHandler');
const FraudState = require('./fraudStateModel');
const logger = require('../utils/logger');

// ─── Checkout hook ────────────────────────────────────────────────────────────

async function onCODSelected({ orderId, phone, orderTotal, itemName, size, deliveryPincode }) {
  const state = await interceptCOD({ orderId, phone, orderTotal, itemName, size });

  if (deliveryPincode) {
    await setOrderPincode({ orderId, pincode: deliveryPincode });
  }

  return state;
}

// ─── Razorpay webhook handler ─────────────────────────────────────────────────

async function onDepositWebhook(body, signature) {
  if (!verifyWebhookSignature(body, signature)) {
    logger.warn('Razorpay webhook signature invalid');
    throw new Error('Invalid webhook signature');
  }

  const event = body.event;

  if (event !== 'payment_link.paid') {
    logger.info('Razorpay webhook: unhandled event, skipping', { event });
    return null;
  }

  const { orderId, razorpayPaymentId, amountPaid } = parseDepositWebhook(body);
  return handleDepositPaid({ orderId, razorpayPaymentId, amountPaid });
}

// ─── WhatsApp incoming message router ────────────────────────────────────────

async function onIncomingWhatsAppMessage(message) {
  const phone = message.from;

  // Live location
  if (message.type === 'location' && message.location) {
    return handleIncomingLocation({
      phone,
      location: {
        latitude: message.location.latitude,
        longitude: message.location.longitude,
      },
    });
  }

  // Unboxing video
  if (message.type === 'video' && message.video) {
    return receiveUnboxingVideo({
      phone,
      mediaId: message.video.id,
    });
  }

  // "NO" or refusal to share location
  if (message.type === 'text') {
    const text = (message.text?.body || '').toLowerCase().trim();
    const refusalPhrases = ['no', 'nope', 'not sharing', 'no location', 'skip', 'why', 'refuse'];
    if (refusalPhrases.some((p) => text.includes(p))) {
      const state = await FraudState.findOne({
        phone,
        overallStatus: 'awaiting_location',
      });
      if (state) {
        return handleLocationRefusal({ phone, orderId: state.orderId });
      }
    }
  }

  return null; // not fraud-related, let main handler process it
}

// ─── Shiprocket webhook handler ───────────────────────────────────────────────

async function onShiprocketWebhook(body) {
  const { orderId, phone, status, courierName, awb } = parseShiprocketWebhook(body);

  logger.info('Shiprocket webhook received', { orderId, status, courierName });

  const OFD_STATUSES = ['out for delivery', 'out_for_delivery', 'ofd'];

  if (OFD_STATUSES.includes(status)) {
    return handleOutForDelivery({ orderId, phone, courierName, awb });
  }

  return null;
}

// ─── Admin utilities ──────────────────────────────────────────────────────────

async function adminWaiveDeposit({ orderId, adminPhone }) {
  return waiveDeposit({ orderId, adminPhone });
}

async function adminGetFraudState(orderId) {
  return FraudState.findOne({ orderId });
}

// ─── Scheduled: retry unpaid deposits after 30 min ───────────────────────────
// Wire this up in your cron job (node-cron is already in package.json):
//
//   const cron = require('node-cron');
//   const fraud = require('./src/fraud');
//   cron.schedule('*/15 * * * *', fraud.retryPendingDeposits);

async function retryPendingDeposits() {
  const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);
  const stale = await FraudState.find({
    overallStatus: 'awaiting_deposit',
    'deposit.status': 'pending',
    createdAt: { $lt: thirtyMinsAgo },
  });

  logger.info(`Retrying ${stale.length} stale COD deposits`);

  await Promise.allSettled(
    stale.map((s) => retryDepositPrompt({ orderId: s.orderId }))
  );
}

module.exports = {
  onCODSelected,
  onDepositWebhook,
  onIncomingWhatsAppMessage,
  onShiprocketWebhook,
  adminWaiveDeposit,
  adminGetFraudState,
  retryPendingDeposits,
};
