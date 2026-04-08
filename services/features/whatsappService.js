/**
 * whatsappService.js
 * Thin wrapper around the Green API to send WhatsApp messages & media.
 * All public functions are fire-and-forget: they log errors but never throw,
 * so a messaging failure never crashes a critical payment flow.
 */

const axios = require("axios");
const { sendImageByUrl } = require("../whatsapp/greenApiMedia");

const BASE_URL   = "https://api.green-api.com";
const INSTANCE   = process.env.GREEN_API_INSTANCE_ID;
const API_TOKEN  = process.env.GREEN_API_TOKEN;

/** Builds a Green API endpoint URL */
function endpoint(method) {
  return `${BASE_URL}/waInstance${INSTANCE}/${method}/${API_TOKEN}`;
}

/**
 * Sends a plain-text WhatsApp message.
 *
 * @param {string} to      - E.164 number without '+', e.g. "919876543210"
 * @param {string} message - Text body
 */
async function sendText(to, message) {
  try {
    const chatId = to.includes('@') ? to : `${to}@c.us`;
    await axios.post(endpoint("sendMessage"), {
      chatId,
      message,
    });
  } catch (err) {
    console.error("[WhatsApp] sendText failed:", err.response?.data || err.message);
  }
}

/**
 * Sends an image with an optional caption.
 *
 * @param {string} to        - E.164 without '+'
 * @param {string} imageUrl  - Publicly accessible URL of the image
 * @param {string} caption   - Optional caption text
 */
async function sendImage(to, imageUrl, caption = "") {
  try {
    // Fix Drive URLs: export=download redirects break Green API — use export=view
    const fixedUrl = imageUrl.includes('drive.google.com/uc?export=download')
      ? imageUrl.replace('export=download', 'export=view')
      : imageUrl;
    await sendImageByUrl(to, fixedUrl, caption);
  } catch (err) {
    console.error("[WhatsApp] sendImage failed:", err.message);
  }
}

// ─── Pre-built message templates ─────────────────────────────────────────────

/**
 * Step 1 — The Hook: Intercepts the COD selection and pitches the token model.
 */
async function sendTokenRequestMessage(to, { productName, totalAmount, tokenAmount, codBalance }) {
  const message =
    `🔒 *Size Lock Required*\n\n` +
    `Great choice on the *${productName}*! 🐼\n\n` +
    `To filter out fake orders and guarantee your size stays off the public catalog, ` +
    `we require a *₹${tokenAmount} confirmation token* upfront.\n\n` +
    `💰 *Order Breakdown:*\n` +
    `• Sneaker price: ₹${totalAmount}\n` +
    `• Token (pay now): *₹${tokenAmount}*\n` +
    `• At your door (COD): ₹${codBalance}\n\n` +
    `Your link is on its way. 👇`;

  await sendText(to, message);
}

/**
 * Step 2 — The Drop: Sends the live ₹500 Razorpay payment link.
 */
async function sendPaymentLink(to, { paymentUrl, productName, expiresMinutes }) {
  const message =
    `💳 *Complete your ₹${tokenAmount} token here:*\n` +
    `${paymentUrl}\n\n` +
    `⏳ This link is valid for *${expiresMinutes} minutes only*.\n` +
    `After that, your size on the *${productName}* goes back to the public catalog.\n\n` +
    `_UPI · Cards · Net Banking — all accepted._`;

  await sendText(to, message);
}

/**
 * Step 3 — The Hype Confirmation: Fires the moment ₹500 webhook hits.
 */
async function sendTokenConfirmation(to, { productName, orderId, codBalance }) {
  const message =
    `✅ *₹${tokenAmount} received. You're locked in!*\n\n` +
    `Your *${productName}* is heading to the packing table right now. 🚀\n\n` +
    `📦 *Order ID:* \`${orderId}\`\n` +
    `💵 *Balance at door (COD):* ₹${codBalance}\n\n` +
    `We'll share tracking details once your pair is dispatched. Stay hyped! 🔥`;

  await sendText(to, message);
}

/**
 * Token expiry reminder — fired at T-5 minutes by the cron job.
 */
async function sendExpiryReminder(to, { productName, paymentUrl, minutesLeft, tokenAmount }) {
  const message =
    `⚠️ *Hurry! Only ${minutesLeft} minutes left!*\n\n` +
    `Your size lock on *${productName}* expires soon.\n` +
    `Complete your ₹500 token now or your size goes back on sale:\n` +
    `${paymentUrl}`;

  await sendText(to, message);
}

/**
 * Expired slot notification — fired when cron marks order EXPIRED.
 */
async function sendExpiredMessage(to, { productName }) {
  const message =
    `😔 *Your size lock has expired.*\n\n` +
    `The token window for *${productName}* has closed and your size ` +
    `has been released back to the catalog.\n\n` +
    `Want to try again? Just type the model name and we'll check availability! 👟`;

  await sendText(to, message);
}

module.exports = {
  sendText,
  sendImage,
  sendTokenRequestMessage,
  sendPaymentLink,
  sendTokenConfirmation,
  sendExpiryReminder,
  sendExpiredMessage,
};
