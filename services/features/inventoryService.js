// services/features/inventoryService.js
"use strict";

const cron = require("node-cron");
const { logger, AppError }         = require("../../errorHandler");
const {
  fetchCatalogFromSheet,
  syncInventory,
  deductStock,
  isInStock,
}                                  = require("../googleSheets");
const { sendLowStockAlert }        = require("./whatsappService");
const { getUserPrefs }             = require("./memoryStore");

// ─── In-Process Catalog Cache ─────────────────────────────────────────────────

const LOW_STOCK_THRESHOLD = parseInt(process.env.LOW_STOCK_THRESHOLD || "5", 10);
const CACHE_TTL_MS        = 10 * 60 * 1000; // 10 minutes

let _catalogCache        = [];
let _catalogCachedAt     = 0;
let _inventoryCache      = []; // [{ sku, stock, rowIndex }]
let _inventoryCachedAt   = 0;

// ─── Catalog ──────────────────────────────────────────────────────────

/**
 * Return the full catalog, refreshing from Google Sheets if the cache is stale.
 * ✅ FIXED: Merges CSV catalog with live Inventory sheet stock data
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<object[]>}
 */
async function getCatalog(forceRefresh = false) {
  if (!forceRefresh && _catalogCache.length > 0 && Date.now() - _catalogCachedAt < CACHE_TTL_MS) {
    return _catalogCache;
  }
  try {
    // ✅ FIXED: Fetch BOTH catalog (product data) AND live inventory (stock counts)
    const raw = await fetchCatalogFromSheet();
    const liveInventory = await syncInventory(); // Get latest stock from Sheets
    
    // ✅ FIXED: Merge live stock into catalog
    const merged = raw.map(product => {
      const inventoryItem = liveInventory.find(inv => inv.sku === product.sku);
      return {
        ...product,
        stock: inventoryItem ? inventoryItem.stock : product.stock, // Use live stock if available
      };
    });
    
    _catalogCache    = merged.filter((p) => p.active !== false);
    _catalogCachedAt = Date.now();
    logger.info(`[Inventory] ✅ Catalog refreshed: ${_catalogCache.length} active products with LIVE stock`);
    return _catalogCache;
  } catch (err) {
    logger.error(`[Inventory] getCatalog failed: ${err.message}`);
    // Return stale cache rather than crashing if we have one
    if (_catalogCache.length > 0) {
      logger.warn("[Inventory] Returning stale catalog due to refresh failure.");
      return _catalogCache;
    }
    throw new AppError("Catalog unavailable. Please try again shortly.", 503, "CATALOG_UNAVAILABLE");
  }
}

/**
 * Find a single product by SKU.
 * ✅ FIXED: Includes live stock from inventory sheet
 * @param {string} sku
 * @returns {Promise<object|null>}
 */
async function getProductBySku(sku) {
  const catalog = await getCatalog();
  return catalog.find((p) => p.sku === sku) || null;
}

/**
 * Find products by category (case-insensitive).
 * @param {string} category
 * @returns {Promise<object[]>}
 */
async function getProductsByCategory(category) {
  const catalog = await getCatalog();
  return catalog.filter(
    (p) => p.category.toLowerCase() === category.toLowerCase()
  );
}

/**
 * Keyword search across brand, name, category, and description.
 * ✅ FIXED: Returns products with LIVE stock from inventory sheet
 * @param {string} query
 * @returns {Promise<object[]>}
 */
async function searchProducts(query) {
  try {
    const catalog = await getCatalog(); // ✅ Now includes live stock
    logger.info(`[Debug] Total catalog size: ${catalog.length}`);

    // 1. Clean the vision description or user query
    const cleanQuery = query.toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
    // Remove filler words that the Vision AI often uses
    const ignoreWords = ['and', 'with', 'the', 'low', 'top', 'sneaker', 'shoe', 'shoes', 'accents', 'color', 'combo'];
    const terms = cleanQuery.split(' ').filter(t => t.length > 2 && !ignoreWords.includes(t));
    
    logger.info(`[Debug] Scoring search for terms: ${terms.join(', ')}`);
    
    // 2. Score every product in the database
    const scoredCatalog = catalog.map(p => {
      const target = `${p.brand || ''} ${p.name || ''} ${p.category || ''} ${p.description || ''}`.toLowerCase();
      let score = 0;
      
      terms.forEach(term => {
        if (target.includes(term)) score += 1;
      });
      
      // Massive score boost if the brand matches perfectly
      if (p.brand && terms.includes(p.brand.toLowerCase())) score += 5;
      
      return { product: p, score };
    });

    // 3. Filter out zero-scores and rank by highest score
    const results = scoredCatalog
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(item => item.product);

    logger.info(`[Debug] Found ${results.length} matches based on relevance.`);
    return results;
  } catch (err) {
    logger.error("[Inventory] Search failed: " + err.message);
    return [];
  }
}

