const Razorpay = require('razorpay');
const logger = require('../../utils/logger');

const RZP_READY = !!process.env.RAZORPAY_KEY_ID && !!process.env.RAZORPAY_KEY_SECRET;

const razorpay = RZP_READY
  ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })
  : null;

/**
 * Creates a ₹500 (or custom amount) Razorpay payment link for COD deposit.
 * Returns the short_url and link ID for storage.
 */
async function createDepositLink({ orderId, phone, orderTotal, itemName, depositAmount = 500 }) {
  if (!RZP_READY) {
    logger.info('[RZP STUB] Deposit link not created — credentials not configured', { orderId });
    return {
      linkId: `stub_link_${orderId}`,
      shortUrl: `https://rzp.io/stub/${orderId}`,
      amount: depositAmount,
      balance: orderTotal - depositAmount,
      expiresAt: new Date(Date.now() + 3600 * 1000),
    };
  }
  try {
    const balance = orderTotal - depositAmount;

    const payload = {
      amount: depositAmount * 100, // paise
      currency: 'INR',
      description: `Lock your size — ${itemName} (COD deposit)`,
      reference_id: orderId,
      customer: {
        contact: phone.startsWith('+') ? phone : `+91${phone}`,
      },
      notify: {
        sms: false,
        email: false,
        whatsapp: false, // we send our own WA message
      },
      reminder_enable: true,
      notes: {
        orderId,
        itemName,
        orderTotal: String(orderTotal),
        balance: String(balance),
        purpose: 'cod_deposit',
      },
      callback_url: `${process.env.APP_BASE_URL}/webhooks/razorpay/deposit-paid`,
      callback_method: 'get',
      expire_by: Math.floor(Date.now() / 1000) + 3600, // 1 hour expiry
    };

    const link = await razorpay.paymentLink.create(payload);

    logger.info('Deposit link created', { orderId, linkId: link.id, amount: depositAmount });

    return {
      linkId: link.id,
      shortUrl: link.short_url,
      amount: depositAmount,
      balance,
      expiresAt: new Date(payload.expire_by * 1000),
    };
  } catch (err) {
    logger.error('Failed to create Razorpay deposit link', { orderId, error: err.message });
    throw err;
  }
}

/**
 * Verifies Razorpay webhook signature for deposit confirmation.
 */
function verifyWebhookSignature(body, signature) {
  const crypto = require('crypto');
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(JSON.stringify(body))
    .digest('hex');
  return expected === signature;
}

/**
 * Extracts orderId and payment info from a Razorpay payment_link.paid webhook payload.
 */
function parseDepositWebhook(payload) {
  const entity = payload?.payload?.payment_link?.entity;
  const payment = payload?.payload?.payment?.entity;

  if (!entity || !payment) throw new Error('Invalid Razorpay deposit webhook payload');

  return {
    orderId: entity.notes?.orderId,
    linkId: entity.id,
    razorpayPaymentId: payment.id,
    amountPaid: payment.amount / 100,
    method: payment.method,
  };
}

module.exports = { createDepositLink, verifyWebhookSignature, parseDepositWebhook };
