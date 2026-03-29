/**
 * services/emailService.js
 *
 * Sends transactional emails via SendGrid.
 * Lazy-initialised — client is built on first call, not at require() time,
 * so the module imports cleanly in tests without a real API key present.
 *
 * Required env vars:
 *   SENDGRID_API_KEY      — your SendGrid secret key (starts with "SG.")
 *   EMAIL_FROM            — verified sender address  (e.g. orders@dreampair.in)
 *   EMAIL_FROM_NAME       — display name             (e.g. "Dream Pair")
 */

const axios = require("axios");

const SENDGRID_API = "https://api.sendgrid.com/v3/mail/send";

// ─── Lazy client ──────────────────────────────────────────────────────────────
function getHeaders() {
  const key = process.env.SENDGRID_API_KEY;
  if (!key) throw new Error("SENDGRID_API_KEY is not set");
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

// ─── HTML email builder ───────────────────────────────────────────────────────
/**
 * Generates a clean, on-brand HTML order confirmation.
 *
 * @param {object} order
 * @param {string} order.order_id
 * @param {string} order.product.name
 * @param {string} order.product.size
 * @param {string} order.product.sku
 * @param {number} order.total_amount
 * @param {number} order.advance_paid
 * @param {number} order.cod_balance
 * @param {string} order.whatsapp_number
 */
function buildConfirmationHtml(order) {
  const {
    order_id,
    product,
    total_amount,
    advance_paid,
    cod_balance,
  } = order;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Order Confirmed — Dream Pair</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0"
             style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr>
          <td style="background:#111111;padding:32px 40px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:24px;letter-spacing:2px;text-transform:uppercase;">
              Dream Pair 👟
            </h1>
          </td>
        </tr>

        <!-- Hero -->
        <tr>
          <td style="padding:40px 40px 24px;text-align:center;">
            <p style="margin:0 0 8px;font-size:32px;">🔒</p>
            <h2 style="margin:0 0 8px;font-size:22px;color:#111111;">Your Size Is Locked In</h2>
            <p style="margin:0;color:#666666;font-size:15px;">
              Token received. Your pair is heading to the packing table.
            </p>
          </td>
        </tr>

        <!-- Order Summary -->
        <tr>
          <td style="padding:0 40px 32px;">
            <table width="100%" cellpadding="0" cellspacing="0"
                   style="background:#f9f9f9;border-radius:6px;padding:24px;border:1px solid #eeeeee;">
              <tr>
                <td colspan="2" style="padding-bottom:16px;border-bottom:1px solid #e5e5e5;margin-bottom:16px;">
                  <span style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#999999;">
                    Order Reference
                  </span><br/>
                  <span style="font-size:16px;font-weight:bold;color:#111111;font-family:monospace;">
                    ${order_id}
                  </span>
                </td>
              </tr>
              <tr><td height="16"></td></tr>
              <tr>
                <td style="color:#555555;font-size:14px;padding:6px 0;">Product</td>
                <td style="color:#111111;font-size:14px;font-weight:600;text-align:right;padding:6px 0;">
                  ${product.name}
                </td>
              </tr>
              <tr>
                <td style="color:#555555;font-size:14px;padding:6px 0;">Size</td>
                <td style="color:#111111;font-size:14px;font-weight:600;text-align:right;padding:6px 0;">
                  EU ${product.size}
                </td>
              </tr>
              <tr>
                <td style="color:#555555;font-size:14px;padding:6px 0;">SKU</td>
                <td style="color:#999999;font-size:13px;font-family:monospace;text-align:right;padding:6px 0;">
                  ${product.sku}
                </td>
              </tr>
              <tr><td colspan="2" style="padding:12px 0;"><hr style="border:none;border-top:1px solid #e5e5e5;"/></td></tr>
              <tr>
                <td style="color:#555555;font-size:14px;padding:6px 0;">Sneaker Price</td>
                <td style="color:#111111;font-size:14px;text-align:right;padding:6px 0;">
                  ₹${total_amount.toLocaleString("en-IN")}
                </td>
              </tr>
              <tr>
                <td style="color:#22a861;font-size:14px;padding:6px 0;">✅ Token Paid</td>
                <td style="color:#22a861;font-size:14px;font-weight:700;text-align:right;padding:6px 0;">
                  − ₹${advance_paid.toLocaleString("en-IN")}
                </td>
              </tr>
              <tr>
                <td style="color:#111111;font-size:15px;font-weight:700;padding:10px 0 0;">
                  Due at Your Door (COD)
                </td>
                <td style="color:#111111;font-size:18px;font-weight:800;text-align:right;padding:10px 0 0;">
                  ₹${cod_balance.toLocaleString("en-IN")}
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- CTA -->
        <tr>
          <td style="padding:0 40px 40px;text-align:center;">
            <p style="color:#555555;font-size:14px;line-height:1.6;margin:0 0 24px;">
              We'll send your tracking details on WhatsApp the moment your pair is dispatched.
              Keep an eye on your messages!
            </p>
            <a href="https://wa.me/${order.whatsapp_number}"
               style="display:inline-block;background:#111111;color:#ffffff;text-decoration:none;
                      padding:14px 32px;border-radius:4px;font-size:14px;font-weight:600;
                      letter-spacing:0.5px;">
              Chat With Us on WhatsApp
            </a>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f0f0f0;padding:20px 40px;text-align:center;">
            <p style="margin:0;color:#aaaaaa;font-size:12px;line-height:1.6;">
              Dream Pair © ${new Date().getFullYear()} · You received this because you placed an order.<br/>
              Questions? Reply to this email or WhatsApp us anytime.
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── Plain-text fallback ───────────────────────────────────────────────────────
function buildConfirmationText(order) {
  const { order_id, product, total_amount, advance_paid, cod_balance } = order;
  return [
    "DREAM PAIR — ORDER CONFIRMED",
    "══════════════════════════════",
    `Order ID   : ${order_id}`,
    `Product    : ${product.name}`,
    `Size       : EU ${product.size}`,
    `SKU        : ${product.sku}`,
    "──────────────────────────────",
    `Sneaker    : ₹${total_amount.toLocaleString("en-IN")}`,
    `Token Paid : ₹${advance_paid.toLocaleString("en-IN")}`,
    `Due at door: ₹${cod_balance.toLocaleString("en-IN")}`,
    "──────────────────────────────",
    "Your size is locked. Tracking details follow on WhatsApp once dispatched.",
  ].join("\n");
}


// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * sendOrderConfirmation — fires the post-payment email to the customer.
 *
 * @param {string} toEmail     - Customer's email address
 * @param {string} toName      - Customer's name
 * @param {object} order       - Full order object (or plain data matching the shape above)
 * @returns {Promise<void>}
 * @throws  on SendGrid API errors (caller handles via Promise.allSettled)
 */
async function sendOrderConfirmation(toEmail, toName, order) {
  const payload = {
    personalizations: [{
      to: [{ email: toEmail, name: toName }],
      subject: `🔒 Your ${order.product.name} (Size ${order.product.size}) is locked in — Order ${order.order_id}`,
    }],
    from: {
      email: process.env.EMAIL_FROM      || "orders@dreampair.in",
      name:  process.env.EMAIL_FROM_NAME || "Dream Pair",
    },
    reply_to: {
      email: process.env.EMAIL_REPLY_TO  || "support@dreampair.in",
      name:  "Dream Pair Support",
    },
    content: [
      { type: "text/plain", value: buildConfirmationText(order) },
      { type: "text/html",  value: buildConfirmationHtml(order) },
    ],
    // SendGrid categories for analytics dashboard
    categories: ["order-confirmation", "transactional"],
    custom_args: {
      order_id: order.order_id,
      sku:      order.product.sku,
    },
  };

  await axios.post(SENDGRID_API, payload, { headers: getHeaders() });
  console.log(`[Email] ✅ Confirmation sent to ${toEmail} for order ${order.order_id}`);
}

/**
 * sendRefundNotification — fires when an order hits REFUND_PENDING state.
 *
 * @param {string} toEmail
 * @param {string} toName
 * @param {object} order
 */
async function sendRefundNotification(toEmail, toName, order) {
  const payload = {
    personalizations: [{
      to: [{ email: toEmail, name: toName }],
      subject: `Refund in progress — Order ${order.order_id}`,
    }],
    from: {
      email: process.env.EMAIL_FROM      || "orders@dreampair.in",
      name:  process.env.EMAIL_FROM_NAME || "Dream Pair",
    },
    content: [{
      type: "text/plain",
      value: [
        `Hi ${toName},`,
        "",
        `We're sorry — your order (${order.order_id}) for ${order.product.name} ` +
        `could not be fulfilled because the size sold out moments before your ` +
        `payment confirmed.`,
        "",
        `Your ₹${order.advance_paid} will be refunded within 2–3 business days ` +
        `to your original payment method.`,
        "",
        "We apologise for the inconvenience.",
        "— Dream Pair Team",
      ].join("\n"),
    }],
    categories: ["refund", "transactional"],
    custom_args: { order_id: order.order_id },
  };

  await axios.post(SENDGRID_API, payload, { headers: getHeaders() });
  console.log(`[Email] ✅ Refund notification sent to ${toEmail} for order ${order.order_id}`);
}

module.exports = { sendOrderConfirmation, sendRefundNotification };
