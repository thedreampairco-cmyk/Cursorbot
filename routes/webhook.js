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

// ── Handoff detection ─────────────────────────────────────────────────────────
function needsHandoff(text) {
  const lower = text.toLowerCase();
  return env.handoff.triggerKeywords.some((kw) => lower.includes(kw));
}

// ── Update preferences from message text ─────────────────────────────────────
function updatePreferences(client, userText) {
  const lower = userText.toLowerCase();
  const brands = ['nike', 'adidas', 'puma', 'new balance', 'reebok', 'jordan', 'converse', 'vans', 'skechers', 'asics', 'onitsuka'];
  const colors = ['black', 'white', 'red', 'blue', 'green', 'grey', 'gray', 'pink', 'yellow', 'brown'];

  brands.forEach((b) => {
    if (lower.includes(b) && !client.preferences.brand?.includes(b)) {
      client.preferences.brand = [...(client.preferences.brand || []), b];
    }
  });
  colors.forEach((c) => {
    if (lower.includes(c) && !client.preferences.color?.includes(c)) {
      client.preferences.color = [...(client.preferences.color || []), c];
    }
  });

  const sizeMatch = userText.match(/(?:size|uk|us|eu)?\s*(\d{1,2}(?:\.\d)?)/i);
  if (sizeMatch) {
    const sz = sizeMatch[1];
    if (!client.preferences.size?.includes(sz)) {
      client.preferences.size = [...(client.preferences.size || []), sz];
    }
  }

  const budgetMatch = userText.match(/(?:under|below|budget|max|upto|up to)\s*(?:rs\.?|inr)?\s*(\d+)/i);
  if (budgetMatch) {
    client.preferences.priceMax = parseInt(budgetMatch[1], 10);
  }
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

// ── Add a product to the client's real cart ───────────────────────────────────
function addToCart(client, product) {
  client.cart = client.cart || [];
  const existing = client.cart.find((i) => i.productId === String(product.id));
  if (existing) {
    existing.quantity = (existing.quantity || 1) + 1;
  } else {
    client.cart.push({
      productId: String(product.id),
      productName: product.name,
      price: product.price,
      quantity: 1,
      imageUrl: product.imageUrl || null,
    });
  }
  client.lastCartActivity = new Date();
  client.cartAbandoned = false;
  return product;
}

// ── Parse explicit "add PRODUCT_ID to cart" from user text ───────────────────
function parseCartFromText(userText, client) {
  const addMatch = userText.match(/add\s+(?:product\s+)?([A-Za-z0-9_-]+)\s+(?:to\s+)?(?:my\s+)?cart/i);
  if (addMatch) {
    const product = memoryStore.findById(addMatch[1]);
    if (product) return addToCart(client, product);
  }
  return null;
}

// ── Extract [INTENT:CART:id1,id2] tags from AI reply ─────────────────────────
function extractCartIntent(text) {
  const match = text.match(/\[INTENT:CART:([^\]]+)\]/);
  return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

// ── Format cart summary ───────────────────────────────────────────────────────
function formatCart(cart) {
  if (!cart || !cart.length) return 'empty';
  return cart.map((i, idx) => `${idx + 1}. ${i.productName} x${i.quantity} – Rs.${i.price}`).join('\n');
}

// ── Main webhook handler ───────────────────────────────────────────────────────
router.post('/', asyncHandler(async (req, res) => {
  res.status(200).json({ ok: true });

  const body = req.body;
  logger.debug('[Webhook] Raw payload', { body: JSON.stringify(body).slice(0, 500) });

  // Green API sends: { body: { typeWebhook, senderData, messageData } }
  // or flat:         { typeWebhook, senderData, messageData }
  const payload = body?.body || body;

  const typeWebhook = payload?.typeWebhook;
  const senderData  = payload?.senderData;
  const msgData     = payload?.messageData;

  if (!typeWebhook) return;
  if (typeWebhook !== 'incomingMessageReceived') return;

  const chatId     = senderData?.chatId || senderData?.sender;
  const senderName = senderData?.senderName || senderData?.pushname || '';

  if (!chatId) { logger.warn('[Webhook] No chatId'); return; }
  if (chatId.endsWith('@g.us')) return; // skip groups

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

  logger.info('[Webhook] Message received', { chatId, msgType, preview: userText.slice(0, 60) });

  // ── Load or create client ──
  const client = await db.getOrCreateClient(chatId, senderName);

  // ── Handoff mode ──
  if (client.handoffActive) {
    if (env.handoff.agentNumber) {
      await sendText(env.handoff.agentNumber, `[${client.name || chatId}] ${userText}`);
    }
    return;
  }

  // ── Handoff trigger ──
  if (needsHandoff(userText)) {
    client.handoffActive = true;
    client.addMessage('user', userText);
    await db.saveClient(client);
    await sendText(chatId, "Sure! Connecting you with our team right away 🙌 Please hold on.");
    if (env.handoff.agentNumber) {
      await sendText(env.handoff.agentNumber, `Handoff request from ${client.name || chatId}: ${userText}`);
    }
    return;
  }

  // ── Image upload (vision) ──
  if (imageUrl) {
    await sendText(chatId, "Ooh, let me check out that sneaker! 👀🔍");
    const { identified, matches } = await matchSneakerFromImage(imageUrl);
    if (matches.length) {
      const idMsg = identified
        ? `Looks like a *${identified}* vibe! Here are the closest matches 👟`
        : "Here are some similar sneakers we carry 👟";
      await sendText(chatId, idMsg);
      await sendProductImages(chatId, matches, 4);
      const names = matches.map((p, i) => `${i + 1}. ${p.name} – Rs.${p.price}`).join('\n');
      await sendText(chatId, `Which one catches your eye?\n${names}`);
    } else {
      await sendText(chatId, "Hmm, couldn't find an exact match! Tell me the brand or style you're looking for 😊");
    }
    client.addMessage('user', userText);
    client.addMessage('assistant', identified ? `Matched: ${identified}` : 'No match found');
    await db.saveClient(client);
    return;
  }

  // ── Preference extraction ──
  updatePreferences(client, userText);

  // ── Explicit "add PRODUCT_ID to cart" from user ──
  const addedProduct = parseCartFromText(userText, client);
  if (addedProduct) {
    await sendText(chatId,
      `Added *${addedProduct.name}* to your cart! 🛒\n\nYour cart:\n${formatCart(client.cart)}\n\nReply *checkout* to order or keep browsing!`
    );
    client.addMessage('user', userText);
    client.addMessage('assistant', `Added ${addedProduct.name} to cart`);
    await db.saveClient(client);
    return;
  }

  // ── Checkout ──
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
      await sendText(chatId, `Sorry, some items went out of stock: ${outOfStock.join(', ')}. Please try again.`);
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

    let msg = `Order *${order.orderId}* placed!\nTotal: Rs.${totalAmount.toLocaleString('en-IN')}`;
    if (paymentLink) {
      msg += `\n\nPay here: ${paymentLink}`;
    } else {
      msg += `\n\nPlease transfer Rs.${totalAmount} via UPI and share the screenshot here.`;
    }
    await sendText(chatId, msg);
    return;
  }

  // ── View cart ──
  if (/^(my\s+)?cart$/i.test(userText.trim()) || /^view\s+cart$/i.test(userText.trim())) {
    const cart = client.cart || [];
    if (!cart.length) {
      await sendText(chatId, "Your cart is empty! 🛒 Browse our sneakers and add something you love 😊");
    } else {
      const total = cart.reduce((s, i) => s + i.price * i.quantity, 0);
      await sendText(chatId, `Your cart 🛒\n\n${formatCart(cart)}\n\nTotal: Rs.${total.toLocaleString('en-IN')}\n\nReply *checkout* to place your order!`);
    }
    return;
  }

  // ── Clear cart ──
  if (/^clear\s+cart$/i.test(userText.trim())) {
    client.cart = [];
    await db.saveClient(client);
    await sendText(chatId, "Cart cleared! 🛒 Start fresh and find your next pair 👟");
    return;
  }

  // ── Order tracking ──
  const trackMatch = userText.match(/(?:track|status|where is|order)\s+(TDP-\S+)/i);
  if (trackMatch) {
    const orderId = trackMatch[1].toUpperCase();
    const order = await db.getOrderById(orderId);
    if (order) {
      let statusMsg = `Order *${orderId}*\nStatus: *${order.status}*`;
      if (order.awbNumber) statusMsg += `\nAWB: ${order.awbNumber} (${order.shippingProvider || 'Courier'})`;
      await sendText(chatId, statusMsg);
    } else {
      await sendText(chatId, `I couldn't find order ${orderId}. Please double-check and try again!`);
    }
    return;
  }

  // ── AI conversation ──
  client.addMessage('user', userText);
  const { reply, intents, products } = await processMessage(client, userText);
  client.addMessage('assistant', reply);

  // ── Handle AI-detected cart additions [INTENT:CART:id1,id2] ──
  const cartIds = extractCartIntent(reply);
  const cartAdded = [];
  for (const id of cartIds) {
    const product = memoryStore.findById(id);
    if (product) {
      addToCart(client, product);
      cartAdded.push(product.name);
    }
  }

  await scoreActivity(chatId, intents, userText);
  await updateSegment(client);
  await db.saveClient(client);

  // Send AI reply
  await sendText(chatId, reply);

  // Confirm cart additions
  if (cartAdded.length) {
    await sendText(chatId,
      `Added to cart: ${cartAdded.join(', ')} 🛒\n\nYour cart:\n${formatCart(client.cart)}\n\nReply *checkout* to order!`
    );
  }

  // Send product images
  if (products.length) {
    await sendProductImages(chatId, products, 5);
    for (const p of products) {
      await db.recordBrowseEvent(chatId, p);
    }
  }

  // Buy intent nudge
  if (intents.wantsBuy && client.cart?.length) {
    await sendButtons(chatId, 'Ready to grab these? 🛒', ['Checkout', 'Keep Browsing', 'Talk to Team']);
  }
}));

module.exports = router;
