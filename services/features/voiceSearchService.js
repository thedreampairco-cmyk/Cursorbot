/**
 * ============================================================
 *  voiceSearchService.js
 *  Drop into: services/features/voiceSearchService.js
 * ============================================================
 *
 *  DEPENDENCIES (all already in your package.json):
 *    - axios       → download audio from Green API
 *    - groq-sdk    → Whisper transcription
 *    - winston     → structured logging (uses your existing logger)
 *
 *  ENV VARS REQUIRED (add to your .env file):
 *    GROQ_API_KEY=<your_groq_cloud_api_key>          ← INSERT HERE
 *    GREEN_API_MEDIA_TOKEN=<your_green_api_token>    ← INSERT HERE (if your
 *                                                        media URLs are token-gated)
 *
 *  USAGE:
 *    import { handleIncomingAudio } from './voiceSearchService.js';
 *
 *    // Inside your Green API webhook handler, when messageType === 'audioMessage':
 *    const audioUrl = body.messageData.fileMessageData.downloadUrl;
 *    await handleIncomingAudio(audioUrl, userPhone);
 * ============================================================
 */

'use strict';

const axios       = require('axios');
const Groq        = require('groq-sdk');
const { Readable } = require('stream');
const path        = require('path');
const winston     = require('winston');

// ─── Logger ──────────────────────────────────────────────────────────────────
// Reuse your project's existing logger if you export one; otherwise this
// creates a lightweight local instance.
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, ...meta }) =>
      `${timestamp} [VoiceSearch] ${level.toUpperCase()}: ${message} ${
        Object.keys(meta).length ? JSON.stringify(meta) : ''
      }`
    )
  ),
  transports: [new winston.transports.Console()],
});

// ─── Groq Client ─────────────────────────────────────────────────────────────
// Groq SDK automatically picks up process.env.GROQ_API_KEY.
// If you manage keys differently, replace with: new Groq({ apiKey: 'sk-...' })
// ✅ FIXED — only initialises when actually needed, dotenv is always ready by then
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
// ─── Config ──────────────────────────────────────────────────────────────────
const CONFIG = {
  /** Whisper model served by Groq */
  WHISPER_MODEL: 'whisper-large-v3',

  /** Max audio size accepted (25 MB – Groq's hard limit) */
  MAX_AUDIO_BYTES: 25 * 1024 * 1024,

  /** Axios download timeout in ms */
  DOWNLOAD_TIMEOUT_MS: 15_000,

  /** Groq transcription timeout in ms */
  TRANSCRIPTION_TIMEOUT_MS: 30_000,

  /** Fallback message sent back to the user on any failure */
  FALLBACK_MESSAGE:
    "Sorry, I couldn't hear that properly. Can you type it out? 🎙️➡️⌨️",
};

// ─── Lazy-import your WhatsApp sender & message processor ────────────────────
// Adjust these paths to match your actual project layout.
//
//   sendWhatsAppMessage(phone, text)  → sends a text reply via Green API
//   processMessage(text, phone)       → your existing NLP / intent handler
//
let sendWhatsAppMessage, processMessage;

