const FraudState = require('../../models/FraudState');
const { createDepositLink } = require('../../integrations/razorpay/depositHandler');
const { sendWhatsAppMessage } = require('../../integrations/whatsapp/sender');
const { notifyAdmin } = require('../../admin/notifier');
const logger = require('../../utils/logger');

/**
 * Called when a customer selects COD during checkout.
 * Creates a FraudState record, generates a deposit link, and fires the WA message.
 */
async function interceptCOD({ orderId, phone, orderTotal, itemName, size }) {
  logger.info('COD selected — intercepting', { orderId, phone });

  // Idempotency guard
  let state = await FraudState.findOne({ orderId });
  if (state) {
    logger.warn('Duplicate COD intercept — state already exists', { orderId });
    return state;
  }

  // Create deposit link first (if it fails, don't save state)
  const depositLink = await createDepositLink({ orderId, phone, orderTotal, itemName });

  state = await FraudState.create({
    orderId,
    phone,
    paymentMethod: 'cod',
    overallStatus: 'awaiting_deposit',
    deposit: {
      required: true,
      amount: depositLink.amount,
      status: 'pending',
      razorpayLinkId: depositLink.linkId,
    },
    location: { orderPincode: null }, // filled after address capture
  });

  await sendDepositPrompt({ phone, itemName, size, depositLink, orderTotal });

  logger.info('COD intercepted — deposit prompt sent', { orderId, linkId: depositLink.linkId });
  return state;
}

/**
 * Fires the WhatsApp deposit request message.
 * Matches the exact script from the master system prompt.
 */
async function sendDepositPrompt({ phone, itemName, size, depositLink, orderTotal }) {
  const balance = orderTotal - depositLink.amount;

  const message =
    `COD is available! 🤝\n\n` +
    `Since *${itemName} (${size})* is a limited drop, we just need a ₹${depositLink.amount} token advance ` +
    `via UPI to lock your size and generate the shipping label.\n\n` +
    `The remaining *₹${balance}* you pay in cash to the delivery guy.\n\n` +
    `👉 Pay token now (link expires in 1 hr):\n${depositLink.shortUrl}`;

  await sendWhatsAppMessage({ to: phone, text: message });
}

/**
 * Called when Razorpay fires a payment_link.paid webhook.
 * Marks deposit as paid and advances the fraud check to location verification.
 */
async function handleDepositPaid({ orderId, razorpayPaymentId, amountPaid }) {
  const state = await FraudState.findOne({ orderId });
  if (!state) {
    logger.error('Deposit paid webhook — FraudState not found', { orderId });
    return null;
  }

  if (state.deposit.status === 'paid') {
    logger.warn('Duplicate deposit webhook', { orderId });
    return state;
  }

  state.deposit.status = 'paid';
  state.deposit.razorpayPaymentId = razorpayPaymentId;
  state.deposit.paidAt = new Date();
  state.overallStatus = 'awaiting_location';
  await state.save();

  // Immediately ask for live location to complete verification
  await requestLiveLocation({ phone: state.phone, orderId });

  logger.info('Deposit confirmed — location request sent', { orderId, amountPaid });
  return state;
}

/**
 * Sends the live location request message.
 * Instructs the customer to share their WhatsApp Live Location.
 */
async function requestLiveLocation({ phone, orderId }) {
  const message =
    `✅ Token received! Your size is locked.\n\n` +
    `One last step before we generate your shipping label: we need to verify your delivery area.\n\n` +
    `📍 *Share your WhatsApp Live Location* right now (it just needs to be on for a few seconds — ` +
    `we only read the pin code, nothing else).\n\n` +
    `Tap 📎 → Location → Share Live Location.`;

  await sendWhatsAppMessage({ to: phone, text: message });
}

/**
 * Admin override: waive the deposit requirement for a specific order.
 * Use sparingly (e.g. repeat high-value customer).
 */
async function waiveDeposit({ orderId, adminPhone }) {
  const state = await FraudState.findOne({ orderId });
  if (!state) throw new Error(`No FraudState for orderId: ${orderId}`);

  state.deposit.status = 'waived';
  state.overallStatus = 'awaiting_location';
  await state.save();

  await requestLiveLocation({ phone: state.phone, orderId });
  await notifyAdmin({
    message: `⚠️ COD deposit waived for order ${orderId} by admin override.`,
    adminPhone,
  });

  logger.info('Deposit waived by admin', { orderId, adminPhone });
  return state;
}

/**
 * Retry deposit prompt (e.g., after 30 min of no payment).
 * Caps at 2 attempts before escalating to admin.
 */
async function retryDepositPrompt({ orderId }) {
  const state = await FraudState.findOne({ orderId });
  if (!state || state.deposit.status !== 'pending') return;

  state.attemptCount = (state.attemptCount || 0) + 1;

  if (state.attemptCount >= 2) {
    state.overallStatus = 'blocked';
    state.blockedReason = 'Deposit not paid after 2 reminders';
    await state.save();
    await notifyAdmin({
      message: `🚫 COD order ${orderId} auto-blocked — deposit not paid after ${state.attemptCount} attempts.`,
    });
    logger.warn('COD order blocked — no deposit', { orderId, attempts: state.attemptCount });
    return;
  }

  await state.save();

  const depositLink = {
    shortUrl: `${process.env.APP_BASE_URL}/pay/${state.deposit.razorpayLinkId}`,
    amount: state.deposit.amount,
  };

  await sendWhatsAppMessage({
    to: state.phone,
    text:
      `Hey! 👟 Your size is still on hold but the token link expires soon.\n\n` +
      `Tap here to lock it in: ${depositLink.shortUrl}\n\n` +
      `Once paid we'll ship it out fast 🚚`,
  });
}

module.exports = { interceptCOD, handleDepositPaid, waiveDeposit, retryDepositPrompt };
