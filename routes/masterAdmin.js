'use strict';

const express = require('express');
const router = express.Router();
const cron = require('node-cron');
const { asyncHandler, logger } = require('../errorHandler');
const db = require('../services/data/databaseService');
const { updateOrderStatus, getOrdersByWaId } = require('../services/data/databaseService');
const { updateShipping } = require('../services/data/orderStore');
const { sendText } = require('../services/whatsapp/greenApiText');
const { getLowStockProducts, getOutOfStockProducts } = require('../services/features/inventoryService');
const memoryStore = require('../services/features/memoryStore');
const env = require('../config/env');

// ── Auth ──────────────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== env.admin.secret) return res.status(401).json({ ok: false, error: 'Unauthorised' });
  next();
}
router.use(requireAdmin);

// ═══════════════════════════════════════════════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/analytics/conversions', asyncHandler(async (req, res) => {
  const stats = await db.getConversionStats();
  res.json({ ok: true, ...stats });
}));

router.get('/analytics/top-products', asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit || '10', 10);
  const top = await db.getTopBrowsedProducts(limit);
  res.json({ ok: true, products: top });
}));

router.get('/analytics/segments', asyncHandler(async (req, res) => {
  const segments = await db.getSegmentCounts();
  res.json({ ok: true, segments });
}));

router.get('/analytics/inventory', (req, res) => {
  res.json({
    ok: true,
    totalProducts: memoryStore.getCatalogSize(),
    lowStock: getLowStockProducts(3),
    outOfStock: getOutOfStockProducts(),
    lastSyncAt: memoryStore.getLastSyncAt(),
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ORDER MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/orders/:waId', asyncHandler(async (req, res) => {
  const orders = await getOrdersByWaId(req.params.waId + (req.params.waId.includes('@') ? '' : '@c.us'));
  res.json({ ok: true, orders });
}));

router.patch('/orders/:orderId/status', asyncHandler(async (req, res) => {
  const { status } = req.body;
  const allowed = ['pending_payment', 'paid', 'confirmed', 'shipped', 'delivered', 'cancelled'];
  if (!allowed.includes(status)) return res.status(400).json({ ok: false, error: 'Invalid status' });
  await updateOrderStatus(req.params.orderId, status);
  res.json({ ok: true, orderId: req.params.orderId, status });
}));

router.patch('/orders/:orderId/ship', asyncHandler(async (req, res) => {
  const { awbNumber, shippingProvider, waId } = req.body;
  if (!awbNumber) return res.status(400).json({ ok: false, error: 'awbNumber required' });
  await updateShipping(req.params.orderId, awbNumber, shippingProvider);
  if (waId) {
    await sendText(
      waId,
      `🚚 Great news! Your order *${req.params.orderId}* has been shipped!\nTracking: *${awbNumber}* via ${shippingProvider || 'courier'}`
    );
  }
  res.json({ ok: true, orderId: req.params.orderId, awbNumber });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// HUMAN HANDOFF MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/handoff/resolve/:waId', asyncHandler(async (req, res) => {
  const { Client } = require('../models/Client'); // lazy to avoid circular
  const waId = req.params.waId + (req.params.waId.includes('@') ? '' : '@c.us');
  await require('../models/Client').updateOne({ waId }, { handoffActive: false });
  await sendText(waId, "You're back with Maya! 👋 How can I help you today?");
  res.json({ ok: true, waId, handoffActive: false });
}));

// ── Send message as Maya (agent-to-customer) ──────────────────────────────────
router.post('/message/send', asyncHandler(async (req, res) => {
  const { waId, message } = req.body;
  if (!waId || !message) return res.status(400).json({ ok: false, error: 'waId and message required' });
  await sendText(waId, message);
  res.json({ ok: true });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// BROADCAST / MARKETING
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/broadcast', asyncHandler(async (req, res) => {
  const { message, segment, limit = 50 } = req.body;
  if (!message) return res.status(400).json({ ok: false, error: 'message required' });

  const query = segment ? { segment } : {};
  const clients = await require('../models/Client').find(query).limit(parseInt(limit, 10));

  let sent = 0;
  let failed = 0;
  for (const client of clients) {
    try {
      await sendText(client.waId, message);
      sent++;
      await new Promise((r) => setTimeout(r, 1000)); // 1s delay to avoid bans
    } catch {
      failed++;
    }
  }

  logger.info('[Broadcast] Completed', { sent, failed, segment });
  res.json({ ok: true, sent, failed });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// ABANDONED CART AUTOMATION (also runs as cron)
// ═══════════════════════════════════════════════════════════════════════════════

async function runAbandonedCartFollowUp() {
  const clients = await db.getAbandonedCartClients(env.marketing.abandonedCartHours);
  logger.info('[Marketing] Abandoned cart check', { found: clients.length });

  for (const client of clients) {
    try {
      const items = client.cart.map((i) => i.productName).join(', ');
      const msg = `Hey ${client.name || 'there'}! 👋 You left some amazing kicks in your cart:\n\n👟 ${items}\n\nDon't let them slip away! Reply *checkout* to complete your order 🔥`;
      await sendText(client.waId, msg);
      await db.markCartAbandoned(client.waId);
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      logger.error('[Marketing] Abandoned cart message failed', { waId: client.waId, error: err.message });
    }
  }
}

router.post('/marketing/abandoned-cart', asyncHandler(async (req, res) => {
  await runAbandonedCartFollowUp();
  res.json({ ok: true });
}));

function startMarketingCrons() {
  // Run abandoned cart check every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    try {
      await runAbandonedCartFollowUp();
    } catch (err) {
      logger.error('[Marketing] Cron error', { error: err.message });
    }
  });
  logger.info('[Marketing] Abandoned cart cron scheduled');
}

module.exports = { router, startMarketingCrons };
