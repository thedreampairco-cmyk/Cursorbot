/**
 * services/adminAlertService.js
 *
 * Sends real-time alerts to the store owner / ops team via:
 *   • Slack  — rich Block Kit message to a channel (primary)
 *   • Twilio — SMS fallback for critical alerts (optional, enabled by env var)
 *
 * Required env vars:
 *   SLACK_WEBHOOK_URL     — Incoming Webhook URL from Slack App config
 *   ADMIN_SLACK_CHANNEL   — e.g. "#orders" (optional override; webhook url already targets a channel)
 *
 * Optional env vars (Twilio SMS — only fires if both are set):
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_FROM_NUMBER    — your Twilio number e.g. "+12015551234"
 *   ADMIN_PHONE_NUMBER    — owner's number e.g. "+919876543210"
 */

const axios = require("axios");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatINR(amount) {
  return `₹${Number(amount).toLocaleString("en-IN")}`;
}

function now() {
  return new Date().toLocaleString("en-IN", {
    timeZone:    "Asia/Kolkata",
    day:         "2-digit",
    month:       "short",
    hour:        "2-digit",
    minute:      "2-digit",
    hour12:      true,
  });
}

// ─── Slack ────────────────────────────────────────────────────────────────────

/**
 * Sends a Slack Block Kit message to the configured webhook URL.
 * @param {object} blocks  — Slack Block Kit blocks array
 * @param {string} fallback — Plain-text fallback for notifications
 */
async function postToSlack(blocks, fallback) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    console.warn("[AdminAlert] SLACK_WEBHOOK_URL not set — skipping Slack alert");
    return;
  }

  await axios.post(url, { text: fallback, blocks });
  console.log("[AdminAlert] ✅ Slack alert sent");
}

// ─── Twilio SMS ───────────────────────────────────────────────────────────────

/**
 * Sends an SMS via Twilio REST API (no package needed — raw HTTP).
 * Silently skips if any Twilio env var is missing.
 *
 * @param {string} body — SMS text (max 160 chars for single segment)
 */
async function sendSms(body) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_FROM_NUMBER;
  const to    = process.env.ADMIN_PHONE_NUMBER;

  if (!sid || !token || !from || !to) {
    // Twilio is optional — don't warn if none of the vars are set
    if (sid || token || from || to) {
      console.warn("[AdminAlert] Twilio partially configured — SMS skipped. Check env vars.");
    }
    return;
  }

  // Twilio API uses Basic Auth + form-encoded body
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  await axios.post(
    url,
    new URLSearchParams({ From: from, To: to, Body: body }).toString(),
    {
      auth:    { username: sid, password: token },
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }
  );
  console.log(`[AdminAlert] ✅ SMS sent to ${to}`);
}


// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * alertNewOrder — fires the moment a new order token is confirmed.
 * Sends Slack (Block Kit) + SMS simultaneously.
 *
 * @param {object} order — Full order document / plain object
 */
async function alertNewOrder(order) {
  const { order_id, product, total_amount, advance_paid, cod_balance, whatsapp_number } = order;

  // ── Slack Block Kit ─────────────────────────────────────────────────────────
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "🟢 New Order — Token Confirmed", emoji: true },
    },
    { type: "divider" },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Order ID*\n\`${order_id}\`` },
        { type: "mrkdwn", text: `*Time*\n${now()} IST` },
        { type: "mrkdwn", text: `*Product*\n${product.name}` },
        { type: "mrkdwn", text: `*Size / SKU*\nEU ${product.size} · \`${product.sku}\`` },
        { type: "mrkdwn", text: `*Token Paid*\n${formatINR(advance_paid)}` },
        { type: "mrkdwn", text: `*COD Due at Door*\n${formatINR(cod_balance)}` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Total Order Value:* ${formatINR(total_amount)} · *WhatsApp:* +${whatsapp_number}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type:      "button",
          text:      { type: "plain_text", text: "📦 Mark Packing", emoji: true },
          style:     "primary",
          value:     order_id,
          action_id: "mark_packing",
        },
        {
          type:      "button",
          text:      { type: "plain_text", text: "💬 WhatsApp Customer", emoji: true },
          url:       `https://wa.me/${whatsapp_number}`,
          action_id: "open_whatsapp",
        },
      ],
    },
    { type: "divider" },
  ];

  const fallback =
    `🟢 NEW ORDER: ${product.name} (Size ${product.size}) | ` +
    `Token ₹${advance_paid} | COD ₹${cod_balance} | ID: ${order_id}`;

  // ── SMS ──────────────────────────────────────────────────────────────────────
  const smsBody =
    `Dream Pair ORDER: ${product.name} Sz${product.size}\n` +
    `Token: ${formatINR(advance_paid)} | COD: ${formatINR(cod_balance)}\n` +
    `ID: ${order_id}`;

  // Run Slack + SMS simultaneously — neither blocks the other
  await Promise.allSettled([
    postToSlack(blocks, fallback),
    sendSms(smsBody),
  ]);
}

/**
 * alertOOS — fires when a post-payment Out-Of-Stock is detected.
 * This is a critical alert — delivery cannot happen, refund required.
 *
 * @param {object} order
 */
async function alertOOS(order) {
  const { order_id, product, advance_paid, whatsapp_number } = order;

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "🔴 URGENT: OOS After Payment — Refund Required", emoji: true },
    },
    { type: "divider" },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Order ID*\n\`${order_id}\`` },
        { type: "mrkdwn", text: `*Time*\n${now()} IST` },
        { type: "mrkdwn", text: `*Product*\n${product.name}` },
        { type: "mrkdwn", text: `*SKU*\n\`${product.sku}\`` },
        { type: "mrkdwn", text: `*Amount to Refund*\n${formatINR(advance_paid)}` },
        { type: "mrkdwn", text: `*Customer WA*\n+${whatsapp_number}` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "⚠️ *Action required:* Process the refund via Razorpay Dashboard. " +
              "Customer has been notified via WhatsApp.",
      },
    },
    { type: "divider" },
  ];

  const fallback =
    `🔴 URGENT OOS: ${product.name} (${product.sku}) — ` +
    `Refund ${formatINR(advance_paid)} to +${whatsapp_number} | Order ${order_id}`;

  const smsBody =
    `URGENT Dream Pair OOS!\n${product.name} oversold.\n` +
    `Refund ${formatINR(advance_paid)} — Order ${order_id}`;

  await Promise.allSettled([
    postToSlack(blocks, fallback),
    sendSms(smsBody),
  ]);
}

/**
 * alertLowStock — fires when inventory for a SKU drops to a warning threshold.
 *
 * @param {string} sku
 * @param {string} productName
 * @param {number} remainingStock
 */
async function alertLowStock(sku, productName, remainingStock) {
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `⚠️ Low Stock: ${productName}`, emoji: true },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*SKU*\n\`${sku}\`` },
        { type: "mrkdwn", text: `*Remaining Stock*\n${remainingStock} pair${remainingStock !== 1 ? "s" : ""}` },
      ],
    },
  ];

  const fallback = `⚠️ LOW STOCK: ${productName} (${sku}) — ${remainingStock} left`;
  const smsBody  = `Dream Pair LOW STOCK: ${productName} (${sku}) — ${remainingStock} remaining`;

  await Promise.allSettled([
    postToSlack(blocks, fallback),
    sendSms(smsBody),
  ]);
}

module.exports = { alertNewOrder, alertOOS, alertLowStock };
