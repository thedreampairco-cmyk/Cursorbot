/**
 * ============================================================
 *  services/features/voiceSearchService.js
 *  Voice search pipeline for Maya WhatsApp Bot
 * ============================================================
 *
 *  FLOW:
 *    1. Download OGG audio from Green API CDN (axios, in-memory)
 *    2. Transcribe via Groq Whisper (whisper-large-v3)
 *    3. Pass transcribed text to processTextWithAI() in webhook.js
 *       via the shared helper below
 *
 *  SERVICE PATHS (verified against your actual file tree):
 *    ../whatsapp/greenApiText  → sendText(waId, text)
 *    ../aiResponse             → getAIResponse(text)
 *    ../../models/Client       → conversation history
 *    ../../errorHandler        → logger
 *
 *  ENV VARS:
 *    GROQ_API_KEY  ← already in your .env
 * ============================================================
 */

'use strict';

const axios        = require('axios');
const Groq         = require('groq-sdk');
const { logger }   = require('../../errorHandler');

// ─── Lazy Groq client (avoids crash if .env not loaded yet at require time) ──
let _groq = null;
function getGroqClient() {
  if (!_groq) {
    if (!process.env.GROQ_API_KEY) {
      throw new Error('GROQ_API_KEY is missing from environment variables');
    }
    _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return _groq;
}

// ─── Services (lazy-loaded to avoid circular require issues) ──────────────────
// Both of these are loaded on first use, not at module load time.
function getSendText() {
  return require('../whatsapp/greenApiText').sendText;
}

function getAIResponse() {
  return require('../aiResponse').getAIResponse;
}

function getClientModel() {
  return require('../../models/Client');
}

// ─── Config ──────────────────────────────────────────────────────────────────
const CONFIG = {
  WHISPER_MODEL:            'whisper-large-v3',
  MAX_AUDIO_BYTES:          25 * 1024 * 1024,   // Groq's 25 MB hard limit
  DOWNLOAD_TIMEOUT_MS:      15_000,
  TRANSCRIPTION_TIMEOUT_MS: 30_000,
  MAX_HISTORY_TURNS:        10,
  FALLBACK_MESSAGE:
    "Sorry, I couldn't hear that properly. Could you type it out? 🎙️➡️⌨️",
};

// ═══════════════════════════════════════════════════════════════════════════════
//  STEP 1 — DOWNLOAD AUDIO
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Downloads the OGG audio from Green API's CDN into a Buffer.
 * Never writes to disk — lives entirely in memory.
 *
 * @param {string} audioUrl - downloadUrl from Green API webhook payload
 * @returns {Promise<{ buffer: Buffer, mimeType: string, filename: string }>}
 */
async function downloadAudioBuffer(audioUrl) {
  logger.info('[VoiceSearch] Downloading audio', { url: audioUrl });

  const response = await axios.get(audioUrl, {
    responseType: 'arraybuffer',
    timeout: CONFIG.DOWNLOAD_TIMEOUT_MS,
    // If your Green API media URLs require a token, uncomment:
    // params: { token: process.env.GREEN_API_TOKEN },
  });

  const buffer = Buffer.from(response.data);

  if (buffer.byteLength === 0) throw new Error('Downloaded audio buffer is empty');
  if (buffer.byteLength > CONFIG.MAX_AUDIO_BYTES) {
    throw new Error(`Audio too large: ${buffer.byteLength} bytes (max ${CONFIG.MAX_AUDIO_BYTES})`);
  }

  const { pathname } = new URL(audioUrl);
  const filename = require('path').basename(pathname) || 'voice_message.ogg';
  const mimeType = response.headers['content-type'] || 'audio/ogg';

  logger.info('[VoiceSearch] Audio downloaded', { bytes: buffer.byteLength, filename });
  return { buffer, mimeType, filename };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STEP 2 — TRANSCRIBE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sends the audio buffer to Groq Whisper for transcription.
 * Uses Web API File object — no temp files, requires Node >= 18 (your package.json enforces this).
 *
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {string} mimeType
 * @returns {Promise<string>} - transcribed text
 */
async function transcribeAudio(buffer, filename, mimeType) {
  logger.info('[VoiceSearch] Sending to Groq Whisper', {
    model: CONFIG.WHISPER_MODEL,
    filename,
  });

  const audioFile = new File([buffer], filename, { type: mimeType });

  const transcription = await Promise.race([
    getGroqClient().audio.transcriptions.create({
      file:            audioFile,
      model:           CONFIG.WHISPER_MODEL,
      response_format: 'json',
      language:        'en',  // change or remove for auto-detect
      temperature:     0,
    }),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('Groq transcription timed out')),
        CONFIG.TRANSCRIPTION_TIMEOUT_MS
      )
    ),
  ]);

  const text = transcription?.text?.trim();
  if (!text) throw new Error('Groq returned an empty transcription');

  logger.info('[VoiceSearch] Transcription successful', { text });
  return text;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STEP 3 — PROCESS TRANSCRIBED TEXT WITH AI + SEND REPLY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Processes the transcribed text through Maya's AI, maintaining conversation
 * history in the Client model just like a typed message would.
 *
 * @param {string} text        - transcribed voice text
 * @param {string} senderPhone - Green API waId
 */
