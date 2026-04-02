// services/whatsapp/whatsappService.js
"use strict";

const { logger, AppError } = require("../../errorHandler");
const {
  sendTextMessage,
  sendButtonMessage,
  sendListMessage,
  sendLocationMessage,
} = require("./greenApiText");
const { sendImageByUrl } = require("./greenApiMedia");

const ADMIN_PHONE  = process.env.ADMIN_WA_PHONE;
const HUMAN_AGENT  = process.env.HUMAN_AGENT_WHATSAPP;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Wraps a Green API call with a consistent AppError on failure.
 * @param {string} context - label for logs
 * @param {Function} fn
 * @param {string} errorCode
 */
async function _wrap(context, fn, errorCode) {
  try {
    return await fn();
  } catch (err) {
    logger.error(`[WhatsApp] ${context} failed: ${err.message}`);
    throw new AppError(`${context} failed: ${err.message}`, 502, errorCode);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Send a plain text message.
 * @param {string} phone
 * @param {string} text
 */
async function sendMessage(phone, text) {
  return _wrap("sendMessage", () => sendTextMessage(phone, text), "WHATSAPP_SEND_FAILED");
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRODUCT / CATALOG
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Send a product card with image, name, price, and available sizes.
 * @param {string} phone
 * @param {{ sku, brand, name, price, sizes, imageUrl, description }} product
 */
async function sendProductCard(phone, product) {
  return _wrap(
    "sendProductCard",
    async () => {
      const { name, brand, price, sizes, imageUrl, sku, description } = product;
      const sizeList = Array.isArray(sizes) ? sizes.join(", ") : sizes;
      const caption =
        `👟 *${brand} ${name}*\n` +
        `🏷️ SKU: \`${sku}\`\n` +
        `💰 ₹${Number(price).toLocaleString("en-IN")}\n` +
        `📏 Sizes: ${sizeList || "Ask us"}\n` +
        (description ? `\n📝 ${description}` : "");

      if (imageUrl) {
        await sendImageByUrl(phone, imageUrl, caption);
      } else {
        await sendTextMessage(phone, caption);
      }
      logger.info(`[WhatsApp] Product card sent to ${phone}: ${sku}`);
    },
    "PRODUCT_CARD_FAILED"
  );
}

/**
 * Send a size-selector button message for a product (max 3 sizes per message).
 * For more than 3 sizes, send as a list message instead.
 * @param {string} phone
 * @param {{ brand: string, name: string, sku: string }} product
 * @param {string[]} availableSizes
 */
async function sendSizeSelector(phone, product, availableSizes) {
  return _wrap(
    "sendSizeSelector",
    async () => {
      const text = `📏 Select your size for *${product.brand} ${product.name}*:`;

      if (availableSizes.length <= 3) {
        const buttons = availableSizes.map((size) => ({
          buttonId:   `size_${product.sku}_${size}`,
          buttonText: `Size ${size}`,
        }));
        await sendButtonMessage(phone, text, buttons);
      } else {
        // More than 3 sizes — use list message
        const sections = [
          {
            title: "Available Sizes",
            rows: availableSizes.map((size) => ({
              rowId:       `size_${product.sku}_${size}`,
              title:       `Size ${size}`,
              description: "Tap to select",
            })),
          },
        ];
        await sendListMessage(phone, text, "📏 Choose Size", sections);
      }
    },
    "SIZE_SELECTOR_FAILED"
  );
}

/**
 * Send the catalog browse menu as a list message.
 * @param {string} phone
 * @param {Array<{ name: string, count: number }>} categories
 */
async function sendCatalogMenu(phone, categories) {
  return _wrap(
    "sendCatalogMenu",
    async () => {
      const sections = [
        {
          title: "Browse Categories",
          rows: categories.map((cat, i) => ({
            rowId:       `cat_${i + 1}`,
            title:       cat.name,
            description: `${cat.count} style${cat.count !== 1 ? "s" : ""} available`,
          })),
        },
      ];
      await sendListMessage(
        phone,
        "👟 Welcome to *The Dream Pair*! What are you looking for today?",
        "📂 Categories",
        sections
      );
    },
    "CATALOG_MENU_FAILED"
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CART
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Send a cart summary with Checkout / Clear / Continue-shopping buttons.
 * @param {string} phone
 * @param {string} cartMessage  - formatted cart string from memoryStore.formatCartMessage
 */
async function sendCartSummary(phone, cartMessage) {
  return _wrap(
    "sendCartSummary",
    async () => {
      const text = `🛒 *Your Cart*\n\n${cartMessage}`;
      const buttons = [
        { buttonId: "checkout",           buttonText: "✅ Checkout" },
        { buttonId: "clear_cart",         buttonText: "🗑️ Clear Cart" },
        { buttonId: "continue_shopping",  buttonText: "🛍️ Keep Shopping" },
      ];
      await sendButtonMessage(phone, text, buttons);
    },
    "CART_SUMMARY_FAILED"
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Send a Razorpay payment link to the customer.
 * @param {string} phone
 * @param {string} paymentUrl
 * @param {number} amount
 * @param {string} orderId
 */
async function sendPaymentLink(phone, paymentUrl, amount, orderId) {
  return _wrap(
    "sendPaymentLink",
    async () => {
      const text =
        `💳 *Payment Link Ready*\n\n` +
        `🆔 Order: \`${orderId}\`\n` +
        `💰 Amount: *₹${Number(amount).toLocaleString("en-IN")}*\n\n` +
        `Tap below to complete your payment:\n${paymentUrl}\n\n` +
        `⏰ This link expires in *15 minutes*.`;
      await sendTextMessage(phone, text);
      logger.info(`[WhatsApp] Payment link sent to ${phone} for order ${orderId}`);
    },
    "PAYMENT_LINK_SEND_FAILED"
  );
}

/**
 * Send a COD security deposit request.
 * @param {string} phone
 * @param {number} depositAmount
 * @param {string} paymentUrl
 * @param {string} orderId
 */
async function sendCodDepositRequest(phone, depositAmount, paymentUrl, orderId) {
  return _wrap(
    "sendCodDepositRequest",
    async () => {
      const text =
        `🔒 *COD Security Deposit Required*\n\n` +
        `A fully refundable deposit of *₹${Number(depositAmount).toLocaleString("en-IN")}* ` +
        `is required to confirm your Cash on Delivery order.\n\n` +
        `✅ This amount is returned to you at delivery.\n\n` +
        `💳 Pay now: ${paymentUrl}\n\n` +
        `🆔 Order Ref: \`${orderId}\`\n` +
        `⏰ Link valid for 15 minutes.`;
      await sendTextMessage(phone, text);
      logger.info(`[WhatsApp] COD deposit request sent to ${phone}`);
    },
    "COD_DEPOSIT_SEND_FAILED"
  );
}

/**
 * Send order confirmation to the customer.
 * @param {string} phone
 * @param {{ orderId, items, total, address, estimatedDelivery, paymentMethod }} order
 */
async function sendOrderConfirmation(phone, order) {
  return _wrap(
    "sendOrderConfirmation",
    async () => {
      const { orderId, items, total, address, estimatedDelivery, paymentMethod } = order;
      const itemLines = (items || [])
        .map(
          (i) =>
            `  • *${i.brand || ""} ${i.name}* | Size ${i.size} × ${i.qty}` +
            ` — ₹${(i.price * i.qty).toLocaleString("en-IN")}`
        )
        .join("\n");

      const text =
        `✅ *Order Confirmed! 🎉*\n\n` +
        `🆔 Order ID: \`${orderId}\`\n\n` +
        `📦 *Items:*\n${itemLines}\n\n` +
        `💰 Total: *₹${Number(total).toLocaleString("en-IN")}*\n` +
        `💳 Payment: ${paymentMethod}\n` +
        `📍 Deliver to: ${address}\n` +
        (estimatedDelivery ? `🚚 ETA: ${estimatedDelivery}\n` : "") +
        `\n_Thank you for shopping with The Dream Pair!_ 🙏`;

      await sendTextMessage(phone, text);
      logger.info(`[WhatsApp] Order confirmation sent to ${phone}: ${orderId}`);
    },
    "ORDER_CONFIRM_FAILED"
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// FRAUD / COMPLIANCE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Send unboxing video instructions to the customer.
 * @param {string} phone
 * @param {string} orderId
 * @param {string} uploadUrl
 */
async function sendUnboxingInstructions(phone, orderId, uploadUrl) {
  return _wrap(
    "sendUnboxingInstructions",
    async () => {
      const text =
        `📹 *Unboxing Video Required*\n\n` +
        `To protect both parties, please record a continuous unboxing video *before* opening the package.\n\n` +
        `📋 *Steps:*\n` +
        `1️⃣ Show the sealed package clearly.\n` +
        `2️⃣ Display the label — Order ID: \`${orderId}\`\n` +
        `3️⃣ Open the package on camera without cuts.\n\n` +
        `📤 Upload here:\n${uploadUrl}\n\n` +
        `⚠️ _No video = no return/exchange eligibility._`;
      await sendTextMessage(phone, text);
      logger.info(`[WhatsApp] Unboxing instructions sent to ${phone}`);
    },
    "UNBOXING_SEND_FAILED"
  );
}

/**
 * Request live location from the customer for delivery verification.
 * @param {string} phone
 */
async function requestLiveLocation(phone) {
  return _wrap(
    "requestLiveLocation",
    async () => {
      const text =
        `📍 *Location Verification Required*\n\n` +
        `To process your order, please share your *live location* now.\n\n` +
        `Tap the 📎 attachment icon → select *Location* → Share Live Location.`;
      await sendTextMessage(phone, text);
      logger.info(`[WhatsApp] Location request sent to ${phone}`);
    },
    "LOCATION_REQUEST_FAILED"
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN / AGENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Send an admin alert. Silently skips if ADMIN_WA_PHONE is not set.
 * @param {string} message
 */
async function notifyAdmin(message) {
  if (!ADMIN_PHONE) {
    logger.warn("[WhatsApp] ADMIN_WA_PHONE not configured — admin notification skipped.");
    return;
  }
  try {
    await sendTextMessage(ADMIN_PHONE, `🔔 *Admin Alert*\n\n${message}`);
    logger.info("[WhatsApp] Admin notification sent.");
  } catch (err) {
    logger.error(`[WhatsApp] notifyAdmin failed: ${err.message}`);
    // Admin alerts are non-critical — do not rethrow
  }
}

/**
 * Send a low-stock alert to the admin.
 * @param {{ sku: string, name: string, stock: number }} product
 */
async function sendLowStockAlert(product) {
  if (!ADMIN_PHONE) return;
  try {
    const text =
      `⚠️ *Low Stock Alert*\n\n` +
      `👟 *${product.name}*\n` +
      `SKU: ${product.sku}\n` +
      `Remaining: *${product.stock} units*\n\n` +
      `Please restock soon.`;
    await sendTextMessage(ADMIN_PHONE, text);
  } catch (err) {
    logger.error(`[WhatsApp] sendLowStockAlert failed: ${err.message}`);
  }
}

/**
 * Initiate a handoff to a human agent — notify the customer and the agent.
 * @param {string} phone
 * @param {string} [reason]
 */
async function handoffToHuman(phone, reason = "Customer requested support") {
  return _wrap(
    "handoffToHuman",
    async () => {
      await sendTextMessage(
        phone,
        `🙋 *Connecting you to our team...*\n\nA team member will assist you shortly. Please hold on! 😊`
      );

      if (HUMAN_AGENT) {
        await sendTextMessage(
          HUMAN_AGENT,
          `🔔 *Handoff Request*\n\n` +
          `Customer: ${phone}\n` +
          `Reason: ${reason}\n\n` +
          `Please respond to this customer as soon as possible.`
        );
      }

      logger.info(`[WhatsApp] Human handoff initiated for ${phone}`);
    },
    "HANDOFF_FAILED"
  );
}

module.exports = {
  sendMessage,
  sendProductCard,
  sendSizeSelector,
  sendCatalogMenu,
  sendCartSummary,
  sendPaymentLink,
  sendCodDepositRequest,
  sendOrderConfirmation,
  sendUnboxingInstructions,
  requestLiveLocation,
  notifyAdmin,
  sendLowStockAlert,
  handoffToHuman,
};