try {
  // ← UPDATE these require paths if your files live elsewhere
const { getAIResponse }       = require('../aiResponse');          // one level up from services/features/
const { sendWhatsAppMessage }  = require('../whatsappService');     // same level as aiResponse

// Local processMessage wrapper
async function processMessage(text, phone) {
  const reply = await getAIResponse(text);
  await sendWhatsAppMessage(phone, reply);
}
} catch (err) {
  // During unit testing these modules may not exist yet – that's fine.
  logger.warn('Could not load peer modules at init time; ensure paths are correct.', {
    error: err.message,
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Downloads the audio file from Green API's CDN.
 *
 * Green API media URLs are pre-signed and expire after a short window,
 * so we download immediately on receipt.
 *
 * @param {string} audioUrl  - The downloadUrl from Green API's webhook payload
 * @returns {Promise<{ buffer: Buffer, mimeType: string, filename: string }>}
 */
async function downloadAudioBuffer(audioUrl) {
  logger.info('Downloading audio from Green API', { url: audioUrl });

  const response = await axios.get(audioUrl, {
    responseType: 'arraybuffer',
    timeout: CONFIG.DOWNLOAD_TIMEOUT_MS,

    // ── If your Green API media URLs require authentication, add the token
    //    as a query param or Authorization header here:
    //
    // params: { token: process.env.GREEN_API_MEDIA_TOKEN },   // ← INSERT HERE
    //
    // headers: {
    //   Authorization: `Bearer ${process.env.GREEN_API_MEDIA_TOKEN}`,
    // },
  });

  const buffer = Buffer.from(response.data);

  if (buffer.byteLength === 0) {
    throw new Error('Downloaded audio buffer is empty.');
  }

  if (buffer.byteLength > CONFIG.MAX_AUDIO_BYTES) {
    throw new Error(
      `Audio file too large: ${buffer.byteLength} bytes (max ${CONFIG.MAX_AUDIO_BYTES}).`
    );
  }

  // Derive a filename; Groq needs one to detect the codec.
  // Green API usually serves .ogg; fall back gracefully.
  const urlPath  = new URL(audioUrl).pathname;
  const filename = path.basename(urlPath) || 'voice_message.ogg';
  const mimeType = response.headers['content-type'] || 'audio/ogg';

  logger.info('Audio downloaded successfully', {
    bytes: buffer.byteLength,
    filename,
    mimeType,
  });

  return { buffer, mimeType, filename };
}

/**
 * Sends the audio buffer to Groq Whisper for transcription.
 *
 * Groq's Node SDK expects a File-like object. We build one from the raw
 * Buffer so that no temporary file ever touches disk.
 *
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {string} mimeType
 * @returns {Promise<string>} - The transcribed text
 */
async function transcribeAudio(buffer, filename, mimeType) {
  logger.info('Sending audio to Groq Whisper', {
    model: CONFIG.WHISPER_MODEL,
    filename,
  });

  // Convert Buffer → Web API File (supported in Node ≥ 18, which your
  // package.json already enforces via "engines": { "node": ">=18.0.0" })
  const audioFile = new File([buffer], filename, { type: mimeType });

  const transcription = await Promise.race([
    groq.audio.transcriptions.create({
      file:            audioFile,
      model:           CONFIG.WHISPER_MODEL,
      response_format: 'json',      // returns { text: "..." }
      language:        'en',        // ← change or remove for auto-detect
      temperature:     0,           // deterministic output
    }),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('Groq transcription timed out')),
        CONFIG.TRANSCRIPTION_TIMEOUT_MS
      )
    ),
  ]);

  const text = transcription?.text?.trim();

  if (!text) {
    throw new Error('Groq returned an empty transcription.');
  }

  logger.info('Transcription successful', { text });
  return text;
}

// ─── Main Export ─────────────────────────────────────────────────────────────

/**
 * handleIncomingAudio
 * ───────────────────
 * Orchestrates the full voice-to-intent pipeline:
 *   1. Download OGG audio from Green API CDN
 *   2. Transcribe via Groq Whisper
 *   3. Pipe the transcribed text into processMessage()
 *
 * On any failure the user receives the friendly fallback message.
 *
 * @param {string} audioUrl   - downloadUrl from Green API webhook payload
 * @param {string} userPhone  - E.164 phone number, e.g. "919876543210"
 * @returns {Promise<void>}
 */
async function handleIncomingAudio(audioUrl, userPhone) {
  logger.info('handleIncomingAudio invoked', { userPhone });

  try {
    // ── Step 1: Download ──────────────────────────────────────────────────
    const { buffer, mimeType, filename } = await downloadAudioBuffer(audioUrl);

    // ── Step 2: Transcribe ────────────────────────────────────────────────
    const transcribedText = await transcribeAudio(buffer, filename, mimeType);

    // ── Step 3: Process (hand off to your existing pipeline) ─────────────
    logger.info('Routing transcription to processMessage', {
      userPhone,
      transcribedText,
    });

    await processMessage(transcribedText, userPhone);

  } catch (err) {
    // ── Graceful fallback ─────────────────────────────────────────────────
    logger.error('Voice search pipeline failed – sending fallback', {
      userPhone,
      error:  err.message,
      stack:  err.stack,
    });

    try {
      await sendWhatsAppMessage(userPhone, CONFIG.FALLBACK_MESSAGE);
    } catch (sendErr) {
      // If even the fallback send fails, log and swallow so we don't crash
      // the webhook handler.
      logger.error('Failed to send fallback message', {
        userPhone,
        error: sendErr.message,
      });
    }
  }
}

module.exports = { handleIncomingAudio };
