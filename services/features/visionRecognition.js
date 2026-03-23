'use strict';

const axios = require('axios');
const env = require('../../config/env');
const { logger } = require('../../errorHandler');
const memoryStore = require('../data/memoryStore');

const VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

/**
 * Download image from any URL into memory and convert to base64.
 * This bypasses Green API URL access restrictions.
 */
async function downloadImageAsBase64(imageUrl) {
  const response = await axios({
    url: imageUrl,
    method: 'GET',
    responseType: 'arraybuffer',
    timeout: 15000,
  });
  const base64 = Buffer.from(response.data, 'binary').toString('base64');
  return `data:image/jpeg;base64,${base64}`;
}

/**
 * Analyse a sneaker image using Groq vision (llama-4-scout).
 * Accepts a URL (downloads it first) or a raw base64 string from Green API thumbnail.
 * Returns JSON: { detected_text, labels }
 */
async function analyseImageWithVision(imageInput, isBase64 = false) {
  if (!imageInput) return null;

  let dataUrl;

  try {
    if (isBase64) {
      // jpegThumbnail from Green API — already base64, just add data URI prefix
      dataUrl = imageInput.startsWith('data:')
        ? imageInput
        : `data:image/jpeg;base64,${imageInput}`;
    } else {
      // Real URL — download into memory and convert to base64
      logger.info('[Vision] Downloading image into memory', { url: imageInput.slice(0, 80) });
      dataUrl = await downloadImageAsBase64(imageInput);
    }
  } catch (err) {
    logger.error('[Vision] Failed to load image', { error: err.message });
    return null;
  }

  try {
    logger.info('[Vision] Sending to Groq llama-4-scout...');

    // Build catalog brand list for better matching
    const catalog = memoryStore.getCatalog();
    const brandList = [...new Set(catalog.map((p) => p.name))].slice(0, 20).join(', ');

    const groqResponse = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: VISION_MODEL,
        max_tokens: 200,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Analyze this shoe image. Reply ONLY with a valid JSON object, no markdown.
Format: {"detected_text": "brand and model name", "brand": "brand name", "color": "primary color", "labels": ["tag1", "tag2"]}.
Try to match exactly with these products if possible: ${brandList}.
Example: {"detected_text": "Nike Air Max 90", "brand": "Nike", "color": "White", "labels": ["running", "casual"]}`,
              },
              {
                type: 'image_url',
                image_url: { url: dataUrl },
              },
            ],
          },
        ],
      },
      {
        timeout: 20000,
        headers: {
          Authorization: `Bearer ${env.groq.apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const raw = groqResponse.data.choices[0].message.content;
    const result = JSON.parse(raw);
    logger.info('[Vision] Groq result', { result });
    return result;
  } catch (err) {
    logger.error('[Vision] Groq vision API failed', {
      status: err?.response?.status,
      error: err?.response?.data || err.message,
    });
    // Safe fallback
    return { detected_text: '', brand: '', color: '', labels: ['shoe', 'sneaker'] };
  }
}

/**
 * Find closest catalog matches from vision result.
 */
function findMatchesFromVisionResult(result) {
  if (!result || !result.detected_text) return [];

  const { detected_text, brand, color } = result;

  return findMatchesByDescription({
    brand: brand || detected_text.split(' ')[0],
    model: detected_text,
    color: color || '',
    query: detected_text,
  });
}

/**
 * Find closest catalog matches from loose description fields.
 */
function findMatchesByDescription({ brand, model, color, query } = {}) {
  const catalog = memoryStore.getCatalog();

  const scored = catalog
    .filter((p) => p.inStock)
    .map((p) => {
      let score = 0;
      if (brand && p.brand?.toLowerCase().includes(brand.toLowerCase())) score += 4;
      if (model && p.name?.toLowerCase().includes(model.toLowerCase().split(' ')[0])) score += 3;
      if (color && p.color?.toLowerCase().includes(color.toLowerCase())) score += 2;
      if (query) {
        const hay = `${p.name} ${p.brand} ${p.category} ${p.color}`.toLowerCase();
        if (hay.includes(query.toLowerCase())) score += 2;
      }
      return { product: p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((x) => x.product);

  return scored;
}

/**
 * Main entry — called from webhook when customer sends an image.
 * @param {string}  imageInput  - URL or base64 string
 * @param {boolean} isBase64    - true if imageInput is base64 thumbnail
 */
async function matchSneakerFromImage(imageInput, isBase64 = false) {
  if (!imageInput) {
    logger.warn('[Vision] No image input provided');
    return { identified: null, matches: [], noUrl: true };
  }

  const result = await analyseImageWithVision(imageInput, isBase64);

  if (!result || !result.detected_text) {
    logger.info('[Vision] No sneaker identified');
    return { identified: null, matches: [] };
  }

  const identified = result.detected_text;
  const matches = findMatchesFromVisionResult(result);

  logger.info('[Vision] Matches found', { identified, count: matches.length });
  return { identified, matches };
}

module.exports = {
  matchSneakerFromImage,
  findMatchesByDescription,
  analyseImageWithVision,
  downloadImageAsBase64,
};
