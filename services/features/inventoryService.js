'use strict';

const memoryStore = require('../data/memoryStore');
const { logger } = require('../../errorHandler');

/**
 * Reduce stock for ordered items in the in-memory catalog.
 * NOTE: The catalog is re-synced from Google Sheets every 30 mins via cron.
 * For permanent stock updates, the store operator must update the Sheet.
 *
 * @param {Array<{ productId: string, quantity: number }>} items
 */
function reduceStock(items) {
  const catalog = memoryStore.getCatalog();
  for (const { productId, quantity = 1 } of items) {
    const product = catalog.find((p) => String(p.id) === String(productId));
    if (product) {
      product.stock = Math.max(0, (product.stock || 0) - quantity);
      product.inStock = product.stock > 0;
      logger.info('[Inventory] Stock reduced', { productId, remaining: product.stock });
    }
  }
}

/**
 * Check if all requested items are in stock.
 * @returns {{ ok: boolean, outOfStock: string[] }}
 */
function checkAvailability(items) {
  const outOfStock = [];
  for (const { productId, quantity = 1 } of items) {
    const product = memoryStore.findById(productId);
    if (!product || product.stock < quantity) {
      outOfStock.push(productId);
    }
  }
  return { ok: outOfStock.length === 0, outOfStock };
}

/**
 * Get low-stock products (stock <= threshold).
 */
function getLowStockProducts(threshold = 3) {
  return memoryStore.getCatalog().filter((p) => p.stock > 0 && p.stock <= threshold);
}

/**
 * Get out-of-stock products.
 */
function getOutOfStockProducts() {
  return memoryStore.getCatalog().filter((p) => p.stock === 0);
}

module.exports = { reduceStock, checkAvailability, getLowStockProducts, getOutOfStockProducts };
