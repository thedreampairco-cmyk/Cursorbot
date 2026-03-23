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

// ── Last mentioned product per chat ───────────────────────────────────────────
const lastMentioned = new Map();

function setLastMentioned(chatId, product) {
  if (!product) return;
  lastMentioned.set(chatId, {
    productId: String(product.id || product.productId),
    productName: product.name || product.productName,
    price: product.price,
    imageUrl: product.imageUrl || null,
  });
}

function getLastMentioned(chatId) {
  return lastMentioned.get(chatId) || null;
}

// ── Checkout session state ─────────────────────────────────────────────────────
// Tracks multi-step checkout per customer
// Steps: size → name → phone → address → confirm
const checkoutSessions = new Map();

function getSession(chatId) {
  return checkoutSessions.get(chatId) || null;
}

function setSession(chatId, data) {
  checkoutSessions.set(chatId, data);
}

function clearSession(chatId) {
  checkoutSessions.delete(chatId);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function needsHandoff(text) {
  const lower = text.toLowerCase();
  return env.handoff.triggerKeywords.some((kw) => lower.includes(kw));
}

function isAddToCart(text) {
  return /add\s*(to\s*)?cart|add\s*this|i('ll)?\s*take\s*(this|it)|buy\s*this|want\s*this|order\s*this|yes\s*add|add\s*it|cart\s*this|add\s*to\s*my/i.test(text);
}

function isCheckout(text) {
  return /checkout|place\s*order|confirm\s*order|buy\s*now|proceed\s*to\s*pay|complete.*order|finalize|i want to order|place my order/i.test(text);
}

function isViewCart(text) {
  return /^(my\s+)?cart$|^view\s+cart$|show.*cart|what.*in.*cart|my.*cart/i.test(text.trim());
}

function formatCart(cart) {
  if (!cart || !cart.length) return '(empty)';
  const lines = cart.map((i, idx) => `${idx + 1}. ${i.productName} x${i.quantity} – Rs.${i.price}`);
  const total = cart.reduce((s, i) => s + i.price * i.quantity, 0);
  return lines.join('\n') + `\n\nTotal: Rs.${total.toLocaleString('en-IN')}`;
}

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
  if (sizeMatch && !client.preferences.size?.includes(sizeMatch[1]))
    client.preferences.size = [...(client.preferences.size || []), sizeMatch[1]];
  const budgetMatch = userText.match(/(?:under|below|budget|max|upto|up to)\s*(?:rs\.?|inr)?\s*(\d+)/i);
  if (budgetMatch) client.preferences.priceMax = parseInt(budgetMatch[1], 10);
}

async function scoreActivity(waId, intents, userText) {
  let delta = 1;
  if (intents.wantsBuy) delta += 5;
  if (intents.wantsImages.length) delta += 2;
  if (/price|cost|how much|rs\.?/i.test(userText)) delta += 2;
  if (/buy|order|checkout|purchase/i.test(userText)) delta += 4;
  await db.incrementLeadScore(waId, delta);
}

async function updateSegment(client) {
  if (client.segment === 'customer') return;
  let segment = 'new';
  if (client.leadScore >= 5) segment = 'warm';
  if (client.leadScore >= 15) segment = 'hot';
  client.segment = segment;
}

function extractMentionedProducts(replyText) {
  const catalog = memoryStore.getCatalog();
  return catalog.filter((p) =>
    new RegExp(`\\[${p.id}\\]|\\b${p.id}\\b`).test(replyText)
  );
}

// ── CHECKOUT FLOW HANDLER ─────────────────────────────────────────────────────
async function handleCheckoutFlow(chatId, client, userText) {
  const session = getSession(chatId);

  // ── Step 0: Start checkout ──
  if (!session) {
    const cart = client.cart || [];
    if (!cart.length) {
      await sendText(chatId, "Your cart is empty! 🛒 Browse our catalog and add something you love 😊");
      return true;
    }

    // Check stock
    const { ok, outOfStock } = checkAvailability(
      cart.map((i) => ({ productId: i.productId, quantity: i.quantity }))
    );
    if (!ok) {
      await sendText(chatId, `Sorry, some items are out of stock: ${outOfStock.join(', ')}. Please remove them and try again.`);
      return true;
    }

    // Show cart summary and ask for size
    const cartText = formatCart(cart);
    setSession(chatId, { step: 'size', cart });

    await sendText(chatId,
      `Great! Let's place your order 🛍️\n\nYour cart:\n${cartText}\n\n` +
      `*Step 1 of 4*\nWhat *size* would you like? (e.g. UK 8, US 9)\n\n` +
      `_Reply with your shoe size_`
    );
    return true;
  }

  // ── Step 1: Collect size ──
  if (session.step === 'size') {
    const size = userText.trim();
    if (!size || size.length < 1) {
      await sendText(chatId, "Please enter a valid size (e.g. UK 8, US 9, EU 42) 👟");
      return true;
    }
    session.size = size;
    session.step = 'name';
    setSession(chatId, session);

    // Update cart items with size
    session.cart = session.cart.map((i) => ({ ...i, size }));

    await sendText(chatId,
      `Got it! Size *${size}* ✅\n\n` +
      `*Step 2 of 4*\nWhat is your *full name*?\n\n` +
      `_Reply with your name_`
    );
    return true;
  }

  // ── Step 2: Collect name ──
  if (session.step === 'name') {
    const name = userText.trim();
    if (!name || name.length < 2) {
      await sendText(chatId, "Please enter your full name 😊");
      return true;
    }
    session.name = name;
    session.step = 'phone';
    setSession(chatId, session);

    // Save name to client profile
    client.name = name;
    await db.saveClient(client);

    await sendText(chatId,
      `Nice to meet you, *${name}*! 👋\n\n` +
      `*Step 3 of 4*\nWhat is your *phone number*?\n\n` +
      `_Reply with your 10-digit mobile number_`
    );
    return true;
  }

  // ── Step 3: Collect phone ──
  if (session.step === 'phone') {
    const phone = userText.replace(/\s+/g, '').trim();
    const phoneDigits = phone.replace(/\D/g, '');
    if (phoneDigits.length < 10) {
      await sendText(chatId, "Please enter a valid 10-digit phone number 📱");
      return true;
    }
    session.phone = phoneDigits;
    session.step = 'address';
    setSession(chatId, session);

    await sendText(chatId,
      `*Step 4 of 4*\nWhat is your *delivery address*?\n\n` +
      `_Please include: House/Flat no, Street, City, State, Pincode_\n\n` +
      `Example: 42 MG Road, Bangalore, Karnataka, 560001`
    );
    return true;
  }

  // ── Step 4: Collect address ──
  if (session.step === 'address') {
    const address = userText.trim();
    if (!address || address.length < 10) {
      await sendText(chatId, "Please enter your complete delivery address including city and pincode 📍");
      return true;
    }
    session.address = address;
    session.step = 'confirm';
    setSession(chatId, session);

    // Parse pincode from address
    const pincodeMatch = address.match(/\b(\d{6})\b/);
    const pincode = pincodeMatch ? pincodeMatch[1] : '';

    const cartText = session.cart.map((i, idx) =>
      `${idx + 1}. ${i.productName} (Size: ${session.size}) x${i.quantity} – Rs.${i.price}`
    ).join('\n');
    const total = session.cart.reduce((s, i) => s + i.price * i.quantity, 0);

    await sendText(chatId,
      `📋 *Order Summary*\n\n` +
      `👟 Items:\n${cartText}\n\n` +
      `💰 Total: *Rs.${total.toLocaleString('en-IN')}*\n\n` +
      `👤 Name: ${session.name}\n` +
      `📱 Phone: ${session.phone}\n` +
      `📍 Address: ${session.address}\n\n` +
      `Reply *CONFIRM* to place your order\nReply *CANCEL* to cancel`
    );
    return true;
  }

  // ── Step 5: Confirm or cancel ──
  if (session.step === 'confirm') {
    if (/^cancel$/i.test(userText.trim())) {
      clearSession(chatId);
      await sendText(chatId, "Order cancelled. Your cart is still saved — reply *checkout* anytime to try again! 😊");
      return true;
    }

    if (!/^confirm$/i.test(userText.trim())) {
      await sendText(chatId, "Please reply *CONFIRM* to place your order or *CANCEL* to cancel 😊");
      return true;
    }

    // ── Place the order ──
    const pincodeMatch = session.address.match(/\b(\d{6})\b/);
    const cityMatch = session.address.match(/,\s*([^,]+),\s*[^,]+,\s*\d{6}/);

    const shippingAddress = {
      line1: session.address,
      city: cityMatch ? cityMatch[1].trim() : '',
      state: '',
      pincode: pincodeMatch ? pincodeMatch[1] : '',
    };

    // Add size to each cart item
    const itemsWithSize = session.cart.map((i) => ({ ...i, size: session.size }));

    const { order, paymentLink, totalAmount } = await placeOrder({
      waId: chatId,
      customerName: session.name,
      items: itemsWithSize,
      shippingAddress,
      notes: `Phone: ${session.phone}`,
    });

    reduceStock(itemsWithSize.map((i) => ({ productId: i.productId, quantity: i.quantity })));

    client.cart = [];
    client.name = session.name;
    client.segment = 'customer';
    client.addMessage('user', 'CONFIRM');
    client.addMessage('assistant', `Order placed: ${order.orderId}`);
    await db.saveClient(client);

    clearSession(chatId);

    let msg =
      `✅ *Order Confirmed!*\n\n` +
      `📦 Order ID: *${order.orderId}*\n` +
      `💰 Total: *Rs.${totalAmount.toLocaleString('en-IN')}*\n\n`;

    if (paymentLink) {
      msg += `💳 *Pay here:*\n${paymentLink}\n\n`;
    } else {
      msg += `💳 *Payment:*\nPlease transfer Rs.${totalAmount} via UPI to our number and share the screenshot here.\n\n`;
    }

    msg += `📍 Delivering to: ${session.address}\n\n`;
    msg += `We'll send you the tracking details once your order is shipped! 🚚\nThank you for shopping with The Dream Pair! 👟✨`;

    await sendText(chatId, msg);
    return true;
  }

  return false;
}

// ── MAIN WEBHOOK ──────────────────────────────────────────────────────────────
router.post('/', asyncHandler(async (req, res) => {
  res.status(200).json({ ok: true });

  const body = req.body;
  logger.debug('[Webhook] Raw payload', { body: JSON.stringify(body).slice(0, 500) });

  const payload     = body?.body || body;
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

  // ── Active checkout session — pipe all messages to checkout flow ──
  const session = getSession(chatId);
  if (session) {
    await handleCheckoutFlow(chatId, client, userText);
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
  if (isViewCart(userText)) {
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
    } else {
      await sendText(chatId, "Which sneaker would you like to add? Tell me the name or browse our catalog first 😊");
    }
    return;
  }

  // ── CHECKOUT TRIGGER ──
  if (isCheckout(userText)) {
    await handleCheckoutFlow(chatId, client, userText);
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

  // Track last mentioned product
  if (products.length) {
    setLastMentioned(chatId, products[0]);
  } else {
    const mentioned = extractMentionedProducts(reply);
    if (mentioned.length) setLastMentioned(chatId, mentioned[0]);
    else {
      const catalog = memoryStore.getCatalog();
      for (const p of catalog) {
        if (reply.toLowerCase().includes(p.name.toLowerCase())) {
          setLastMentioned(chatId, p);
          break;
        }
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
