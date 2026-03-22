'use strict';

const { greenApiClient } = require('../../config/api');
const env = require('../../config/env');
const { logger } = require('../../errorHandler');

const TOKEN = env.greenApi.token;

/**
 * Send a plain text WhatsApp message.
 * @param {string} chatId  - e.g. "919876543210@c.us"
 * @param {string} message - text body
 */
async function sendText(chatId, message) {
  if (!message || !chatId) return null;
  try {
    const res = await greenApiClient.post(`/sendMessage/${TOKEN}`, {
      chatId,
      message: String(message).trim(),
    });
    logger.debug('[GreenAPI] Text sent', { chatId, idMessage: res.data?.idMessage });
    return res.data;
  } catch (err) {
    logger.error('[GreenAPI] sendText failed', { chatId, error: err.message });
    return null;
  }
}

/**
 * Send a text message with a clickable button list (Green API ListMessage).
 * Falls back to plain text if buttons not supported.
 */
async function sendListMessage(chatId, title, body, buttonLabel, sections) {
  try {
    const res = await greenApiClient.post(`/sendListMessage/${TOKEN}`, {
      chatId,
      message: body,
      title,
      footer: 'The Dream Pair',
      buttonText: buttonLabel,
      sections,
    });
    logger.debug('[GreenAPI] List message sent', { chatId });
    return res.data;
  } catch {
    // Fallback: send as plain text
    const text = `${title}\n\n${body}`;
    return sendText(chatId, text);
  }
}

/**
 * Send a template / quick-reply button message.
 */
async function sendButtons(chatId, contentText, buttons = []) {
  try {
    const res = await greenApiClient.post(`/sendButtons/${TOKEN}`, {
      chatId,
      message: contentText,
      buttons: buttons.map((b, i) => ({ buttonId: String(i + 1), buttonText: b })),
      footer: 'The Dream Pair',
    });
    logger.debug('[GreenAPI] Buttons sent', { chatId });
    return res.data;
  } catch {
    return sendText(chatId, contentText + '\n\n' + buttons.join(' | '));
  }
}

module.exports = { sendText, sendListMessage, sendButtons };