async function processVoiceText(text, senderPhone) {
  const sendText    = getSendText();
  const getAI       = getAIResponse();
  const Client      = getClientModel();

  // Load or create conversation
  let client = await Client.findOne({ waId: senderPhone });
  if (!client) client = new Client({ waId: senderPhone });

  client.addMessage('user', `[Voice] ${text}`);
  client.lastMessageAt = new Date();

  // Build context-aware prompt
  const recentMessages = client.messages.slice(-(CONFIG.MAX_HISTORY_TURNS * 2));
  const hasHistory     = recentMessages.length > 1;

  let prompt = text;
  if (hasHistory) {
    const historyText = recentMessages
      .slice(0, -1)
      .map((m) => `${m.role === 'user' ? 'Customer' : 'Maya'}: ${m.content}`)
      .join('\n');
    prompt = `Previous conversation:\n${historyText}\n\nCustomer (via voice): ${text}`;
  }

  const aiReply = await getAI(prompt);

  client.addMessage('assistant', aiReply);
  await client.save();

  await sendText(senderPhone, aiReply);

  logger.info('[VoiceSearch] Reply sent', {
    senderPhone,
    replyPreview: aiReply.slice(0, 80),
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * handleIncomingAudio
 * ────────────────────
 * Entry point called by routes/webhook.js for AudioMessage / PTTMessage.
 * Orchestrates: download → transcribe → AI → send reply
 * On any failure: sends the fallback message to the user.
 *
 * @param {string} audioUrl    - downloadUrl from Green API webhook payload
 * @param {string} senderPhone - Green API waId e.g. "919876543210@c.us"
 */
async function handleIncomingAudio(audioUrl, senderPhone) {
  logger.info('[VoiceSearch] Pipeline started', { senderPhone });

  try {
    const { buffer, mimeType, filename } = await downloadAudioBuffer(audioUrl);
    const transcribedText                = await transcribeAudio(buffer, filename, mimeType);

    logger.info('[VoiceSearch] Passing to AI', { senderPhone, transcribedText });
    await processVoiceText(transcribedText, senderPhone);

  } catch (err) {
    logger.error('[VoiceSearch] Pipeline failed — sending fallback', {
      senderPhone,
      error: err.message,
      stack: err.stack,
    });

    try {
      const sendText = getSendText();
      await sendText(senderPhone, CONFIG.FALLBACK_MESSAGE);
    } catch (sendErr) {
      logger.error('[VoiceSearch] Fallback send also failed', {
        senderPhone,
        error: sendErr.message,
      });
    }
  }
}

module.exports = { handleIncomingAudio };
