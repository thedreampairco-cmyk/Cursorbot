// services/paymentService.js
"use strict";

const Razorpay            = require("razorpay");
const crypto              = require("crypto");
const { v4: uuidv4 }      = require("uuid");
const { logger, AppError } = require("../errorHandler");
const { buildPaymentCallbackUrl } = require("../urlHelper");

if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  throw new Error("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set.");
}

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Convert INR amount to paise (Razorpay requires integer paise).
 * @param {number} inr
 * @returns {number}
 */
function toPaise(inr) {
  return Math.round(inr * 100);
}

/**
 * Normalize a phone number to E.164 for Razorpay.
 * @param {string} phone
 * @returns {string}
 */
function _normalizePhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  return `+${digits}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a Razorpay Order (for standard SDK checkout).
 * @param {number}  amount    - in INR
 * @param {string}  [currency="INR"]
 * @param {string}  [receipt]
 * @param {object}  [notes]
 * @returns {Promise<object>} Razorpay order object
 */
async function createOrder(amount, currency = "INR", receipt = null, notes = {}) {
  try {
    const order = await razorpay.orders.create({
      amount:   toPaise(amount),
      currency,
      receipt:  receipt || `rcpt_${uuidv4().replace(/-/g, "").slice(0, 16)}`,
      notes,
    });
    logger.info(`[Razorpay] Order created: ${order.id} | ₹${amount}`);
    return order;
  } catch (err) {
    logger.error(`[Razorpay] createOrder failed: ${err.message}`);
    throw new AppError(`Razorpay order creation failed: ${err.message}`, 502, "RAZORPAY_ORDER_FAILED");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENT LINKS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a Razorpay Payment Link suitable for sharing via WhatsApp.
 * @param {object}  params
 * @param {number}  params.amount          - in INR
 * @param {string}  params.orderId         - internal order/reference ID
 * @param {string}  params.phone           - customer phone number
 * @param {string}  [params.customerName]
 * @param {string}  [params.description]
 * @param {boolean} [params.isCodDeposit=false]
 * @param {number}  [params.expiryMinutes=15]
 * @returns {Promise<{ paymentLinkId: string, shortUrl: string, amount: number }>}
 */
async function createPaymentLink({
  amount,
  orderId,
  phone,
  customerName  = "Customer",
  description   = null,
  isCodDeposit  = false,
  expiryMinutes = 15,
}) {
  try {
    const expireBy = Math.floor(Date.now() / 1000) + expiryMinutes * 60;

    const payload = {
      amount:          toPaise(amount),
      currency:        "INR",
      accept_partial:  false,
      description:     description || (isCodDeposit ? "COD Security Deposit — The Dream Pair" : "Order Payment — The Dream Pair"),
      customer: {
        name:    customerName,
        contact: _normalizePhone(phone),
      },
      notify: {
        sms:   true,
        email: false,
      },
      reminder_enable: true,
      callback_url:    buildPaymentCallbackUrl(orderId),
      callback_method: "get",
      expire_by:       expireBy,
      notes: {
        orderId,
        type: isCodDeposit ? "cod_deposit" : "order_payment",
      },
    };

    const link = await razorpay.paymentLink.create(payload);
    logger.info(`[Razorpay] Payment link created: ${link.id} | order=${orderId} | ₹${amount}`);

    return {
      paymentLinkId: link.id,
      shortUrl:      link.short_url,
      amount,
    };
  } catch (err) {
    logger.error(`[Razorpay] createPaymentLink failed: ${err.message}`);
    throw new AppError(`Payment link creation failed: ${err.message}`, 502, "RAZORPAY_LINK_FAILED");
  }
}

/**
 * Fetch a Razorpay Payment Link by its ID.
 * @param {string} paymentLinkId
 * @returns {Promise<object>}
 */
async function fetchPaymentLink(paymentLinkId) {
  try {
    const link = await razorpay.paymentLink.fetch(paymentLinkId);
    logger.info(`[Razorpay] Payment link fetched: ${paymentLinkId} | status=${link.status}`);
    return link;
  } catch (err) {
    logger.error(`[Razorpay] fetchPaymentLink failed: ${err.message}`);
    throw new AppError(`Failed to fetch payment link: ${err.message}`, 502, "RAZORPAY_FETCH_LINK_FAILED");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch the full details of a payment by its Razorpay payment ID.
 * @param {string} paymentId
 * @returns {Promise<object>}
 */
async function fetchPaymentDetails(paymentId) {
  try {
    const payment = await razorpay.payments.fetch(paymentId);
    logger.info(`[Razorpay] Payment fetched: ${paymentId} | status=${payment.status}`);
    return payment;
  } catch (err) {
    logger.error(`[Razorpay] fetchPaymentDetails failed: ${err.message}`);
    throw new AppError(`Failed to fetch payment: ${err.message}`, 502, "RAZORPAY_FETCH_PAYMENT_FAILED");
  }
}

/**
 * Manually capture an authorized payment (use only if auto-capture is disabled).
 * @param {string} paymentId
 * @param {number} amount    - in INR
 * @returns {Promise<object>}
 */
async function capturePayment(paymentId, amount) {
  try {
    const captured = await razorpay.payments.capture(paymentId, toPaise(amount), "INR");
    logger.info(`[Razorpay] Payment captured: ${paymentId} | ₹${amount}`);
    return captured;
  } catch (err) {
    logger.error(`[Razorpay] capturePayment failed: ${err.message}`);
    throw new AppError(`Payment capture failed: ${err.message}`, 502, "RAZORPAY_CAPTURE_FAILED");
  }
}

/**
 * Issue a full or partial refund for a payment.
 * @param {string} paymentId
 * @param {number|null} [amount=null]  - in INR; null = full refund
 * @param {object} [notes]
 * @returns {Promise<object>}
 */
async function createRefund(paymentId, amount = null, notes = {}) {
  try {
    const payload = { notes };
    if (amount !== null) payload.amount = toPaise(amount);

    const refund = await razorpay.payments.refund(paymentId, payload);
    logger.info(`[Razorpay] Refund issued: ${refund.id} for payment ${paymentId}`);
    return refund;
  } catch (err) {
    logger.error(`[Razorpay] createRefund failed: ${err.message}`);
    throw new AppError(`Refund creation failed: ${err.message}`, 502, "RAZORPAY_REFUND_FAILED");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNATURE VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Verify the HMAC-SHA256 signature from a Razorpay webhook event.
 * Must be called with the raw (un-parsed) request body.
 *
 * @param {string|Buffer} rawBody  - raw request body bytes
 * @param {string} signature       - value of the `x-razorpay-signature` header
 * @returns {boolean}
 * @throws {AppError} if RAZORPAY_WEBHOOK_SECRET is not configured
 */
function verifyWebhookSignature(rawBody, signature) {
  if (!WEBHOOK_SECRET) {
    throw new AppError("RAZORPAY_WEBHOOK_SECRET is not set.", 500, "MISSING_ENV");
  }
  const expected = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  // Timing-safe comparison prevents timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected,  "hex"),
      Buffer.from(signature, "hex")
    );
  } catch {
    return false; // Buffer lengths differ → invalid signature
  }
}

/**
 * Verify the HMAC-SHA256 signature for a client-side payment completion.
 * @param {string} razorpayOrderId   - order_id returned when creating the Razorpay order
 * @param {string} razorpayPaymentId - razorpay_payment_id from client callback
 * @param {string} signature         - razorpay_signature from client callback
 * @returns {boolean}
 */
function verifyPaymentSignature(razorpayOrderId, razorpayPaymentId, signature) {
  const body     = `${razorpayOrderId}|${razorpayPaymentId}`;
  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected,  "hex"),
      Buffer.from(signature, "hex")
    );
  } catch {
    return false;
  }
}

module.exports = {
  createOrder,
  createPaymentLink,
  fetchPaymentLink,
  fetchPaymentDetails,
  capturePayment,
  createRefund,
  verifyWebhookSignature,
  verifyPaymentSignature,
};
