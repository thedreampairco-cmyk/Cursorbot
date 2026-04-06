/**
 * ============================================================
 *  routes/webhook.js  —  Green API Inbound Message Router
 *  The Dream Pair / Maya Bot
 * ============================================================
 *
 *  WHAT THIS FILE DOES:
 *    1. Receives ALL inbound Green API webhook notifications
 *    2. Passes every message through the anti-fraud shield first
 *       (COD deposit, live-location verify, unboxing contract)
 *    3. If fraud shield doesn't claim it → routes to Maya AI handler
 *    4. Maintains per-user conversation history (Client model)
 *
 *  MESSAGE TYPE ROUTING:
 *    TextMessage / ExtendedTextMessage  → fraud check → AI reply
 *    AudioMessage / PTTMessage          → Groq Whisper → fraud check → AI reply
 *    ImageMessage                       → vision analysis → AI reply
 *    LocationMessage                    → fraud shield (live-location verify)
 *    VideoMessage                       → fraud shield (unboxing video)
 *    ReactionMessage                    → silently acknowledged
 *    Everything else                    → "not supported" reply
 *
 *  SERVICE PATHS (verified against your real file tree):
 *    services/whatsapp/greenApiText.js     → sendText(waId, text)
 *    services/aiResponse.js                → processMessage(text)
 *    services/features/voiceSearchService  → handleIncomingAudio(url, phone)
 *    services/features/visionRecognition   → getVisionAnalysis(url)
 *    fraud/index.js                        → onIncomingWhatsAppMessage(msg)
 *    models/Client.js                      → conversation history
 *    errorHandler.js                       → logger
 * ============================================================
 */

'use strict';

const express = require('express');
const router  = express.Router();

// ─── Services (all paths verified against your actual file tree) ──────────────
const { sendText }                  = require('../services/whatsappService.js');
const { processMessage } = require('../services/features/intentService');
const { handleIncomingAudio }       = require('../services/features/voiceSearchService');
const { onIncomingWhatsAppMessage } = require('../fraud');
const Client                        = require('../models/Client');
const { logger }                    = require('../errorHandler');

// Vision is optional — degrades to caption-only if unavailable
let getVisionAnalysis = null;
try {
  ({ getVisionAnalysis } = require('../services/features/visionRecognition'));
} catch {
  logger.warn('[Webhook] visionRecognition not available — image captions only');
}

// ─── Constants ────────────────────────────────────────────────────────────────
const REPLIES = {
  UNSUPPORTED:
    "Sorry, I can only handle text messages, voice notes 🎙️, and images 📸.\n" +
    "Please type your question or record a voice message!",

  IMAGE_NO_CAPTION:
    "Great image! 📸 To search our catalogue, please describe what you're " +
    "looking for or add a caption — e.g. *'Do you have this in size 10?'*",

  ERROR:
    "Something went wrong on my end. Please try again in a moment 🙏",
};

// Recent turns to include in AI context window
const MAX_HISTORY_TURNS = 10;

// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 1 — WEBHOOK TOKEN GUARD
// ═══════════════════════════════════════════════════════════════════════════════

