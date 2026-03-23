'use strict';

/**
 * Validates that a string is an absolute HTTP/HTTPS URL.
 */
function isValidUrl(str) {
  try {
    const url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Converts any Google Drive share/view link into a direct download URL
 * that WhatsApp (Green API) can fetch and display without a grey box.
 *
 * Handles all known Drive URL formats:
 *   https://drive.google.com/file/d/FILE_ID/view
 *   https://drive.google.com/file/d/FILE_ID/view?usp=sharing
 *   https://drive.google.com/open?id=FILE_ID
 *   https://drive.google.com/uc?id=FILE_ID
 *   https://drive.google.com/uc?export=view&id=FILE_ID
 */
function convertDriveUrl(url) {
  if (!url || typeof url !== 'string') return url;

  // Already a direct thumbnail/download link — leave as-is
  if (url.includes('drive.google.com/uc?export=download')) return url;

  let fileId = null;

  // Format: /file/d/FILE_ID/
  const fileMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) fileId = fileMatch[1];

  // Format: open?id=FILE_ID  or  uc?id=FILE_ID  or  uc?export=view&id=FILE_ID
  if (!fileId) {
    const paramMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (paramMatch) fileId = paramMatch[1];
  }

  if (fileId) {
    // Use export=download for direct binary — works reliably with Green API
    return `https://drive.google.com/uc?export=download&id=${fileId}`;
  }

  // Not a Drive link — return as-is
  return url;
}

/**
 * Picks the first valid image URL from a product object,
 * converting Google Drive links automatically.
 * Checks imageUrl, image_url, image, img columns in that order.
 * NEVER constructs a filename — always reads from sheet data.
 */
function extractImageUrl(product) {
  const candidates = [
    product?.imageUrl,
    product?.image_url,
    product?.image,
    product?.img,
    product?.photo,
    product?.picture,
  ];

  for (const raw of candidates) {
    if (!raw) continue;
    const converted = convertDriveUrl(raw.trim());
    if (isValidUrl(converted)) return converted;
  }

  return null;
}

/**
 * Safely encodes query params for a URL.
 */
function buildUrl(base, params = {}) {
  const url = new URL(base);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  });
  return url.toString();
}

module.exports = { isValidUrl, extractImageUrl, convertDriveUrl, buildUrl };
