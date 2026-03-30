/**
 * ============================================================
 *  webhook.js  —  Green API + Razorpay Unified Webhook Router
 *  Place at: routes/webhook.js
 *
 *  Mount in server.js:
 *    const webhookRouter = require('./routes/webhook');
 *    app.use('/webhook', webhookRouter);
 * ============================================================
 *
 *  HANDLES:
 *    ✅  TextMessage / ExtendedTextMessage  → processMessage()
 *    ✅  ImageMessage                       → caption → processMessage()
 *    ✅  AudioMessage / PTTMessage          → Groq Whisper → processMessage()
 *    ✅  Razorpay payment callbacks         → handlePaymentCallback()
 *    ✅  outgoingMessageStatus              → delivery receipts (logged only)
 *    ✅  stateInstanceChanged               → instance health (logged only)
 *    ⚠️  ReactionMessage                   → silently acknowledged
 *    ❌  Everything else                    → "not supported" reply sent to user
 *
 *  ENV VARS — add all of these to your .env:
 *    GREEN_API_WEBHOOK_TOKEN=<secret_set_in_green_api_console>   ← INSERT
 *    RAZORPAY_WEBHOOK_SECRET=<secret_set_in_razorpay_dashboard>  ← INSERT
 *    RAZORPAY_KEY_ID=<your_razorpay_key_id>                      ← INSERT
 *    RAZORPAY_KEY_SECRET=<your_razorpay_key_secret>              ← INSERT
 * ============================================================
 */

'use strict';

const express = require('express');
const crypto  = require('crypto');  // built-in Node — no install needed
const winston = require('winston');

const router = express.Router();

// ─── Internal services ───────────────────────────────────────────────────────
// ← UPDATE these three require paths if your folder layout differs
const { handleIncomingAudio } = require('../services/features/voiceSearchService');
const { getAIResponse }      = require('../services/aiResponse');      // ← Groq AI
const { sendWhatsAppMessage } = require('../services/whatsappService'); // ← update path if needed
// Combines AI response + WhatsApp reply into one call
// Drop-in replacement for processMessage(text, phone)
async function processMessage(text, phone) {
  const reply = await getAIResponse(text);
  await sendWhatsAppMessage(phone, reply);
}

// ─── Logger ──────────────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, ...meta }) =>
      `${timestamp} [Webhook] ${level.toUpperCase()}: ${message} ${
        Object.keys(meta).length ? JSON.stringify(meta) : ''
      }`
    )
  ),
  transports: [new winston.transports.Console()],
});

// ─── User-facing reply strings ────────────────────────────────────────────────
const REPLIES = {
  UNSUPPORTED_TYPE:
    "Sorry, I can only handle text messages, voice notes 🎙️, and images 📸. " +
    "Please type your question or record a voice message!",

  IMAGE_NO_CAPTION:
    "Great image! 📸 To search our catalogue, please type what you're looking for " +
    "or add a caption to your image — e.g. *'Do you have this in size 10?'*",

  AUDIO_NO_URL:
    "Sorry, I couldn't access that voice message. Please try again. 🎙️",

  PAYMENT_CONFIRMED: (orderId) =>
    `✅ Payment confirmed for order *${orderId}*! ` +
    `We're preparing your sneakers and will update you once dispatched. 👟`,

  PAYMENT_FAILED: (orderId) =>
    `❌ Payment failed for order *${orderId}*. ` +
    `Please retry or contact us if the issue persists.`,

  PAYMENT_REFUNDED: (orderId) =>
    `💸 Your refund for order *${orderId}* has been initiated. ` +
    `It typically reflects in 5–7 business days.`,
};

// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 1: MIDDLEWARE & GUARDS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Verifies the optional Green API webhook token.
 * Set GREEN_API_WEBHOOK_TOKEN in your .env and in the Green API console under
 * Settings → Webhooks → Webhook Token.
 * If the env var is absent (e.g. local dev), the check is bypassed.
 */
