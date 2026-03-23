'use strict';

const express = require('express');
const router = express.Router();
const { asyncHandler, logger } = require('../errorHandler');
const db = require('../services/data/databaseService');
const { processMessage } = require('../services/ai/aiIntegration');
const { sendText, sendButtons } = require('../services/whatsapp/greenApiText');
const { sendProductImages } = require('../services/whatsapp/greenApiMedia');
const { matchSneakerFromImage } = require('../services/features/visionRecognition');
const { reduceStock, checkAvailability } = require('../services/features/inventoryService');
const { placeOrder } = require('../services/data/orderStore');
const memoryStore = require('../services/data/memoryStore');
const env = require('../config/env');

// ── In-memory last-mentioned product per chat (survives within server uptime) ─
// Key: chatId → { productId, productName, price, imageUrl }
const lastMentioned = new Map();

function setLastMentioned(chatId, product) {
  if (!product) return;
  lastMentioned.set(chatId, {
    productId: String(product.id),
    productName: product.name,
    price: product.price,
    imageUrl: product.imageUrl || null,
  });
}

function getLastMentioned(chatId) {
  return lastMentioned.get(chatId) || null;
}

// ── Extract product IDs the AI mentioned in its reply ─────────────────────────
// Scans for catalog IDs inside the AI reply text
function extractMentionedProducts(replyText) {
  const catalog = memoryStore.getCatalog();
  return catalog.filter((p) => {
    const id = String(p.id);
    // Match [id] or standalone id token in reply
    return new RegExp(`\\[${id}\\]|\\b${id}\\b`).test(replyText);
  });
}

// ── Handoff detection ─────────────────────────────────────────────────────────
function needsHandoff(text) {
  const lower = text.toLowerCase();
  return env.handoff.triggerKeywords.some((kw) => lower.includes(kw));
}

// ── Preference extraction ─────────────────────────────────────────────────────
function updatePreferences(client, userText) {
  const lower = userText.toLowerCase();
  const brands = ['nike', 'adidas', 'puma', 'new balance', 'reebok', 'jordan', 'converse', 'vans', 'skechers', 'asics', 'onitsuka'];
  const colors = ['black', 'white', 'red', 'blue', 'green', 'grey', 'gray', 'pink', 'yellow', 'brown'];

  brands.forEach((b) => {
    if (lower.includes(b) && !client.preferences.brand?.includes(b))
      client.preferences.brand = [...(client.preferences.brand || []), b];
  });
  colors.forEach((c) => {
    if (lower.includes(c) && !client.preferences.color?.includes(c))
      client.preferences.color = [...(client.preferences.color || []), c];
  });

  const sizeMatch = userText.match(/(?:size|uk|us|eu)?\s*(\d{1,2}(?:\.\d)?)/i);
  if (sizeMatch) {
    const sz = sizeMatch[1];
    if (!client.preferences.size?.includes(sz))
      client.preferences.size = [...(client.preferences.size || []), sz];
  }

  const budgetMatch = userText.match(/(?:under|below|budget|max|upto|up to)\s*(?:rs\.?|inr)?\s*(\d+)/i);
  if (budgetMatch) client.preferences.priceMax = parseInt(budgetMatch[1], 10);
}

// ── Lead scoring ──────────────────────────────────────────────────────────────
async function scoreActivity(waId, intents, userText) {
  let delta = 1;
  if (intents.wantsBuy) delta += 5;
  if (intents.wantsImages.length) delta += 2;
  if (/price|cost|how much|rs\.?/i.test(userText)) delta += 2;
  if (/buy|order|checkout|purchase/i.test(userText)) delta += 4;
  await db.incrementLeadScore(waId, delta);
}

// ── Segment update ────────────────────────────────────────────────────────────
async function updateSegment(client) {
  if (client.segment === 'customer') return;
  let segment = 'new';
  if (client.leadScore >= 5) segment = 'warm';
  if (client.leadScore >= 15) segment = 'hot';
  client.segment = segment;
}

// ── Add product to real cart ──────────────────────────────────────────────────
function addToCart(client, product) {
  client.cart = client.cart || [];
  const existing = client.cart.find((i) => i.productId === String(product.productId || product.id));
  if (existing) {
    existing.quantity = (existing.quantity || 1) + 1;
  } else {
    client.cart.push({
      productId: String(product.productId || product.id),
      productName: product.productName || product.name,
      price: product.price,
      quantity: 1,
      imageUrl: product.imageUrl || null,
    });
  }
  client.lastCartActivity = new Date();
  client.cartAbandoned = false;
}

