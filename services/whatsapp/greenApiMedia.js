// services/whatsapp/greenApiMedia.js
"use strict";

const axios               = require("axios");
const { logger }          = require("../../errorHandler");
const { chatId, apiUrl }  = require("./greenApiText");

const TOKEN = process.env.GREEN_API_TOKEN;

/**
 * Internal helper — send any file by URL.
 * @param {string} phone
 * @param {string} urlFile
 * @param {string} fileName
 * @param {string} caption
 * @returns {Promise<object>}
 */
async function _sendFileByUrl(phone, urlFile, fileName, caption = "") {
  const { data } = await axios.post(
    apiUrl("sendFileByUrl"),
    { chatId: chatId(phone), urlFile, fileName, caption },
    { timeout: 15000 }
  );
  logger.info(`[GreenAPI:Media] File sent to ${phone} | file=${fileName} | idMessage=${data.idMessage}`);
  return data;
}

/**
 * Send an image by public URL.
 * @param {string} phone
 * @param {string} imageUrl
 * @param {string} [caption]
 * @returns {Promise<object>}
 */
async function sendImageByUrl(phone, imageUrl, caption = "") {
  try {
    return await _sendFileByUrl(phone, imageUrl, "image.jpg", caption);
  } catch (err) {
    logger.error(`[GreenAPI:Media] sendImageByUrl failed for ${phone}: ${err.message}`);
    throw err;
  }
}

/**
 * Send a video by public URL.
 * @param {string} phone
 * @param {string} videoUrl
 * @param {string} [caption]
 * @returns {Promise<object>}
 */
async function sendVideoByUrl(phone, videoUrl, caption = "") {
  try {
    return await _sendFileByUrl(phone, videoUrl, "video.mp4", caption);
  } catch (err) {
    logger.error(`[GreenAPI:Media] sendVideoByUrl failed for ${phone}: ${err.message}`);
    throw err;
  }
}

/**
 * Send a document/PDF by public URL.
 * @param {string} phone
 * @param {string} docUrl
 * @param {string} [fileName]
 * @param {string} [caption]
 * @returns {Promise<object>}
 */
async function sendDocumentByUrl(phone, docUrl, fileName = "document.pdf", caption = "") {
  try {
    return await _sendFileByUrl(phone, docUrl, fileName, caption);
  } catch (err) {
    logger.error(`[GreenAPI:Media] sendDocumentByUrl failed for ${phone}: ${err.message}`);
    throw err;
  }
}

/**
 * Send an audio file by public URL.
 * @param {string} phone
 * @param {string} audioUrl
 * @returns {Promise<object>}
 */
async function sendAudioByUrl(phone, audioUrl) {
  try {
    return await _sendFileByUrl(phone, audioUrl, "audio.ogg", "");
  } catch (err) {
    logger.error(`[GreenAPI:Media] sendAudioByUrl failed for ${phone}: ${err.message}`);
    throw err;
  }
}

/**
 * Fetch an incoming media file from Green API's media storage.
 * Primarily used by the vision service to download customer-sent images.
 * @param {string} mediaUrl - URL from incoming webhook body (downloadUrl field)
 * @returns {Promise<Buffer>}
 */
async function fetchIncomingMedia(mediaUrl) {
  try {
    const { data } = await axios.get(mediaUrl, {
      responseType: "arraybuffer",
      headers: { Authorization: `Bearer ${TOKEN}` },
      timeout: 20000,
    });
    const buf = Buffer.from(data);
    logger.info(`[GreenAPI:Media] Fetched incoming media | bytes=${buf.byteLength}`);
    return buf;
  } catch (err) {
    logger.error(`[GreenAPI:Media] fetchIncomingMedia failed: ${err.message}`);
    throw err;
  }
}

/**
 * Request a download URL for an incoming message's media from Green API.
 * @param {string} chatIdStr  - e.g. "919876543210@c.us"
 * @param {string} idMessage  - message ID from webhook
 * @returns {Promise<{ downloadUrl: string, mimeType: string, fileName: string }>}
 */
async function getMediaDownloadUrl(chatIdStr, idMessage) {
  try {
    const { data } = await axios.post(
      apiUrl("downloadFile"),
      { chatId: chatIdStr, idMessage },
      { timeout: 15000 }
    );
    logger.info(`[GreenAPI:Media] Download URL resolved for message ${idMessage}`);
    return data;
  } catch (err) {
    logger.error(`[GreenAPI:Media] getMediaDownloadUrl failed: ${err.message}`);
    throw err;
  }
}

module.exports = {
  sendImageByUrl,
  sendVideoByUrl,
  sendDocumentByUrl,
  sendAudioByUrl,
  fetchIncomingMedia,
  getMediaDownloadUrl,
};
