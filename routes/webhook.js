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

// ── Update preferences from AI-detected context ───────────────────────────────
function updatePreferences(client, userText) {
  const lower = userText.toLowerCase();
  const brands = ['nike', 'adidas', 'puma', 'new balance', 'reebok', 'jordan', 'converse', 'vans', 'skechers', 'asics'];
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

  // Size detection: "size 8", "UK 9", "US 10"
  const sizeMatch = userText.match(/(?:size|uk|us|eu)?\s*(\d{1,2}(?:\.\d)?)/i);
  if (sizeMatch) {
    const sz = sizeMatch[1];
    if (!client.preferences.size?.includes(sz)) {
      client.preferences.size = [...(client.preferences.size || []), sz];
    }
  }

  // Budget detection: "under 2000", "budget 5000"
  const budgetMatch = userText.match(/(?:under|below|budget|max|upto|up to)\s*(?:rs\.?|₹|inr)?\s*(\d+)/i);
  if (budgetMatch) {
    client.preferences.priceMax = parseInt(budgetMatch[1], 10);
  }
}

// ── Lead scoring ──────────────────────────────────────────────────────────────
async function scoreActivity(waId, intents, userText) {
  let delta = 1; // base: sent a message
  if (intents.wantsBuy) delta += 5;
  if (intents.wantsImages.length) delta += 2;
  if (/price|cost|how much|₹|rs\.?/i.test(userText)) delta += 2;
  if (/buy|order|checkout|purchase/i.test(userText)) delta += 4;
  await db.incrementLeadScore(waId, delta);
}

// ── Segment update ─────────────────────────────────────────────────────────────
async function updateSegment(client) {
  let segment = 'new';
  if (client.leadScore >= 5) segment = 'warm';
  if (client.leadScore >= 15) segment = 'hot';
  // If they have a paid order, they're a customer – don't downgrade
  if (client.segment === 'customer') return;
  client.segment = segment;
}

// ── Cart helpers ──────────────────────────────────────────────────────────────
function parseCartFromText(userText, client) {
  // Look for "add to cart" intent with product ID references
  const addMatch = userText.match(/add\s+(?:product\s+)?([A-Za-z0-9_-]+)\s+(?:to\s+)?(?:my\s+)?cart/i);
  if (addMatch) {
    const product = memoryStore.findById(addMatch[1]);
    if (product) {
      client.cart = client.cart || [];
      const existing = client.cart.find((i) => i.productId === product.id);
      if (existing) {
        existing.quantity = (existing.quantity || 1) + 1;
      } else {
        client.cart.push({ productId: product.id, productName: product.name, price: product.price, quantity: 1, imageUrl: product.imageUrl });
      }
      client.lastCartActivity = new Date();
      client.cartAbandoned = false;
      return product;
    }
  }
  return null;
}

// ── Main webhook handler ───────────────────────────────────────────────────────