// ── Format cart for display ───────────────────────────────────────────────────
function formatCart(cart) {
  if (!cart || !cart.length) return '(empty)';
  const lines = cart.map((i, idx) => `${idx + 1}. ${i.productName} x${i.quantity} – Rs.${i.price}`);
  const total = cart.reduce((s, i) => s + i.price * i.quantity, 0);
  return lines.join('\n') + `\n\nTotal: Rs.${total.toLocaleString('en-IN')}`;
}

// ── Is this an "add to cart" message? ────────────────────────────────────────
function isAddToCart(text) {
  return /add\s*(to\s*)?cart|add\s*this|i('ll)?\s*take\s*(this|it)|buy\s*this|want\s*this|order\s*this/i.test(text);
}

// ── Main webhook ──────────────────────────────────────────────────────────────
router.post('/', asyncHandler(async (req, res) => {
  res.status(200).json({ ok: true });

  const body = req.body;
  logger.debug('[Webhook] Raw payload', { body: JSON.stringify(body).slice(0, 500) });

  const payload    = body?.body || body;
  const typeWebhook = payload?.typeWebhook;
  const senderData  = payload?.senderData;
  const msgData     = payload?.messageData;

  if (!typeWebhook || typeWebhook !== 'incomingMessageReceived') return;

  const chatId     = senderData?.chatId || senderData?.sender;
  const senderName = senderData?.senderName || senderData?.pushname || '';

  if (!chatId || chatId.endsWith('@g.us')) return;

  const msgType = msgData?.typeMessage;
  let userText = '';
  let imageUrl = null;

  if (msgType === 'textMessage') {
    userText = msgData?.textMessageData?.textMessage || '';
  } else if (msgType === 'imageMessage') {
    userText = msgData?.imageMessageData?.caption || 'I sent you an image';
    imageUrl = msgData?.imageMessageData?.downloadUrl || msgData?.imageMessageData?.jpegThumbnail || null;
  } else if (msgType === 'extendedTextMessage') {
    userText = msgData?.extendedTextMessageData?.text || '';
  } else if (msgType === 'quotedMessage') {
    userText = msgData?.extendedTextMessageData?.text || msgData?.textMessageData?.textMessage || '';
  } else {
    await sendText(chatId, "Hey! I can understand text and images 😊 How can I help you find the perfect pair?");
    return;
  }

  if (!userText && !imageUrl) return;

  logger.info('[Webhook] Message', { chatId, msgType, text: userText.slice(0, 60) });

  const client = await db.getOrCreateClient(chatId, senderName);

  // ── Handoff active ──
  if (client.handoffActive) {
    if (env.handoff.agentNumber)
      await sendText(env.handoff.agentNumber, `[${client.name || chatId}] ${userText}`);
    return;
  }

  // ── Handoff trigger ──
  if (needsHandoff(userText)) {
    client.handoffActive = true;
    client.addMessage('user', userText);
    await db.saveClient(client);
    await sendText(chatId, "Sure! Connecting you with our team right away 🙌 Please hold on.");
    if (env.handoff.agentNumber)
      await sendText(env.handoff.agentNumber, `Handoff from ${client.name || chatId}: ${userText}`);
    return;
  }

  // ── Image upload ──
  if (imageUrl) {
    await sendText(chatId, "Ooh, let me check out that sneaker! 👀🔍");
    const { identified, matches } = await matchSneakerFromImage(imageUrl);
    if (matches.length) {
      const msg = identified
        ? `Looks like a *${identified}* vibe! Closest matches 👟`
        : "Here are similar sneakers we carry 👟";
      await sendText(chatId, msg);
      await sendProductImages(chatId, matches, 4);
      const names = matches.map((p, i) => `${i + 1}. ${p.name} – Rs.${p.price}`).join('\n');
      await sendText(chatId, `Which one catches your eye?\n${names}`);
      if (matches[0]) setLastMentioned(chatId, matches[0]);
    } else {
      await sendText(chatId, "Couldn't find an exact match! Tell me the brand or style 😊");
    }
    client.addMessage('user', userText);
    client.addMessage('assistant', identified ? `Matched: ${identified}` : 'No match');
    await db.saveClient(client);
    return;
  }

  updatePreferences(client, userText);

  // ── VIEW CART ──
  if (/^(my\s+)?cart$|^view\s+cart$/i.test(userText.trim())) {
    const cart = client.cart || [];
    if (!cart.length) {
      await sendText(chatId, "Your cart is empty! 🛒 Browse our sneakers and add something you love 😊");
    } else {
      await sendText(chatId, `Your cart 🛒\n\n${formatCart(cart)}\n\nReply *checkout* to place your order!`);
    }
    return;
  }

  // ── CLEAR CART ──
  if (/^clear\s+cart$/i.test(userText.trim())) {
    client.cart = [];
    await db.saveClient(client);
    await sendText(chatId, "Cart cleared! 🛒 Start fresh and find your next pair 👟");
    return;
  }

  // ── ADD TO CART ──
  // Uses last product Maya mentioned — no dependency on AI tags
  if (isAddToCart(userText)) {
    const last = getLastMentioned(chatId);
    if (last) {
      addToCart(client, last);
      await db.saveClient(client);
      await sendText(chatId,
        `Added *${last.productName}* to your cart! 🛒\n\n${formatCart(client.cart)}\n\nReply *checkout* to order or keep browsing!`
      );
      client.addMessage('user', userText);
      client.addMessage('assistant', `Added ${last.productName} to cart`);
      await db.saveClient(client);
      return;
    } else {
      // No last product — ask AI to clarify which product
      await sendText(chatId, "Which sneaker would you like to add? Tell me the name or browse our catalog first 😊");
      return;
    }
  }

  // ── CHECKOUT ──
  if (/^checkout$/i.test(userText.trim())) {
    const cart = client.cart || [];
    if (!cart.length) {
      await sendText(chatId, "Your cart is empty! 🛒 Browse our catalog and add something you love 😊");
      return;
    }

    const { ok, outOfStock } = checkAvailability(
      cart.map((i) => ({ productId: i.productId, quantity: i.quantity }))
    );
    if (!ok) {
      await sendText(chatId, `Sorry, some items are out of stock: ${outOfStock.join(', ')}. Please remove them and try again.`);
      return;
    }

    const { order, paymentLink, totalAmount } = await placeOrder({
      waId: chatId,
      customerName: client.name,
      items: cart,
    });

    reduceStock(cart.map((i) => ({ productId: i.productId, quantity: i.quantity })));
    client.cart = [];
    client.segment = 'customer';
    client.addMessage('user', 'checkout');
    client.addMessage('assistant', `Order placed: ${order.orderId}`);
    await db.saveClient(client);

    let msg = `✅ Order *${order.orderId}* placed!\nTotal: Rs.${totalAmount.toLocaleString('en-IN')}`;
    msg += paymentLink
      ? `\n\n💳 Pay here: ${paymentLink}`
      : `\n\nPlease transfer Rs.${totalAmount} via UPI and share the screenshot here.`;
    await sendText(chatId, msg);
    return;
  }

  // ── ORDER TRACKING ──
  const trackMatch = userText.match(/(?:track|status|where is|order)\s+(TDP-\S+)/i);
  if (trackMatch) {
    const orderId = trackMatch[1].toUpperCase();
    const order = await db.getOrderById(orderId);
    if (order) {
      let msg = `📦 Order *${orderId}*\nStatus: *${order.status}*`;
      if (order.awbNumber) msg += `\nAWB: ${order.awbNumber} (${order.shippingProvider || 'Courier'})`;
      await sendText(chatId, msg);
    } else {
      await sendText(chatId, `I couldn't find order ${orderId}. Please double-check and try again!`);
    }
    return;
  }

  // ── AI CONVERSATION ──
  client.addMessage('user', userText);
  const { reply, intents, products } = await processMessage(client, userText);
  client.addMessage('assistant', reply);

  // Track last-mentioned product from AI reply
  // First check products from [INTENT:IMAGES] tags, then scan reply text
  if (products.length) {
    setLastMentioned(chatId, products[0]);
  } else {
    const mentioned = extractMentionedProducts(reply);
    if (mentioned.length) setLastMentioned(chatId, mentioned[0]);
  }

  // Also check if AI mentioned a product by name in reply
  if (!lastMentioned.get(chatId)) {
    const catalog = memoryStore.getCatalog();
    for (const p of catalog) {
      if (reply.toLowerCase().includes(p.name.toLowerCase())) {
        setLastMentioned(chatId, p);
        break;
      }
    }
  }

  await scoreActivity(chatId, intents, userText);
  await updateSegment(client);
  await db.saveClient(client);

  await sendText(chatId, reply);

  if (products.length) {
    await sendProductImages(chatId, products, 5);
    for (const p of products) await db.recordBrowseEvent(chatId, p);
  }

  if (intents.wantsBuy && client.cart?.length) {
    await sendButtons(chatId, 'Ready to grab these? 🛒', ['Checkout', 'Keep Browsing', 'Talk to Team']);
  }
}));

module.exports = router;
