'use strict';

const express = require('express');
const router = express.Router();
const cron = require('node-cron');
const { asyncHandler, logger } = require('../errorHandler');
const { fetchAndSyncCatalog } = require('../services/data/googleSheetsFetch');
const memoryStore = require('../services/features/memoryStore');
const env = require('../config/env');

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== env.admin.secret) {
    return res.status(401).json({ ok: false, error: 'Unauthorised' });
  }
  next();
}

// ── GET /catalog/status ───────────────────────────────────────────────────────
router.get('/status', requireAdmin, (req, res) => {
  res.json({
    ok: true,
    products: memoryStore.getCatalogSize(),
    lastSyncAt: memoryStore.getLastSyncAt(),
  });
});

// ── POST /catalog/sync ────────────────────────────────────────────────────────
router.post('/sync', requireAdmin, asyncHandler(async (req, res) => {
  const products = await fetchAndSyncCatalog();
  res.json({ ok: true, synced: products.length, at: new Date() });
}));

// ── GET /catalog/products ─────────────────────────────────────────────────────
router.get('/products', requireAdmin, (req, res) => {
  const { brand, category, color, size, inStock } = req.query;
  let catalog = memoryStore.getCatalog();

  if (brand) catalog = catalog.filter((p) => p.brand?.toLowerCase().includes(brand.toLowerCase()));
  if (category) catalog = catalog.filter((p) => p.category?.toLowerCase().includes(category.toLowerCase()));
  if (color) catalog = catalog.filter((p) => p.color?.toLowerCase().includes(color.toLowerCase()));
  if (size) catalog = catalog.filter((p) => String(p.sizes || '').includes(size));
  if (inStock === 'true') catalog = catalog.filter((p) => p.inStock);

  res.json({ ok: true, count: catalog.length, products: catalog });
});

// ── Cron job: auto-sync catalog ───────────────────────────────────────────────
function startCatalogCron() {
  const expression = env.catalog.syncCron;
  if (!cron.validate(expression)) {
    logger.warn('[CatalogSync] Invalid cron expression – cron disabled', { expression });
    return;
  }
  cron.schedule(expression, async () => {
    try {
      await fetchAndSyncCatalog();
    } catch (err) {
      logger.error('[CatalogSync] Cron sync failed', { error: err.message });
    }
  });
  logger.info('[CatalogSync] Cron scheduled', { expression });
}

module.exports = { router, startCatalogCron };