function verifyGreenApiToken(req, res, next) {
  const secret = process.env.GREEN_API_WEBHOOK_TOKEN; // ← INSERT in .env
  if (!secret) return next();

  const incoming = req.query.token || req.headers['x-green-api-token'];
  if (incoming !== secret) {
    logger.warn('Rejected Green API webhook — invalid token', { ip: req.ip });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/**
 * Verifies Razorpay's HMAC-SHA256 webhook signature.
 *
 * IMPORTANT: This middleware must receive the RAW request body (Buffer),
 * not the parsed JSON. In server.js, register the raw body parser on this
 * route BEFORE express.json(), like so:
 *
 *   app.use('/webhook/payment', express.raw({ type: 'application/json' }));
 *   app.use('/webhook',         express.json());
 *   app.use('/webhook',         webhookRouter);
 *
 * Razorpay docs: https://razorpay.com/docs/webhooks/validate-test/
 */
function verifyRazorpaySignature(req, res, next) {
  const secret    = process.env.RAZORPAY_WEBHOOK_SECRET; // ← INSERT in .env
  const signature = req.headers['x-razorpay-signature'];

  if (!secret) {
    logger.warn('RAZORPAY_WEBHOOK_SECRET not set — skipping signature check');
    return next();
  }

  if (!signature) {
    logger.warn('Razorpay webhook received without signature header', { ip: req.ip });
    return res.status(400).json({ error: 'Missing signature' });
  }

  try {
    // Razorpay signs the raw body bytes — req.body must still be a Buffer here
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body));

    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    const signaturesMatch = crypto.timingSafeEqual(
      Buffer.from(expectedSig, 'hex'),
      Buffer.from(signature,    'hex')
    );

    if (!signaturesMatch) {
      logger.warn('Razorpay webhook signature mismatch', { ip: req.ip });
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Re-parse body as JSON now that we've verified the raw bytes
    req.body = JSON.parse(rawBody.toString());
    next();
  } catch (err) {
    logger.error('Error verifying Razorpay signature', { error: err.message });
    return res.status(400).json({ error: 'Signature verification failed' });
  }
}

/**
 * Returns true when a notification is about a message THIS bot sent.
 * Must guard against these to prevent infinite reply loops.
 */
function isOutgoingMessage(body) {
  return (
    body?.typeWebhook === 'outgoingAPIMessageReceived' ||
    body?.senderData?.sender === body?.instanceData?.wid
  );
}

/**
 * Extracts the normalised sender phone from any Green API notification.
 * Individual chats:  "919876543210@c.us"
 * Group chats:       "120363XXXXXXXX@g.us"
 */
function extractSenderPhone(body) {
  return body?.senderData?.sender ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 2: MESSAGE-TYPE HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * TextMessage + ExtendedTextMessage (quoted replies, URL previews).
 * Both types carry the user intent in the same location in the payload.
 */
async function handleTextMessage(messageData, senderPhone) {
  const text =
    messageData?.textMessageData?.textMessage ||      // plain TextMessage
    messageData?.extendedTextMessageData?.text ||     // quoted / URL preview
    '';

  if (!text.trim()) {
    logger.warn('Text message arrived with empty body', { senderPhone });
    return;
  }

  logger.info('Text message received', { senderPhone, text });
  await processMessage(text.trim(), senderPhone);
}

/**
 * AudioMessage (received from WhatsApp Web / mobile) and
 * PTTMessage    (Push-To-Talk — recorded inside WhatsApp, typically shorter).
 * Both are .ogg files; voiceSearchService handles either transparently.
 */
async function handleAudioMessage(messageData, senderPhone) {
  const downloadUrl = messageData?.fileMessageData?.downloadUrl;

  if (!downloadUrl) {
    logger.error('AudioMessage arrived without a downloadUrl', { senderPhone });
    await sendWhatsAppMessage(senderPhone, REPLIES.AUDIO_NO_URL);
    return;
  }

  logger.info('Audio message received — handing off to voiceSearchService', {
    senderPhone,
    downloadUrl,
  });

  // voiceSearchService owns all error handling + fallback messaging for audio
  await handleIncomingAudio(downloadUrl, senderPhone);
}

/**
 * ImageMessage — if the user attached a caption we treat it as a search query.
 * No caption → prompt them to add one or type their question.
 *
 * Extend this with vision/OCR later if you want reverse sneaker lookup.
 */
async function handleImageMessage(messageData, senderPhone) {
  const caption = messageData?.fileMessageData?.caption?.trim() || '';

  logger.info('Image message received', { senderPhone, hasCaption: !!caption });

  if (caption) {
    logger.info('Processing image caption as search query', { senderPhone, caption });
    await processMessage(caption, senderPhone);
  } else {
    await sendWhatsAppMessage(senderPhone, REPLIES.IMAGE_NO_CAPTION);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 3: PAYMENT CALLBACK HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handles all Razorpay webhook events sent to POST /webhook/payment.
 *
 * Supported events:
 *   payment.captured  → notify buyer, mark order paid in DB
 *   payment.failed    → notify buyer, optionally trigger retry flow
 *   refund.created    → notify buyer of refund
 *
 * The buyer's WhatsApp number must be saved as a note on the Razorpay order
 * at checkout time. Save it under notes.whatsapp_number when creating the
 * order via the Razorpay SDK, e.g.:
 *
 *   razorpay.orders.create({
 *     amount,
 *     currency: 'INR',
 *     notes: { whatsapp_number: '919876543210@c.us' }  ← INSERT AT CHECKOUT
 *   });
 *
 * Razorpay event reference:
 *   https://razorpay.com/docs/webhooks/payloads/payments/
 */
async function handlePaymentCallback(body) {
  const event   = body?.event;
  const payload = body?.payload;

  logger.info('Razorpay webhook event received', { event });

  // ← Adjust this path to match where YOUR checkout saves the phone number
  const senderPhone =
    payload?.payment?.entity?.notes?.whatsapp_number ||
    payload?.order?.entity?.notes?.whatsapp_number ||
    null;

  const orderId =
    payload?.payment?.entity?.order_id ||
    payload?.order?.entity?.id ||
    'N/A';

  const paymentId = payload?.payment?.entity?.id || 'N/A';

  switch (event) {

    case 'payment.captured': {
      logger.info('Payment captured', { orderId, paymentId, senderPhone });

      // ── TODO: persist to DB ───────────────────────────────────────────────
      // await Order.findOneAndUpdate(
      //   { razorpayOrderId: orderId },
      //   { status: 'paid', razorpayPaymentId: paymentId }
      // );

      if (senderPhone) {
        await sendWhatsAppMessage(senderPhone, REPLIES.PAYMENT_CONFIRMED(orderId));
      } else {
        logger.warn('payment.captured — could not resolve senderPhone', { orderId });
      }
      break;
    }

    case 'payment.failed': {
      const errorDesc =
        payload?.payment?.entity?.error_description || 'Unknown error';

      logger.warn('Payment failed', { orderId, paymentId, errorDesc, senderPhone });

      // ── TODO: persist to DB ───────────────────────────────────────────────
      // await Order.findOneAndUpdate(
      //   { razorpayOrderId: orderId },
      //   { status: 'failed' }
      // );

      if (senderPhone) {
        await sendWhatsAppMessage(senderPhone, REPLIES.PAYMENT_FAILED(orderId));
      }
      break;
    }

    case 'refund.created': {
      const refundId = payload?.refund?.entity?.id || 'N/A';
      logger.info('Refund created', { orderId, refundId, senderPhone });

      if (senderPhone) {
        await sendWhatsAppMessage(senderPhone, REPLIES.PAYMENT_REFUNDED(orderId));
      }
      break;
    }

    default:
      // Razorpay sends many event types (subscription.*, invoice.*, etc.).
      // Always 200 so Razorpay doesn't retry endlessly.
      logger.info('Unhandled Razorpay event — acknowledged without action', { event });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 4: ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── POST /webhook/payment — Razorpay callbacks ────────────────────────────────
//
// express.raw() for this route MUST be registered in server.js before
// express.json() (see verifyRazorpaySignature comment block above).
router.post('/payment', verifyRazorpaySignature, async (req, res) => {

  // Acknowledge immediately — Razorpay retries on any non-2xx response
  res.status(200).json({ status: 'received' });

  try {
    await handlePaymentCallback(req.body);
  } catch (err) {
    logger.error('Unhandled error in payment callback', {
      error: err.message,
      stack: err.stack,
    });
  }
});

// ── POST /webhook — Green API inbound messages ────────────────────────────────
router.post('/', verifyGreenApiToken, async (req, res) => {

  // Acknowledge immediately — Green API expects 200 within 5 s or it retries,
  // causing duplicate message processing
  res.status(200).json({ status: 'received' });

  const body = req.body;

  if (!body || typeof body !== 'object') {
    logger.warn('Malformed webhook payload — not an object');
    return;
  }

  const typeWebhook = body.typeWebhook;

  logger.info('Green API notification received', {
    typeWebhook,
    instanceId: body.instanceData?.idInstance,
  });

  // ── Non-message notification types ───────────────────────────────────────
  if (typeWebhook === 'outgoingMessageStatus') {
    logger.info('Delivery receipt', {
      idMessage: body.idMessage,
      status:    body.status,
    });
    return;
  }

  if (typeWebhook === 'stateInstanceChanged') {
    logger.info('Instance state changed', { state: body.stateInstance });
    return;
  }

  if (typeWebhook === 'deviceInfo') {
    logger.info('Device info ping received');
    return;
  }

  // ── Ignore messages sent by the bot itself to prevent reply loops ─────────
  if (isOutgoingMessage(body)) {
    logger.info('Skipping outgoing message notification');
    return;
  }

  // ── Only continue for inbound messages ───────────────────────────────────
  if (typeWebhook !== 'incomingMessageReceived') {
    logger.info('Ignoring unrecognised typeWebhook', { typeWebhook });
    return;
  }

  const messageData = body.messageData;
  const senderPhone = extractSenderPhone(body);
  const typeMessage = messageData?.typeMessage;

  if (!senderPhone || !typeMessage) {
    logger.error('Missing senderPhone or typeMessage in payload', { body });
    return;
  }

  logger.info('Routing inbound message', { senderPhone, typeMessage });

  try {
    switch (typeMessage) {

      // ── Text ──────────────────────────────────────────────────────────────
      case 'TextMessage':
      case 'ExtendedTextMessage':
        await handleTextMessage(messageData, senderPhone);
        break;

      // ── Voice ─────────────────────────────────────────────────────────────
      case 'AudioMessage':
      case 'PTTMessage':
        await handleAudioMessage(messageData, senderPhone);
        break;

      // ── Image ─────────────────────────────────────────────────────────────
      case 'ImageMessage':
        await handleImageMessage(messageData, senderPhone);
        break;

      // ── Reactions — acknowledged silently, no reply ───────────────────────
      case 'ReactionMessage':
        logger.info('Emoji reaction received — no action taken', { senderPhone });
        break;

      // ── Everything else: sticker, video, document, contact, location, etc. ─
      //    Per your requirement: always send the "not supported" reply
      default:
        logger.info('Unsupported message type — sending not-supported reply', {
          senderPhone,
          typeMessage,
        });
        await sendWhatsAppMessage(senderPhone, REPLIES.UNSUPPORTED_TYPE);
        break;
    }
  } catch (err) {
    logger.error('Unhandled error in message routing', {
      senderPhone,
      typeMessage,
      error: err.message,
      stack: err.stack,
    });
  }
});

// ── GET /webhook/health — uptime / load-balancer probe ───────────────────────
router.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    service:   'webhook',
    uptime:    process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
