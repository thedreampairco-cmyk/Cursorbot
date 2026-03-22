'use strict';

const { greenApiClient } = require('../../config/api');
const env = require('../../config/env');
const { logger } = require('../../errorHandler');
const { extractImageUrl, isValidUrl } = require('../../urlHelper');

const TOKEN = env.greenApi.token;

/**
 * Send a single product image to the customer.
 * imageUrl MUST come from the Google Sheets catalog – never constructed from filename.
 *
 * @param {string} chatId      - WhatsApp chat id
 * @param {object} product     - product object from memoryStore
 * @param {string} caption     - optional caption
 */
async function sendProductImage(chatId, product, caption = '') {
  const url = extractImageUrl(product);

  if (!url) {
    logger.warn('[GreenAPI] No valid image URL for product – skipping', { productId: product?.id });
    return null;
  }

  if (!isValidUrl(url)) {
    logger.warn('[GreenAPI] Invalid image URL – skipping', { url });
    return null;
  }

  try {
    const res = await greenApiClient.post(`/sendFileByUrl/${TOKEN}`, {
      chatId,
      urlFile: url,
      fileName: `${product.name || 'product'}.jpg`,
      caption: caption || `${product.name} – ₹${product.price}`,
    });
    logger.debug('[GreenAPI] Product image sent', { chatId, productId: product.id });
    return res.data;
  } catch (err) {
    logger.error('[GreenAPI] sendProductImage failed', { chatId, url, error: err.message });
    return null;
  }
}

/**
 * Send up to `maxImages` product images sequentially.
 * All image URLs come exclusively from the products' sheet data.
 *
 * @param {string}   chatId
 * @param {object[]} products
 * @param {number}   maxImages   - default 5 to avoid spam
 */
async function sendProductImages(chatId, products, maxImages = 5) {
  const withImages = products.filter((p) => extractImageUrl(p));
  const toSend = withImages.slice(0, maxImages);

  const results = [];
  for (const product of toSend) {
    const res = await sendProductImage(chatId, product);
    if (res) results.push(res);
    // Small delay to avoid Green API rate limits
    await new Promise((r) => setTimeout(r, 500));
  }
  return results;
}

/**
 * Send a generic image by URL (e.g. UPI QR code).
 * URL is always provided explicitly – never constructed.
 */
async function sendImageByUrl(chatId, url, caption = '', fileName = 'image.jpg') {
  if (!isValidUrl(url)) {
    logger.warn('[GreenAPI] sendImageByUrl – invalid URL', { url });
    return null;
  }
  try {
    const res = await greenApiClient.post(`/sendFileByUrl/${TOKEN}`, {
      chatId,
      urlFile: url,
      fileName,
      caption,
    });
    return res.data;
  } catch (err) {
    logger.error('[GreenAPI] sendImageByUrl failed', { chatId, url, error: err.message });
    return null;
  }
}

module.exports = { sendProductImage, sendProductImages, sendImageByUrl };