router.post('/', asyncHandler(async (req, res) => {
  // Green API sends updates as POST body
  const body = req.body;

  // Acknowledge immediately to avoid retries
  res.status(200).json({ ok: true });

  // ── Parse incoming message ──
  const messageData = body?.body;
  if (!messageData) return;

  const { senderData, messageData: msgData, typeWebhook } = messageData;
  if (typeWebhook !== 'incomingMessageReceived') return;

  const chatId = senderData?.chatId;
  const senderName = senderData?.senderName || '';
  if (!chatId || chatId.endsWith('@g.us')) return; // skip groups

  const msgType = msgData?.typeMessage;
  let userText = '';
  let imageUrl = null;

  if (msgType === 'textMessage') {
    userText = msgData?.textMessageData?.textMessage || '';
  } else if (msgType === 'imageMessage') {
    userText = msgData?.imageMessageData?.caption || 'I sent you an image';
    imageUrl = msgData?.imageMessageData?.jpegThumbnail || msgData?.imageMessageData?.downloadUrl || null;
  } else if (msgType === 'extendedTextMessage') {
    userText = msgData?.extendedTextMessageData?.text || '';
  } else {
    // Unsupported message type
    await sendText(chatId, "Hey! I can understand text and images 😊 How can I help you find the perfect pair?");
    return;
  }

  if (!userText && !imageUrl) return;

  logger.info('[Webhook] Message received', { chatId, msgType, preview: userText.slice(0, 60) });

  // ── Load / create client ──
  const client = await db.getOrCreateClient(chatId, senderName);

  // ── Handoff mode – route to human agent ──
  if (client.handoffActive) {
    await sendText(env.handoff.agentNumber, `[${client.name || chatId}] ${userText}`);
    return;
  }

  // ── Check for handoff trigger ──
  if (needsHandoff(userText)) {
    client.handoffActive = true;
    client.addMessage('user', userText);
    await db.saveClient(client);
    await sendText(chatId, "Sure! Connecting you with our team right away 🙌 Please hold on for a moment.");
    if (env.handoff.agentNumber) {
      await sendText(env.handoff.agentNumber, `🔔 Handoff request from ${client.name || chatId}\nMessage: ${userText}`);
    }
    return;
  }

  // ── Handle image upload (vision recognition) ──
  if (imageUrl) {
    await sendText(chatId, "Ooh, let me check out that sneaker! 👀🔍");
    const { identified, matches } = await matchSneakerFromImage(imageUrl);
    if (matches.length) {
      const idMsg = identified ? `Looks like a *${identified}* vibe! Here are the closest matches from our collection 👟` : "Here are some similar sneakers we carry 👟";
      await sendText(chatId, idMsg);
      await sendProductImages(chatId, matches, 4);
      const names = matches.map((p, i) => `${i + 1}. ${p.name} – ₹${p.price}`).join('\n');
      await sendText(chatId, `Which one catches your eye?\n${names}`);
    } else {
      await sendText(chatId, "Hmm, I couldn't find an exact match, but I'd love to help! Tell me the brand or style you're looking for 😊");
    }
    client.addMessage('user', userText);
    client.addMessage('assistant', identified ? `Matched image to: ${identified}` : 'No match found');
    await db.saveClient(client);
    return;
  }

  // ── Preference extraction ──
  updatePreferences(client, userText);

  // ── Add to cart if requested ──
  const addedProduct = parseCartFromText(userText, client);
  if (addedProduct) {
    await sendText(chatId, `Added *${addedProduct.name}* to your cart 🛒 Reply *checkout* to place your order, or keep browsing!`);
    client.addMessage('user', userText);
    client.addMessage('assistant', `Added ${addedProduct.name} to cart`);
    await db.saveClient(client);
    return;
  }

  // ── Checkout flow ──
  if (/^checkout$/i.test(userText.trim())) {
    const cart = client.cart || [];
    if (!cart.length) {
      await sendText(chatId, "Your cart is empty! 🛒 Browse our catalog and add something you love 😊");
      return;
    }

    const { ok, outOfStock } = checkAvailability(cart.map((i) => ({ productId: i.productId, quantity: i.quantity })));
    if (!ok) {
      await sendText(chatId, `Sorry, some items went out of stock: ${outOfStock.join(', ')}. Please remove them and try again.`);
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

    let msg = `✅ Order *${order.orderId}* placed!\nTotal: ₹${totalAmount.toLocaleString('en-IN')}`;
    if (paymentLink) {
      msg += `\n\n💳 Pay here: ${paymentLink}`;
    } else {
      msg += `\n\nPlease transfer ₹${totalAmount} via UPI and share the screenshot here.`;
    }
    await sendText(chatId, msg);
    return;
  }

  // ── Order tracking ──
  const trackMatch = userText.match(/(?:track|status|where is|order)\s+(TDP-\S+)/i);
  if (trackMatch) {
    const orderId = trackMatch[1].toUpperCase();
    const order = await db.getOrderById(orderId);
    if (order) {
      let statusMsg = `📦 Order *${orderId}*\nStatus: *${order.status}*`;
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

  // Update lead score & segment
  await scoreActivity(chatId, intents, userText);
  await updateSegment(client);
  await db.saveClient(client);

  // Send AI reply
  await sendText(chatId, reply);

  // Send product images if AI requested them
  if (products.length) {
    await sendProductImages(chatId, products, 5);
    // Record browse events
    for (const p of products) {
      await db.recordBrowseEvent(chatId, p);
    }
  }

  // If AI detected buy intent, nudge with checkout buttons
  if (intents.wantsBuy && client.cart?.length) {
    await sendButtons(chatId, 'Ready to grab these? 🛒', ['Checkout', 'Keep Browsing', 'Talk to Team']);
  }
}));

module.exports = router;
