/**
 * paymentService.js
 * Handles all Razorpay interactions:
 *   - Creating a ₹500 token payment link
 *   - Verifying webhook signatures
 *   - Fetching payment details
 */

const Razorpay = require("razorpay");
const crypto   = require("crypto");

const TOKEN_AMOUNT_INR = parseInt(process.env.TOKEN_AMOUNT_INR || "500", 10);
const TOKEN_WINDOW_MIN = parseInt(process.env.TOKEN_WINDOW_MIN || "15",  10);

// Lazy-initialized: client is only created on first API call, not at module load.
// This lets the module import safely in tests without real credentials present.
let _razorpay = null;
function getRazorpay() {
  if (!_razorpay) {
    _razorpay = new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return _razorpay;
}

/**
 * Creates a Razorpay Payment Link for ₹500 token collection.
 *
 * @param {object} params
 * @param {string} params.orderId        - Internal Dream Pair order ID
 * @param {string} params.whatsappNumber - Customer's number in E.164 (e.g. "919876543210")
 * @param {string} params.productName    - Display name of the sneaker
 * @param {string} params.customerName   - Customer's name (optional)
 * @returns {Promise<{ payment_link_id, payment_link_url, expires_at }>}
 */
async function createTokenPaymentLink({
  orderId,
  whatsappNumber,
  productName,
  customerName = "Sneakerhead",
}) {
  const expiryTimestamp =
    Math.floor(Date.now() / 1000) + TOKEN_WINDOW_MIN * 60; // Unix seconds

  const payload = {
    amount:         TOKEN_AMOUNT_INR * 100, // Razorpay expects paise
    currency:       "INR",
    accept_partial: false,
    description:    `Size lock token for ${productName}`,
    reference_id:   orderId, // ties Razorpay link back to our DB order

    customer: {
      name:    customerName,
      contact: `+${whatsappNumber}`,
    },

    notify: {
      sms:   false, // We handle notifications via WhatsApp
      email: false,
    },

    reminder_enable: false, // We send our own 15-min reminder

    notes: {
      order_id:        orderId,
      whatsapp_number: whatsappNumber,
      product:         productName,
      source:          "maya_whatsapp_bot",
    },

    // Callback shown in Razorpay-hosted page after payment
    callback_url:    `${process.env.BASE_URL}/payment/success`,
    callback_method: "get",

    expire_by: expiryTimestamp,
  };

  const link = await getRazorpay().paymentLink.create(payload);

  return {
    payment_link_id:  link.id,
    payment_link_url: link.short_url,
    expires_at:       new Date(expiryTimestamp * 1000),
  };
}

/**
 * Verifies the HMAC-SHA256 signature Razorpay sends on every webhook call.
 * MUST be called before trusting any webhook payload.
 *
 * @param {string} rawBody            - Raw request body as string (before JSON.parse)
 * @param {string} razorpaySignature  - Value of X-Razorpay-Signature header
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, razorpaySignature) {
  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  // Decode both as hex so each buffer is always 32 bytes (SHA-256).
  // If razorpaySignature is not valid 64-char hex (e.g. "bad" in tests,
  // or a tampered header in production), Buffer.from returns a different
  // length and we return false safely. try/catch is the final net.
  try {
    const expectedBuf = Buffer.from(expected,          "hex"); // always 32 bytes
    const receivedBuf = Buffer.from(razorpaySignature, "hex"); // 32 bytes only if valid hex
    if (expectedBuf.length !== receivedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
  } catch {
    return false;
  }
}

/**
 * Fetches a single payment record from Razorpay by payment_id.
 * Useful for double-checking amounts after webhook fires.
 *
 * @param {string} paymentId
 * @returns {Promise<object>}
 */
async function fetchPaymentDetails(paymentId) {
  return getRazorpay().payments.fetch(paymentId);
}

module.exports = {
  createTokenPaymentLink,
  verifyWebhookSignature,
  fetchPaymentDetails,
  TOKEN_AMOUNT_INR,
  TOKEN_WINDOW_MIN,
};
