'use strict';

/**
 * Validates that a string is an absolute HTTP/HTTPS URL.
 * Used to guard image URLs from Google Sheets before sending via WhatsApp.
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
 * Picks the first valid image URL from a product object.
 * Checks imageUrl, image_url, image, img columns in that order.
 * NEVER constructs a filename – always reads from the sheet data.
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
  return candidates.find((u) => u && isValidUrl(u)) || null;
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

module.exports = { isValidUrl, extractImageUrl, buildUrl };
