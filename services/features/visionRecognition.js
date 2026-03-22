'use strict';

const { analyseImageForSneakers } = require('../ai/aiIntegration');
const memoryStore = require('../data/memoryStore');
const { logger } = require('../../errorHandler');

/**
 * Given a WhatsApp image URL sent by the user, attempt to identify the
 * sneaker and find the closest match in the catalog.
 *
 * @param {string} imageUrl - URL of image uploaded by customer
 * @returns {{ identified: string|null, matches: object[] }}
 */
async function matchSneakerFromImage(imageUrl) {
  const identified = await analyseImageForSneakers(imageUrl);
  logger.info('[Vision] Image analysed', { identified });

  if (!identified || identified.toLowerCase().includes('unknown')) {
    return { identified: null, matches: [] };
  }

  // Parse: "Brand | Model | Color"
  const parts = identified.split('|').map((s) => s.trim());
  const brand = parts[0] || '';
  const model = parts[1] || '';
  const color = parts[2] || '';

  // Find closest catalog matches by brand + partial model name
  const catalog = memoryStore.getCatalog();
  const scored = catalog
    .filter((p) => p.inStock)
    .map((p) => {
      let score = 0;
      if (brand && p.brand?.toLowerCase().includes(brand.toLowerCase())) score += 3;
      if (model && p.name?.toLowerCase().includes(model.toLowerCase().split(' ')[0])) score += 2;
      if (color && p.color?.toLowerCase().includes(color.toLowerCase())) score += 1;
      return { product: p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((x) => x.product);

  return { identified, matches: scored };
}

module.exports = { matchSneakerFromImage };
