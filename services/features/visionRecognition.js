'use strict';

const axios = require('axios');
const env = require('../../config/env');
const { logger } = require('../../errorHandler');
const memoryStore = require('../data/memoryStore');

const VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

/**
 * Call Groq vision API.
 * Accepts either a URL or a base64 string (jpegThumbnail from Green API).
 */
async function analyseImageWithVision(imageInput, isBase64 = false) {
  if (!imageInput) return null;

  // Build image content block
  let imageContent;
  if (isBase64) {
    // Green API jpegThumbnail is raw base64 without data URI prefix
    const base64Data = imageInput.startsWith('data:')
      ? imageInput
      : `data:image/jpeg;base64,${imageInput}`;
    imageContent = {
      type: 'image_url',
      image_url: { url: base64Data },
    };
  } else {
    imageContent = {
      type: 'image_url',
      image_url: { url: imageInput },
    };
  }

  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: VISION_MODEL,
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [
              imageContent,
              {
                type: 'text',
                text: 'Identify the sneaker in this image. Reply in this exact format only: Brand | Model | Color. Example: Nike | Air Max 90 | White. If you cannot identify it, reply: Unknown',
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

    const result = response.data?.choices?.[0]?.message?.content?.trim();
    logger.info('[Vision] Groq vision result', { model: VISION_MODEL, result, isBase64 });
    return result || null;
  } catch (err) {
    logger.error('[Vision] Groq vision API failed', {
      model: VISION_MODEL,
      status: err?.response?.status,
      error: err?.response?.data || err.message,
    });
    return null;
  }
}

/**
 * Find closest catalog matches from identified string "Brand | Model | Color"
 */
function findMatchesByIdentified(identified) {
  if (!identified || identified.toLowerCase().includes('unknown')) return [];
  const parts = identified.split('|').map((s) => s.trim());
  return findMatchesByDescription({ brand: parts[0], model: parts[1], color: parts[2] });
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
 * @param {string} imageInput  - URL or base64 string
 * @param {boolean} isBase64   - true if imageInput is base64 thumbnail
 */
async function matchSneakerFromImage(imageInput, isBase64 = false) {
  if (!imageInput) {
    logger.warn('[Vision] No image input provided');
    return { identified: null, matches: [], noUrl: true };
  }

  const identified = await analyseImageWithVision(imageInput, isBase64);

  if (!identified || identified.toLowerCase().includes('unknown')) {
    logger.info('[Vision] Could not identify sneaker');
    return { identified: null, matches: [] };
  }

  const matches = findMatchesByIdentified(identified);
  logger.info('[Vision] Matches found', { identified, count: matches.length });
  return { identified, matches };
}

module.exports = {
  matchSneakerFromImage,
  findMatchesByDescription,
  findMatchesByIdentified,
  analyseImageWithVision,
};
