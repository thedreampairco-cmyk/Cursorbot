'use strict';

const Client = require('../../models/Client');
const Order = require('../../models/User');
const { logger } = require('../../errorHandler');

// ── Client helpers ─────────────────────────────────────────────────────────────

/**
 * Upsert client record by waId.
 * Creates new client on first contact.
 */
async function getOrCreateClient(waId, name = '') {
  let client = await Client.findOne({ waId });
  if (!client) {
    client = new Client({ waId, name, firstMessageAt: new Date() });
    await client.save();
    logger.info('[DB] New client created', { waId });
  } else if (name && !client.name) {
    client.name = name;
  }
  return client;
}

async function saveClient(client) {
  try {
    await client.save();
  } catch (err) {
    logger.error('[DB] Failed to save client', { error: err.message, waId: client.waId });
    throw err;
  }
}

async function getClientByWaId(waId) {
  return Client.findOne({ waId });
}

/**
 * Update lead score (incremental).
 */
async function incrementLeadScore(waId, delta = 1) {
  await Client.updateOne({ waId }, { $inc: { leadScore: delta } });
}

/**
 * Add a browse event.
 */
async function recordBrowseEvent(waId, product) {
  await Client.updateOne(
    { waId },
    {
      $push: {
        browseHistory: {
          $each: [{ productId: product.id, productName: product.name, timestamp: new Date() }],
          $slice: -100,
        },
      },
    }
  );
}

/**
 * Get all clients with abandoned carts older than `hours`.
 */
async function getAbandonedCartClients(hours = 2) {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
  return Client.find({
    cartAbandoned: false,
    'cart.0': { $exists: true },
    lastCartActivity: { $lte: cutoff },
    handoffActive: false,
  });
}

/**
 * Mark cart as abandoned.
 */
async function markCartAbandoned(waId) {
  await Client.updateOne({ waId }, { cartAbandoned: true });
}

// ── Order helpers ─────────────────────────────────────────────────────────────

async function createOrder(data) {
  const order = new Order(data);
  await order.save();
  logger.info('[DB] Order created', { orderId: data.orderId });
  return order;
}

async function getOrderById(orderId) {
  return Order.findOne({ orderId });
}

async function updateOrderStatus(orderId, status, extra = {}) {
  const update = { status, ...extra };
  await Order.updateOne({ orderId }, { $set: update });
  logger.info('[DB] Order status updated', { orderId, status });
}

async function getOrdersByWaId(waId) {
  return Order.find({ waId }).sort({ createdAt: -1 });
}

// ── Analytics helpers ─────────────────────────────────────────────────────────

async function getSegmentCounts() {
  return Client.aggregate([{ $group: { _id: '$segment', count: { $sum: 1 } } }]);
}

async function getTopBrowsedProducts(limit = 10) {
  return Client.aggregate([
    { $unwind: '$browseHistory' },
    { $group: { _id: '$browseHistory.productName', views: { $sum: 1 } } },
    { $sort: { views: -1 } },
    { $limit: limit },
  ]);
}

async function getConversionStats() {
  const totalClients = await Client.countDocuments();
  const totalOrders = await Order.countDocuments({ status: { $in: ['paid', 'confirmed', 'shipped', 'delivered'] } });
  const revenue = await Order.aggregate([
    { $match: { status: { $in: ['paid', 'confirmed', 'shipped', 'delivered'] } } },
    { $group: { _id: null, total: { $sum: '$totalAmount' } } },
  ]);
  return {
    totalClients,
    totalOrders,
    revenue: revenue[0]?.total || 0,
    conversionRate: totalClients ? ((totalOrders / totalClients) * 100).toFixed(2) + '%' : '0%',
  };
}

module.exports = {
  getOrCreateClient,
  saveClient,
  getClientByWaId,
  incrementLeadScore,
  recordBrowseEvent,
  getAbandonedCartClients,
  markCartAbandoned,
  createOrder,
  getOrderById,
  updateOrderStatus,
  getOrdersByWaId,
  getSegmentCounts,
  getTopBrowsedProducts,
  getConversionStats,
};
