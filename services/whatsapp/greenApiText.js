// services/whatsapp/greenApiText.js
"use strict";

const axios = require("axios");
const { logger } = require("../../errorHandler");

const INSTANCE_ID = process.env.GREEN_API_INSTANCE_ID;
const TOKEN       = process.env.GREEN_API_TOKEN;

if (!INSTANCE_ID || !TOKEN) {
  console.error("⚠️  WARNING: Green API credentials missing. WhatsApp messaging will fail."); return;
}

const BASE = `https://api.green-api.com/waInstance${INSTANCE_ID}`;

/**
 * Normalize a phone number to Green API's chatId format.
 * e.g. "+91 98765 43210" → "919876543210@c.us"
 * @param {string} phone
 * @returns {string}
 */
function chatId(phone) {
  const cleaned = phone.replace(/\D/g, "");
  return `${cleaned}@c.us`;
}

/**
 * Build a Green API method URL.
 * @param {string} method
 * @returns {string}
 */
function apiUrl(method) {
  return `${BASE}/${method}/${TOKEN}`;
}

/**
 * Send a plain text message.
 * @param {string} phone
 * @param {string} text
 * @returns {Promise<{ idMessage: string }>}
 */
async function sendTextMessage(phone, text) {
  try {
    const { data } = await axios.post(
      apiUrl("sendMessage"),
      { chatId: chatId(phone), message: text },
      { timeout: 10000 }
    );
    logger.info(`[GreenAPI:Text] Sent to ${phone} | idMessage=${data.idMessage}`);
    return data;
  } catch (err) {
    logger.error(`[GreenAPI:Text] sendTextMessage failed for ${phone}: ${err.message}`);
    throw err;
  }
}

/**
 * Send a button message (up to 3 quick-reply buttons).
 * @param {string} phone
 * @param {string} text
 * @param {Array<{ buttonId?: string, buttonText: string }>} buttons
 * @returns {Promise<object>}
 */
async function sendButtonMessage(phone, text, buttons) {
  try {
    const payload = {
      chatId: chatId(phone),
      message: text,
      buttons: buttons.slice(0, 3).map((b, i) => ({
        buttonId:   b.buttonId   || String(i + 1),
        buttonText: b.buttonText || b.text || `Option ${i + 1}`,
      })),
    };
    const { data } = await axios.post(apiUrl("sendButtons"), payload, { timeout: 10000 });
    logger.info(`[GreenAPI:Text] Button message sent to ${phone}`);
    return data;
  } catch (err) {
    logger.error(`[GreenAPI:Text] sendButtonMessage failed for ${phone}: ${err.message}`);
    throw err;
  }
}

/**
 * Send a list-picker message with one or more sections.
 * @param {string} phone
 * @param {string} text    - body message
 * @param {string} title   - list button label
 * @param {Array<{
 *   title: string,
 *   rows: Array<{ rowId: string, title: string, description?: string }>
 * }>} sections
 * @returns {Promise<object>}
 */
async function sendListMessage(phone, text, title, sections) {
  try {
    const { data } = await axios.post(
      apiUrl("sendListMessage"),
      { chatId: chatId(phone), message: text, title, sections },
      { timeout: 10000 }
    );
    logger.info(`[GreenAPI:Text] List message sent to ${phone}`);
    return data;
  } catch (err) {
    logger.error(`[GreenAPI:Text] sendListMessage failed for ${phone}: ${err.message}`);
    throw err;
  }
}

/**
 * Send a template button message with URL / call / quick-reply buttons.
 * @param {string} phone
 * @param {string} text
 * @param {string} footer
 * @param {Array<{ index: number, urlButton?: object, callButton?: object, quickReplyButton?: object }>} templateButtons
 * @returns {Promise<object>}
 */
async function sendTemplateMessage(phone, text, footer, templateButtons) {
  try {
    const { data } = await axios.post(
      apiUrl("sendTemplateButtons"),
      { chatId: chatId(phone), message: text, footer, templateButtons },
      { timeout: 10000 }
    );
    logger.info(`[GreenAPI:Text] Template message sent to ${phone}`);
    return data;
  } catch (err) {
    logger.error(`[GreenAPI:Text] sendTemplateMessage failed for ${phone}: ${err.message}`);
    throw err;
  }
}

/**
 * Send a contact card to a customer.
 * @param {string} phone
 * @param {string} contactName
 * @param {string} contactPhone
 * @returns {Promise<object>}
 */
async function sendContactCard(phone, contactName, contactPhone) {
  try {
    const { data } = await axios.post(
      apiUrl("sendContact"),
      {
        chatId: chatId(phone),
        contact: {
          phoneContact: contactPhone.replace(/\D/g, ""),
          firstName:    contactName,
        },
      },
      { timeout: 10000 }
    );
    logger.info(`[GreenAPI:Text] Contact card sent to ${phone}`);
    return data;
  } catch (err) {
    logger.error(`[GreenAPI:Text] sendContactCard failed for ${phone}: ${err.message}`);
    throw err;
  }
}

/**
 * Send a static location pin.
 * @param {string} phone
 * @param {number} lat
 * @param {number} lng
 * @param {string} name
 * @param {string} address
 * @returns {Promise<object>}
 */
async function sendLocationMessage(phone, lat, lng, name, address) {
  try {
    const { data } = await axios.post(
      apiUrl("sendLocation"),
      { chatId: chatId(phone), latitude: lat, longitude: lng, nameLocation: name, address },
      { timeout: 10000 }
    );
    logger.info(`[GreenAPI:Text] Location sent to ${phone}`);
    return data;
  } catch (err) {
    logger.error(`[GreenAPI:Text] sendLocationMessage failed for ${phone}: ${err.message}`);
    throw err;
  }
}

module.exports = {
  chatId,
  apiUrl,
  sendTextMessage,
  sendButtonMessage,
  sendListMessage,
  sendTemplateMessage,
  sendContactCard,
  sendLocationMessage,
};
