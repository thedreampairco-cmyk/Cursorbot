'use strict';

const { v4: uuidv4 } = require('uuid');
const env = require('../../config/env');
const { logger } = require('../../errorHandler');
const db = require('./databaseService');

let razorpay = null;
if (env.razorpay.keyId && env.razorpay.keySecret) {
  try {
    const Razorpay = require('razorpay');
    razorpay = new Razorpay({
      key_id: env.razorpay.keyId,
      key_secret: env.razorpay.keySecret,
    });
    logger.info('[OrderStore] Razorpay initialised');
  } catch (e) {
    logger.warn('[OrderStore] Razorpay init failed – payment links disabled', { error: e.message });
  }
}

/**
 * Create a Razorpay payment link for a given amount.
 * Returns the short_url or null if Razorpay is not configured.
 */
async function createPaymentLink(orderId, amountInPaise, customerName, waId) {
  if (!razorpay) return null;
  try {
    const link = await razorpay.paymentLink.create({
      amount: amountInPaise,
      currency: 'INR',
      description: `Order ${orderId} – The Dream Pair`,
      customer: { name: customerName || 'Customer', contact: waId.replace('@c.us', '') },
      notify: { sms: true, email: false },
      reminder_enable: true,
      notes: { orderId },
    });
    return link.short_url;
  } catch (err) {
    logger.error('[OrderStore] Failed to create Razorpay link', { error: err.message });
    return null;
  }
}

/**
 * Build and persist an order, optionally generating a Razorpay payment link.
 */
async function placeOrder({ waId, customerName, items, shippingAddress, notes }) {
  const orderId = `TDP-${Date.now()}-${uuidv4().slice(0, 6).toUpperCase()}`;
  const totalAmount = items.reduce((sum, item) => sum + item.price * (item.quantity || 1), 0);

  let paymentLink = null;
  let razorpayOrderId = null;

  if (razorpay) {
    const amountInPaise = Math.round(totalAmount * 100);
    paymentLink = await createPaymentLink(orderId, amountInPaise, customerName, waId);
    razorpayOrderId = orderId; // store our orderId in razorpay notes
  }

  const order = await db.createOrder({
    orderId,
    waId,
    customerName,
    items,
    totalAmount,
    shippingAddress,
    notes,
    paymentLink,
    razorpayOrderId,
    status: 'pending_payment',
  });

  return { order, paymentLink, totalAmount };
}

/**
 * Confirm payment after webhook / manual update.
 */
async function confirmPayment(orderId, razorpayPaymentId) {
  await db.updateOrderStatus(orderId, 'paid', {
    razorpayPaymentId,
    paidAt: new Date(),
  });
  logger.info('[OrderStore] Payment confirmed', { orderId, razorpayPaymentId });
}

/**
 * Update AWB / shipping info.
 */
async function updateShipping(orderId, awbNumber, shippingProvider) {
  await db.updateOrderStatus(orderId, 'shipped', {
    awbNumber,
    shippingProvider,
    shippedAt: new Date(),
  });
  logger.info('[OrderStore] Shipment updated', { orderId, awbNumber });
}

module.exports = { placeOrder, confirmPayment, updateShipping };