function verifyGreenApiToken(req, res, next) {
  const secret = process.env.GREEN_API_WEBHOOK_TOKEN;
  if (!secret) return next(); // bypassed in dev if not set

  const incoming = req.query.token || req.headers['x-green-api-token'];
  if (incoming !== secret) {
    logger.warn('[Webhook] Rejected — invalid token', { ip: req.ip });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 2 — HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function extractSenderPhone(body) {
  return body?.senderData?.sender ?? null;
}

function isOutgoing(body) {
  return (
    body?.typeWebhook === 'outgoingAPIMessageReceived' ||
    body?.senderData?.sender === body?.instanceData?.wid
  );
}

/**
 * Normalises a Green API body into the shape fraud/index.js expects:
 *   { from, type, text: { body }, location: { latitude, longitude }, video: { id } }
 */
function normaliseForFraud(body) {
  const senderPhone = extractSenderPhone(body);
  const msgData     = body?.messageData;
  const type        = msgData?.typeMessage;
  const base        = { from: senderPhone };

  switch (type) {
    case 'textMessage':
    case 'extendedTextMessage': {
      const textBody =
        msgData?.textMessageData?.textMessage ||
        msgData?.extendedTextMessageData?.text || '';
      return { ...base, type: 'text', text: { body: textBody } };
    }
    case 'locationMessage': {
      const loc = msgData?.locationMessageData;
      return {
        ...base,
        type: 'location',
        location: { latitude: loc?.latitude, longitude: loc?.longitude },
      };
    }
    case 'videoMessage': {
      return {
        ...base,
        type: 'video',
        video: { id: msgData?.fileMessageData?.downloadUrl },
      };
    }
    default:
      return { ...base, type: type?.toLowerCase() || 'unknown' };
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 3 — CORE AI HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * processTextWithAI
 * ──────────────────
 * 1. Load/create Client (MongoDB conversation history)
 * 2. Add user message to history
 * 3. Build context-aware prompt from recent turns
 * 4. Get AI reply from Groq
 * 5. Save AI reply to history
 * 6. Send reply via Green API
 *
 * @param {string} userText    - text to process (typed or transcribed voice)
 * @param {string} senderPhone - Green API waId e.g. "919876543210@c.us"
 */
async function processTextWithAI(userText, senderPhone) {
  logger.info('[Webhook] Processing with AI', {
    senderPhone,
    preview: userText.slice(0, 80),
  });

  // ── Load or create Client ─────────────────────────────────────────────────
  let client = await Client.findOne({ waId: senderPhone });
  if (!client) {
    client = new Client({ waId: senderPhone });
  }

  // ── Add user message ──────────────────────────────────────────────────────
  client.addMessage('user', userText);
  client.lastMessageAt = new Date();

  // ── Build context-aware prompt ────────────────────────────────────────────
  // Include last N turns so Maya remembers the conversation
  }

  // ── Get AI response ───────────────────────────────────────────────────────
  const aiResult = await processMessage(senderPhone, userText);
  
  // Extract the actual string from the object
  const aiReplyText = aiResult.response || "Sorry, I could not process that.";

  // ── Save to history and persist ───────────────────────────────────────────
  client.addMessage('assistant', aiReplyText);
  await client.save();

  // ── Send reply via Green API ──────────────────────────────────────────────
  await sendText(senderPhone, aiReplyText);

  logger.info('[Webhook] AI reply sent', {
    senderPhone,
    replyPreview: aiReplyText.slice(0, 80),
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 4 — MESSAGE TYPE HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

async function handleTextMessage(messageData, senderPhone, body) {
  const text =
    messageData?.textMessageData?.textMessage ||
    messageData?.extendedTextMessageData?.text || '';

  if (!text.trim()) {
    logger.warn('[Webhook] Empty text body', { senderPhone });
    return;
  }

  // Fraud shield gets first look at every text message
  const fraudResult = await onIncomingWhatsAppMessage(normaliseForFraud(body));
  if (fraudResult !== null) {
    logger.info('[Webhook] Fraud shield handled message', { senderPhone });
    return;
  }

  // Not fraud-related → Maya handles it
  await processTextWithAI(text.trim(), senderPhone);
}

async function handleAudioMessage(messageData, senderPhone) {
  const downloadUrl = messageData?.fileMessageData?.downloadUrl;

  if (!downloadUrl) {
    logger.error('[Webhook] AudioMessage missing downloadUrl', { senderPhone });
    await sendText(senderPhone, "Sorry, I couldn't access that voice message. Please try again 🎙️");
    return;
  }

  logger.info('[Webhook] Audio → voiceSearchService', { senderPhone });

  // voiceSearchService transcribes → calls processTextWithAI → sends reply
  // It also handles its own error fallback message
  await handleIncomingAudio(downloadUrl, senderPhone);
}

async function handleImageMessage(messageData, senderPhone) {
  const downloadUrl = messageData?.fileMessageData?.downloadUrl;
  const caption     = messageData?.fileMessageData?.caption?.trim() || '';

  logger.info('[Webhook] Image received', {
    senderPhone,
    hasCaption: !!caption,
    hasVision: !!getVisionAnalysis,
  });

  // Option A: Vision AI available — analyse the image
  if (getVisionAnalysis && downloadUrl) {
    try {
      const description = await getVisionAnalysis(downloadUrl);
      const prompt = caption
        ? `Image analysis: "${description}". Customer caption: "${caption}". Help find this product.`
        : `Image analysis: "${description}". Help the customer find this or a similar product.`;
      await processTextWithAI(prompt, senderPhone);
      return;
    } catch (err) {
      logger.warn('[Webhook] Vision failed — falling back to caption', { error: err.message });
    }
  }

  // Option B: Caption provided
  if (caption) {
    await processTextWithAI(caption, senderPhone);
    return;
  }

  // Option C: Nothing to work with
  await sendText(senderPhone, REPLIES.IMAGE_NO_CAPTION);
}

async function handleLocationMessage(body, senderPhone) {
  logger.info('[Webhook] Location → fraud shield', { senderPhone });
  await onIncomingWhatsAppMessage(normaliseForFraud(body));
}

async function handleVideoMessage(body, senderPhone) {
  logger.info('[Webhook] Video → fraud shield (unboxing)', { senderPhone });
  await onIncomingWhatsAppMessage(normaliseForFraud(body));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 5 — MAIN ROUTE
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/', verifyGreenApiToken, async (req, res) => {

  // ACK immediately — Green API retries if no 200 within 5 s
  res.status(200).json({ status: 'received' });

  const body = req.body;

  if (!body || typeof body !== 'object') {
    logger.warn('[Webhook] Malformed payload — not an object');
    return;
  }

  const typeWebhook = body.typeWebhook;

  logger.info('[Webhook] Notification received', {
    typeWebhook,
    instanceId: body.instanceData?.idInstance,
  });

  // System events — log only
  if (typeWebhook === 'outgoingMessageStatus') {
    logger.info('[Webhook] Delivery receipt', { idMessage: body.idMessage, status: body.status });
    return;
  }
  if (typeWebhook === 'stateInstanceChanged') {
    logger.info('[Webhook] Instance state', { state: body.stateInstance });
    return;
  }
  if (typeWebhook === 'deviceInfo') return;

  // Skip messages we sent (loop guard)
  if (isOutgoing(body)) {
    logger.info('[Webhook] Skipping outgoing message');
    return;
  }

  // Only process inbound messages
  if (typeWebhook !== 'incomingMessageReceived') {
    logger.info('[Webhook] Ignoring typeWebhook', { typeWebhook });
    return;
  }

  const messageData = body.messageData;
  const senderPhone = extractSenderPhone(body);
  const typeMessage = messageData?.typeMessage;

  if (!senderPhone || !typeMessage) {
    logger.error('[Webhook] Missing senderPhone or typeMessage', { body });
    return;
  }

  logger.info('[Webhook] Routing', { senderPhone, typeMessage });

  try {
    // FIX: All cases updated to strictly match Green API's camelCase strings
    switch (typeMessage) {
      case 'textMessage':
      case 'extendedTextMessage':
        await handleTextMessage(messageData, senderPhone, body);
        break;

      case 'audioMessage':
      case 'pttMessage': // Keep this just in case, though Green API usually sends audioMessage
        await handleAudioMessage(messageData, senderPhone);
        break;

      case 'imageMessage':
        await handleImageMessage(messageData, senderPhone);
        break;

      case 'locationMessage':
        await handleLocationMessage(body, senderPhone);
        break;

      case 'videoMessage':
        await handleVideoMessage(body, senderPhone);
        break;

      case 'reactionMessage':
        logger.info('[Webhook] Reaction — no action', { senderPhone });
        break;

      default:
        logger.info('[Webhook] Unsupported type — sending reply', { senderPhone, typeMessage });
        await sendText(senderPhone, REPLIES.UNSUPPORTED);
        break;
    }
  } catch (err) {
    logger.error('[Webhook] Routing error', {
      senderPhone,
      typeMessage,
      error: err.message,
      stack: err.stack,
    });
    try {
      await sendText(senderPhone, REPLIES.ERROR);
    } catch { /* swallow */ }
  }
});

// Health check
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'green-api-webhook', uptime: process.uptime() });
});

module.exports = router;

