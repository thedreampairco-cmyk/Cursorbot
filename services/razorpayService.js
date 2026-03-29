const Razorpay = require("razorpay");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/**
 * Creates a Razorpay Payment Link for a given order.
 *
 * @param {object} params
 * @param {string} params.orderId       - Your internal order ID (used as reference_id)
 * @param {string} params.customerName  - Customer's full name
 * @param {string} params.customerPhone - Customer's phone number (e.g. "919876543210")
 * @param {number} params.amount        - Amount in RUPEES (e.g. 499). Converted to paise internally.
 * @returns {Promise<object>}           - The full Razorpay Payment Link response object
 */
async function createPaymentLink({ orderId, customerName, customerPhone, amount }) {
  const expiresAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60; // 24 hours from now

  const payload = {
    amount: amount * 100, // Razorpay requires paise
    currency: "INR",
    accept_partial: false,
    reference_id: orderId,
    expire_by: expiresAt,
    description: `Payment for Order #${orderId}`,
    customer: {
      name: customerName,
      contact: `+${customerPhone}`, // Must include country code, e.g. +919876543210
    },
    notify: {
      sms: false,   // We handle notifications via WhatsApp ourselves
      email: false,
    },
    reminder_enable: false,
    options: {
      checkout: {
        // Enable UPI and Card as the primary payment methods
        method: {
          upi: true,
          card: true,
          netbanking: true,
          wallet: true,
        },
      },
    },
    notes: {
      order_id: orderId,
      customer_name: customerName,
    },
  };

  // razorpay.paymentLink.create() returns a promise
  const paymentLink = await razorpay.paymentLink.create(payload);
  return paymentLink;
}

module.exports = { createPaymentLink };
