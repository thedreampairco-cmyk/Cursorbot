'use strict';

const axios = require('axios');
const env = require('../../config/env');
const { logger } = require('../../errorHandler');
const memoryStore = require('../data/memoryStore');

const VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

/**
 * Call Groq vision API with the image URL.
 * Returns raw text like "Nike | Air Max 90 | White" or "Unknown"
 */
async function analyseImageWithVision(imageUrl) {
  if (!imageUrl) return null;

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
              {
                type: 'image_url',
                image_url: { url: imageUrl },
              },
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
    logger.info('[Vision] Groq vision result', { model: VISION_MODEL, result });
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
 * Find closest catalog matches from a parsed description string.
 * Input: "Nike | Air Max 90 | White"
 */
function findMatchesByIdentified(identified) {
  if (!identified || identified.toLowerCase().includes('unknown')) return [];

  const parts = identified.split('|').map((s) => s.trim());
  const brand = parts[0] || '';
  const model = parts[1] || '';
  const color = parts[2] || '';

  return findMatchesByDescription({ brand, model, color });
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
 * Main entry point — called from webhook when customer sends an image.
 * Uses Groq vision model to identify the sneaker, then matches catalog.
 */
async function matchSneakerFromImage(imageUrl) {
  if (!imageUrl) {
    logger.warn('[Vision] No image URL provided');
    return { identified: null, matches: [], noUrl: true };
  }

  const identified = await analyseImageWithVision(imageUrl);

  if (!identified || identified.toLowerCase().includes('unknown')) {
    logger.info('[Vision] Could not identify sneaker from image');
    return { identified: null, matches: [] };
  }

  const matches = findMatchesByIdentified(identified);
  logger.info('[Vision] Catalog matches found', { identified, count: matches.length });

  return { identified, matches };
}

module.exports = {
  matchSneakerFromImage,
  findMatchesByDescription,
  findMatchesByIdentified,
  analyseImageWithVision,
};
