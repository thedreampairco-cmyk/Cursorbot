/**
 * orderController.js
 * Handles COD order creation and kicks off the ₹500 token payment flow.
 * Called by Maya (the Groq LLM layer) when a user confirms a COD purchase.
 */

const { v4: uuidv4 }            = require("uuid");
const { Order, PAYMENT_STATUS } = require("../models/Order");
const paymentService            = require("../services/paymentService");
const whatsappService           = require("../services/whatsappService");
const inventoryService          = require("../services/inventoryService");

/**
 * Creates a new COD order and initiates the full token payment UX sequence:
 *   1. Validates stock is available
 *   2. Persists the order as AWAITING_TOKEN
 *   3. Generates a Razorpay ₹500 payment link
 *   4. Sends the Hook message → Payment link → Timer warning via WhatsApp
 *
 * @param {object} params
 * @param {string} params.whatsappNumber   - Customer E.164 number "91XXXXXXXXXX"
 * @param {string} params.customerName     - Customer name from conversation
 * @param {object} params.product          - { sku, name, size, color, image_url }
 * @param {number} params.totalAmount      - Full price in ₹ (e.g. 12000)
 * @param {object} params.deliveryAddress  - { line1, line2, city, state, pincode }
 *
 * @returns {Promise<{ order: Order, paymentUrl: string }>}
 */
async function initiateCodTokenFlow({
  whatsappNumber,
  customerName,
  product,
  totalAmount,
  deliveryAddress,
}) {
  // ── 1. Check live stock before creating the order ─────────────────────────
  const stock = await inventoryService.getStock(product.sku);
  if (stock <= 0) {
    await whatsappService.sendText(
      whatsappNumber,
      `😔 Sorry, the *${product.name}* in size *${product.size}* just sold out. ` +
      `Type the model name and I'll check for similar options! 👟`
    );
    throw new Error(`OUT_OF_STOCK: ${product.sku}`);
  }

  // ── 2. Build the order document ───────────────────────────────────────────
  const orderId     = `TDP-${Date.now()}-${uuidv4().slice(0, 6).toUpperCase()}`;
  const tokenAmount = paymentService.TOKEN_AMOUNT_INR;
  const codBalance  = totalAmount - tokenAmount;
  const expiresAt   = new Date(Date.now() + paymentService.TOKEN_WINDOW_MIN * 60 * 1000);

  const order = new Order({
    order_id:         orderId,
    whatsapp_number:  whatsappNumber,
    product,
    total_amount:     totalAmount,
    advance_paid:     0, // updated by webhook on payment
    cod_balance:      codBalance,
    payment_status:   PAYMENT_STATUS.AWAITING_TOKEN,
    token_expires_at: expiresAt,
    delivery_address: deliveryAddress,
    status_history:   [{ status: PAYMENT_STATUS.AWAITING_TOKEN, note: "Order initiated via Maya bot" }],
  });

  await order.save();
  console.log(`[Order] Created ${orderId} for ${whatsappNumber}`);

  // ── 3. Generate Razorpay payment link ─────────────────────────────────────
  const { payment_link_id, payment_link_url } =
    await paymentService.createTokenPaymentLink({
      orderId,
      whatsappNumber,
      productName:  product.name,
      customerName,
    });

  order.razorpay.payment_link_id  = payment_link_id;
  order.razorpay.payment_link_url = payment_link_url;
  await order.save();

  // ── 4. WhatsApp UX sequence (non-blocking, best-effort) ───────────────────

  // 4a. Send product image if available
  if (product.image_url) {
    await whatsappService.sendImage(
      whatsappNumber,
      product.image_url,
      `${product.name} — Size ${product.size}`
    );
  }

  // 4b. The Hook
  await whatsappService.sendTokenRequestMessage(whatsappNumber, {
    productName:  product.name,
    totalAmount,
    tokenAmount,
    codBalance,
  });

  // 4c. The Drop — live payment link
  await whatsappService.sendPaymentLink(whatsappNumber, {
    paymentUrl:     payment_link_url,
    productName:    product.name,
    expiresMinutes: paymentService.TOKEN_WINDOW_MIN,
  });

  return { order, paymentUrl: payment_link_url };
}

/**
 * Fetches an order by order_id. Used by the webhook and bot status checks.
 *
 * @param {string} orderId
 * @returns {Promise<Order|null>}
 */
async function getOrderById(orderId) {
  return Order.findOne({ order_id: orderId });
}

/**
 * Fetches the latest open order for a WhatsApp number.
 * "Open" = AWAITING_TOKEN or TOKEN_RECEIVED.
 */
async function getOpenOrderForUser(whatsappNumber) {
  return Order.findOne({
    whatsapp_number: whatsappNumber,
    payment_status:  { $in: [PAYMENT_STATUS.AWAITING_TOKEN, PAYMENT_STATUS.TOKEN_RECEIVED] },
  }).sort({ createdAt: -1 });
}

module.exports = { initiateCodTokenFlow, getOrderById, getOpenOrderForUser };