/**
 * Return all unique category names with product counts.
 * @returns {Promise<Array<{ name: string, count: number }>>}
 */
async function getCategorySummary() {
  const catalog = await getCatalog();
  const counts  = catalog.reduce((acc, p) => {
    acc[p.category] = (acc[p.category] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Get all products that are in stock.
 * ✅ FIXED: Filters by LIVE stock from inventory sheet
 * @returns {Promise<object[]>}
 */
async function getInStockProducts() {
  const catalog = await getCatalog(); // ✅ Now includes live stock
  const inStock = catalog.filter((p) => p.stock > 0);
  logger.info(`[Inventory] getInStockProducts: ${inStock.length} / ${catalog.length} in stock`);
  return inStock;
}

// ─── Inventory ─────────────────────────────────────────────────────────

/**
 * Return the live inventory array, refreshing if stale.
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<Array<{ sku: string, stock: number, rowIndex: number }>>}
 */
async function getInventory(forceRefresh = false) {
  if (
    !forceRefresh &&
    _inventoryCache.length > 0 &&
    Date.now() - _inventoryCachedAt < CACHE_TTL_MS
  ) {
    return _inventoryCache;
  }
  _inventoryCache    = await syncInventory();
  _inventoryCachedAt = Date.now();
  return _inventoryCache;
}

/**
 * Get the current stock count for a SKU.
 * ✅ FIXED: Checks LIVE inventory, not cached catalog
 * @param {string} sku
 * @returns {Promise<number>}
 */
async function getStockCount(sku) {
  const inventory = await getInventory(); // ✅ Get live inventory directly
  const item      = inventory.find((i) => i.sku === sku);
  return item ? item.stock : 0;
}

/**
 * Check whether a SKU is available in the required quantity.
 * Uses the sheets service under the hood and also cross-checks the local catalog cache.
 * @param {string} sku
 * @param {number} [qty=1]
 * @returns {Promise<boolean>}
 */
async function checkAvailability(sku, qty = 1) {
  try {
    return await isInStock(sku, qty);
  } catch (err) {
    logger.warn(`[Inventory] checkAvailability fallback for ${sku}: ${err.message}`);
    // Fallback to live inventory
    const stock = await getStockCount(sku);
    return stock >= qty;
  }
}

/**
 * Return all sizes of a product that have stock >= 1.
 * Cross-references the catalog's size list against inventory stock.
 * ✅ FIXED: Now checks LIVE stock
 * @param {string} sku
 * @returns {Promise<string[]>}
 */
async function getAvailableSizes(sku) {
  const product = await getProductBySku(sku);
  if (!product) return [];
  
  // ✅ FIXED: Check LIVE stock count, not cached product.stock
  const stock = await getStockCount(sku);
  if (stock <= 0) return [];
  
  // The catalog stores a single stock number — sizes are all available if stock > 0.
  // If per-size inventory is needed, extend this with a separate size-level sheet lookup.
  return product.sizes || [];
}

// ─── Stock Deduction & Alerts ─────────────────────────────────────────────────

/**
 * Deduct stock after a confirmed purchase and fire low-stock alerts if needed.
 * Also invalidates the local caches.
 * ✅ FIXED: Invalidates catalog cache so next getCatalog() fetches fresh stock
 * @param {string} sku
 * @param {number} qty
 * @returns {Promise<{ sku: string, newStock: number, lowStock: boolean }>}
 */
async function reserveStock(sku, qty) {
  try {
    const result = await deductStock(sku, qty);

    // ✅ FIXED: Invalidate BOTH caches so next read fetches fresh data from Sheets
    _inventoryCachedAt = 0;
    _catalogCachedAt   = 0;

    if (result.lowStock) {
      const product = await getProductBySku(sku);
      if (product) {
        await sendLowStockAlert({ ...product, stock: result.newStock });
      }
    }

    logger.info(`[Inventory] ✅ Stock reserved: ${sku} | qty=${qty} | remaining=${result.newStock}`);
    return result;
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error(`[Inventory] reserveStock failed for ${sku}: ${err.message}`);
    throw new AppError(`Failed to reserve stock for SKU "${sku}".`, 502, "STOCK_RESERVE_FAILED");
  }
}

// ─── Cart Validation ───────────────────────────────────────────────────────

/**
 * Validate every item in a cart array against live inventory.
 * Returns a detailed report of what is available, partially available, or out of stock.
 *
 * @param {Array<{ sku: string, qty: number, size: string, name: string, price: number }>} cartItems
 * @returns {Promise<{
 *   valid:    Array<object>,
 *   invalid:  Array<{ item: object, reason: string }>,
 *   allValid: boolean
 * }>}
 */
async function validateCartItems(cartItems) {
  const valid   = [];
  const invalid = [];

  for (const item of cartItems) {
    const available = await checkAvailability(item.sku, item.qty);
    if (available) {
      valid.push(item);
    } else {
      const stock = await getStockCount(item.sku);
      invalid.push({
        item,
        reason:
          stock === 0
            ? `"${item.name}" is currently out of stock.`
            : `Only ${stock} unit(s) of "${item.name}" available (requested ${item.qty}).`,
      });
    }
  }

  return { valid, invalid, allValid: invalid.length === 0 };
}

/**
 * Build a human-friendly inventory warning string for WhatsApp.
 * @param {Array<{ item: object, reason: string }>} invalidItems
 * @returns {string}
 */
function formatInventoryWarning(invalidItems) {
  if (!invalidItems.length) return "";
  const lines = invalidItems.map((e) => `⚠️ ${e.reason}`);
  return lines.join("\n");
}

// ─── Product Recommendations ─────────────────────────────────────────────────

/**
 * Suggest alternative in-stock products for an out-of-stock SKU.
 * Matches by same category, then by brand, falling back to any in-stock item.
 * @param {string} sku
 * @param {number} [limit=3]
 * @returns {Promise<object[]>}
 */
async function suggestAlternatives(sku, limit = 3) {
  const product = await getProductBySku(sku);
  if (!product) return [];

  const inStock = await getInStockProducts(); // ✅ Gets in-stock products with LIVE stock
  const others  = inStock.filter((p) => p.sku !== sku);

  // 1st: same category + brand
  const sameBoth = others.filter(
    (p) =>
      p.category.toLowerCase() === product.category.toLowerCase() &&
      p.brand.toLowerCase()    === product.brand.toLowerCase()
  );
  if (sameBoth.length >= limit) return sameBoth.slice(0, limit);

  // 2nd: same category
  const sameCat = others.filter(
    (p) => p.category.toLowerCase() === product.category.toLowerCase()
  );
  if (sameCat.length >= limit) return sameCat.slice(0, limit);

  // Fallback: any in-stock product
  return others.slice(0, limit);
}

/**
 * Return trending / featured products (currently: highest-priced active in-stock items).
 * Replace with a view-count or sales-rank field from Sheets for production.
 * @param {number} [limit=5]
 * @returns {Promise<object[]>}
 */
async function getFeaturedProducts(limit = 5) {
  const inStock = await getInStockProducts(); // ✅ Gets in-stock with LIVE stock
  return inStock
    .sort((a, b) => b.price - a.price)
    .slice(0, limit);
}

/**
 * Return personalised product recommendations based on stored user preferences.
 * @param {string} phone
 * @param {number} [limit=3]
 * @returns {Promise<object[]>}
 */
async function getPersonalisedRecommendations(phone, limit = 3) {
  const prefs   = getUserPrefs(phone);
  const catalog = await getInStockProducts(); // ✅ Gets in-stock with LIVE stock

  if (!prefs.preferredBrand && !prefs.preferredCategory) {
    return getFeaturedProducts(limit);
  }

  const scored = catalog.map((p) => {
    let score = 0;
    if (prefs.preferredBrand    && p.brand.toLowerCase()    === prefs.preferredBrand.toLowerCase())    score += 2;
    if (prefs.preferredCategory && p.category.toLowerCase() === prefs.preferredCategory.toLowerCase()) score += 2;
    if (prefs.preferredSize     && (p.sizes || []).includes(prefs.preferredSize))                      score += 1;
    return { product: p, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.product)
    .slice(0, limit);
}

// ─── Scheduled Sync ───────────────────────────────────────────────────────

/**
 * Register a cron job that refreshes the catalog and inventory every 15 minutes.
 * ✅ FIXED: Forcefully refreshes to catch any manual CSV updates
 * Call once at app startup.
 */
function startInventorySyncScheduler() {
  cron.schedule("*/15 * * * *", async () => {
    try {
      await getCatalog(true); // ✅ Force refresh to get latest stock
      await getInventory(true); // ✅ Force refresh inventory
      logger.info("[Inventory] ✅ Scheduled sync completed - CSV and Sheets synced.");
    } catch (err) {
      logger.error(`[Inventory] Scheduled sync failed: ${err.message}`);
    }
  });
  logger.info('[Inventory] ✅ Sync scheduler registered (every 15 min with LIVE stock sync).');
}

module.exports = {
  // Catalog
  getCatalog,
  getProductBySku,
  getProductsByCategory,
  searchProducts,
  getCategorySummary,
  getInStockProducts,

  // Inventory
  getInventory,
  getStockCount,
  checkAvailability,
  getAvailableSizes,
  reserveStock,

  // Cart
  validateCartItems,
  formatInventoryWarning,

  // Recommendations
  suggestAlternatives,
  getFeaturedProducts,
  getPersonalisedRecommendations,

  // Scheduler
  startInventorySyncScheduler,
};