'use strict';

const express = require('express');
const router = express.Router();
const { asyncHandler, logger } = require('../errorHandler');
const db = require('../services/data/databaseService');
const { processMessage } = require('../services/ai/aiIntegration');
const { sendText, sendButtons } = require('../services/whatsapp/greenApiText');
const { sendProductImages } = require('../services/whatsapp/greenApiMedia');
const { matchSneakerFromImage, findMatchesByDescription } = require('../services/features/visionRecognition');
const { reduceStock, checkAvailability } = require('../services/features/inventoryService');
const { placeOrder } = require('../services/data/orderStore');
const memoryStore = require('../services/data/memoryStore');
const env = require('../config/env');

// ── Helpers ───────────────────────────────────────────────────────────────────
function needsHandoff(text) {
  return env.handoff.triggerKeywords.some((kw) => text.toLowerCase().includes(kw));
}

function isAddToCart(text) {
  return /add\s*(to\s*)?cart|add\s*this|i('ll)?\s*take\s*(this|it)|buy\s*this|want\s*this|order\s*this|yes\s*add|add\s*it/i.test(text);
}

function isCheckout(text) {
  return /^checkout$|place\s*order|confirm\s*order|buy\s*now|proceed\s*to\s*pay|i want to order|place my order/i.test(text.trim());
}

function isViewCart(text) {
  return /^(my\s+)?cart$|^view\s+cart$|show.*cart|what.*in.*cart|my.*cart/i.test(text.trim());
}

function formatCart(cart) {
  if (!cart || !cart.length) return '(empty)';
  const lines = cart.map((i, idx) => `${idx + 1}. ${i.productName} x${i.quantity} – Rs.${i.price}`);
  const total = cart.reduce((s, i) => s + i.price * (i.quantity || 1), 0);
  return lines.join('\n') + `\n\nTotal: Rs.${total.toLocaleString('en-IN')}`;
}

function addToCart(client, product) {
  if (!Array.isArray(client.cart)) client.cart = [];
  const pid = String(product.productId || product.id);
  const existing = client.cart.find((i) => i.productId === pid);
  if (existing) {
    existing.quantity = (existing.quantity || 1) + 1;
  } else {
    client.cart.push({
      productId: pid,
      productName: product.productName || product.name,
      price: product.price,
      quantity: 1,
      imageUrl: product.imageUrl || null,
    });
  }
  client.lastCartActivity = new Date();
  client.cartAbandoned = false;
  client.markModified('cart');
}

function updatePreferences(client, userText) {
  const lower = userText.toLowerCase();
  const brands = ['nike','adidas','puma','new balance','reebok','jordan','converse','vans','skechers','asics','onitsuka'];
  const colors = ['black','white','red','blue','green','grey','gray','pink','yellow','brown'];
  brands.forEach((b) => {
    if (lower.includes(b) && !client.preferences.brand?.includes(b))
      client.preferences.brand = [...(client.preferences.brand || []), b];
  });
  colors.forEach((c) => {
    if (lower.includes(c) && !client.preferences.color?.includes(c))
      client.preferences.color = [...(client.preferences.color || []), c];
  });
  const sm = userText.match(/(?:size|uk|us|eu)?\s*(\d{1,2}(?:\.\d)?)/i);
  if (sm && !client.preferences.size?.includes(sm[1]))
    client.preferences.size = [...(client.preferences.size || []), sm[1]];
  const bm = userText.match(/(?:under|below|budget|max|upto|up to)\s*(?:rs\.?|inr)?\s*(\d+)/i);
  if (bm) client.preferences.priceMax = parseInt(bm[1], 10);
}

async function scoreActivity(waId, intents, userText) {
  let delta = 1;
  if (intents.wantsBuy) delta += 5;
  if (intents.wantsImages?.length) delta += 2;
  if (/price|cost|how much|rs\.?/i.test(userText)) delta += 2;
  if (/buy|order|checkout|purchase/i.test(userText)) delta += 4;
  await db.incrementLeadScore(waId, delta);
}

async function updateSegment(client) {
  if (client.segment === 'customer') return;
  if (client.leadScore >= 15) client.segment = 'hot';
  else if (client.leadScore >= 5) client.segment = 'warm';
  else client.segment = 'new';
}

// ── CHECKOUT FLOW ─────────────────────────────────────────────────────────────
async function handleCheckoutFlow(chatId, client, userText) {
  const session = client.checkoutSession;

  // ── Start checkout ──
  if (!session) {
    const cart = client.cart || [];
    if (!cart.length) {
      await sendText(chatId, "Your cart is empty! 🛒 Browse our catalog and add something you love 😊");
      return true;
    }
    const { ok, outOfStock } = checkAvailability(
      cart.map((i) => ({ productId: i.productId, quantity: i.quantity || 1 }))
    );
    if (!ok) {
      await sendText(chatId, `Sorry, some items are out of stock: ${outOfStock.join(', ')}. Please clear your cart and try again.`);
      return true;
    }

    client.checkoutSession = { step: 'size', cart };
    client.markModified('checkoutSession');
    await db.saveClient(client);

    await sendText(chatId,
      `Great! Let's place your order 🛍️\n\n` +
      `Your cart:\n${formatCart(cart)}\n\n` +
      `*Step 1 of 4* — What *shoe size* would you like?\n` +
      `_(e.g. UK 8, US 9, EU 42)_`
    );
    return true;
  }

  // ── Step 1: Size ──
  if (session.step === 'size') {
    const size = userText.trim();
    if (!size) { await sendText(chatId, "Please enter your shoe size (e.g. UK 8) 👟"); return true; }
    session.size = size;
    session.step = 'name';
    session.cart = session.cart.map((i) => ({ ...i, size }));
    client.checkoutSession = session;
    client.markModified('checkoutSession');
    await db.saveClient(client);
    await sendText(chatId, `Size *${size}* ✅\n\n*Step 2 of 4* — What is your *full name*?`);
    return true;
  }

  // ── Step 2: Name ──
  if (session.step === 'name') {
    const name = userText.trim();
    if (name.length < 2) { await sendText(chatId, "Please enter your full name 😊"); return true; }
    session.name = name;
    session.step = 'phone';
    client.name = name;
    client.checkoutSession = session;
    client.markModified('checkoutSession');
    await db.saveClient(client);
    await sendText(chatId, `Nice to meet you, *${name}*! 👋\n\n*Step 3 of 4* — What is your *phone number*?\n_(10-digit mobile number)_`);
    return true;
  }

  // ── Step 3: Phone ──
  if (session.step === 'phone') {
    const digits = userText.replace(/\D/g, '');
    if (digits.length < 10) { await sendText(chatId, "Please enter a valid 10-digit phone number 📱"); return true; }
    session.phone = digits;
    session.step = 'address';
    client.checkoutSession = session;
    client.markModified('checkoutSession');
    await db.saveClient(client);
    await sendText(chatId,
      `*Step 4 of 4* — What is your *delivery address*?\n\n` +
      `_Include: House/Flat no, Street, City, State, Pincode_\n` +
      `Example: 42 MG Road, Bangalore, Karnataka, 560001`
    );
    return true;
  }

  // ── Step 4: Address ──
  if (session.step === 'address') {
    const address = userText.trim();
    if (address.length < 10) { await sendText(chatId, "Please enter your complete address with city and pincode 📍"); return true; }
    session.address = address;
    session.step = 'confirm';
    client.checkoutSession = session;
    client.markModified('checkoutSession');
    await db.saveClient(client);

    const cartText = session.cart.map((i, idx) =>
      `${idx + 1}. ${i.productName} (Size: ${session.size}) x${i.quantity || 1} – Rs.${i.price}`
    ).join('\n');
    const total = session.cart.reduce((s, i) => s + i.price * (i.quantity || 1), 0);

    await sendText(chatId,
      `📋 *Order Summary*\n\n` +
      `👟 *Items:*\n${cartText}\n\n` +
      `💰 *Total: Rs.${total.toLocaleString('en-IN')}*\n\n` +
      `👤 Name: ${session.name}\n` +
      `📱 Phone: ${session.phone}\n` +
      `📍 Address: ${session.address}\n\n` +
      `Reply *CONFIRM* to place your order\n` +
      `Reply *CANCEL* to cancel`
    );
    return true;
  }

  // ── Step 5: Confirm / Cancel ──
  if (session.step === 'confirm') {
    if (/^cancel$/i.test(userText.trim())) {
      client.checkoutSession = null;
      client.markModified('checkoutSession');
      await db.saveClient(client);
      await sendText(chatId, "Order cancelled. Your cart is still saved — reply *checkout* anytime to try again! 😊");
      return true;
    }
    if (!/^confirm$/i.test(userText.trim())) {
      await sendText(chatId, "Please reply *CONFIRM* to place your order or *CANCEL* to cancel 😊");
      return true;
    }

    // Place the order
    const pincodeMatch = session.address.match(/\b(\d{6})\b/);
    const shippingAddress = {
      line1: session.address,
      pincode: pincodeMatch ? pincodeMatch[1] : '',
    };

    const { order, paymentLink, totalAmount } = await placeOrder({
      waId: chatId,
      customerName: session.name,
      items: session.cart,
      shippingAddress,
      notes: `Phone: ${session.phone}`,
    });

    reduceStock(session.cart.map((i) => ({ productId: i.productId, quantity: i.quantity || 1 })));

    client.cart = [];
    client.checkoutSession = null;
    client.segment = 'customer';
    client.markModified('cart');
    client.markModified('checkoutSession');
    client.addMessage('user', 'CONFIRM');
    client.addMessage('assistant', `Order placed: ${order.orderId}`);
    await db.saveClient(client);

    let msg =
      `✅ *Order Confirmed!*\n\n` +
      `📦 Order ID: *${order.orderId}*\n` +
      `💰 Total: *Rs.${totalAmount.toLocaleString('en-IN')}*\n\n`;
    msg += paymentLink
      ? `💳 *Pay here:*\n${paymentLink}\n\n`
      : `💳 *Payment:*\nPlease transfer Rs.${totalAmount} via UPI and share the screenshot here.\n\n`;
    msg += `📍 Delivering to: ${session.address}\n\n`;
    msg += `We'll send tracking details once shipped! 🚚\nThank you for shopping with The Dream Pair! 👟✨`;

    await sendText(chatId, msg);
    return true;
  }

  return false;
}

// ── MAIN WEBHOOK ──────────────────────────────────────────────────────────────
router.post('/', asyncHandler(async (req, res) => {
  res.status(200).json({ ok: true });

  const body    = req.body;
  const payload = body?.body || body;

  const typeWebhook = payload?.typeWebhook;
  const senderData  = payload?.senderData;
  const msgData     = payload?.messageData;

  if (!typeWebhook || typeWebhook !== 'incomingMessageReceived') return;

  const chatId     = senderData?.chatId || senderData?.sender;
  const senderName = senderData?.senderName || senderData?.pushname || '';

  if (!chatId || chatId.endsWith('@g.us')) return;

  const msgType = msgData?.typeMessage;
  let userText  = "";
  let imageUrl  = null;
  let isImage   = false;
  let jpegThumb = null;

  if (msgType === "textMessage") {
    userText = msgData?.textMessageData?.textMessage || "";
  } else if (msgType === "imageMessage") {
    isImage  = true;
    userText = msgData?.imageMessageData?.caption || "";

    // Extract all possible image fields from Green API payload
    const imgData = msgData?.imageMessageData || {};

    // Green API sometimes puts URL directly in imageMessageData
    imageUrl = imgData.downloadUrl
            || imgData.url
            || imgData.fileUrl
            || imgData.mediaUrl
            || imgData.linkToFile
            || imgData.urlFile
            || null;

    // jpegThumbnail is base64 — always present as fallback
    jpegThumb = imgData.jpegThumbnail || null;

    // idMessage can be at root payload level or inside msgData
    const idMessage = payload?.idMessage || msgData?.idMessage || null;

    // Fetch real download URL from Green API if not in payload
    if (!imageUrl && idMessage) {
      try {
        const BASE = env.greenApi.baseUrl || 'https://api.greenapi.com';
        const INST = env.greenApi.instanceId;
        const TOK  = env.greenApi.token;

        logger.info("[Webhook] Fetching image URL via getFileByIdMessage", { idMessage });

        const dlRes = await require('axios').post(
          `${BASE}/waInstance${INST}/getFileByIdMessage/${TOK}`,
          { chatId, idMessage },
          { timeout: 10000 }
        );

        imageUrl = dlRes.data?.downloadUrl
                || dlRes.data?.fileUrl
                || dlRes.data?.url
                || dlRes.data?.urlFile
                || null;

        logger.info("[Webhook] getFileByIdMessage response", {
          found: !!imageUrl,
          keys: dlRes.data ? Object.keys(dlRes.data) : [],
          url: imageUrl?.slice(0, 80)
        });

      } catch (dlErr) {
        logger.warn("[Webhook] getFileByIdMessage failed", {
          error: dlErr.message,
          status: dlErr?.response?.status,
          data: JSON.stringify(dlErr?.response?.data)
        });
      }
    }

    logger.info("[Webhook] Image received", {
      chatId,
      hasUrl: !!imageUrl,
      hasThumb: !!jpegThumb,
      idMessage,
      imageDataKeys: Object.keys(imgData),
      RAW: JSON.stringify(imgData).slice(0, 400)
    });
  } else if (msgType === "extendedTextMessage") {
    userText = msgData?.extendedTextMessageData?.text || "";
  } else if (msgType === "quotedMessage") {
    userText = msgData?.extendedTextMessageData?.text || msgData?.textMessageData?.textMessage || "";
  } else {
    await sendText(chatId, "Hey! I can understand text and images 😊 How can I help you find your perfect pair?");
    return;
  }

  if (!userText && !isImage) return;

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

  // ── Active checkout session — all messages go to checkout flow ──
  if (client.checkoutSession) {
    await handleCheckoutFlow(chatId, client, userText);
    return;
  }

  // ── Image upload ──
  if (isImage) {
    await sendText(chatId, "Ooh, let me analyse that sneaker! 👀🔍");

    const { identified, matches, noUrl } = await matchSneakerFromImage(imageUrl || jpegThumb, !!jpegThumb && !imageUrl);

    if (noUrl) {
      await sendText(chatId,
        "I received your image but couldn't process it directly.\n\n" +
        "Could you tell me the *brand* and *style*? (e.g. Nike Air Max, Adidas Samba)\n" +
        "I'll find the closest match from our collection! 🔍"
      );
    } else if (matches.length) {
      const intro = identified
        ? `Looks like a *${identified}*! Here are the closest matches 👟`
        : "Here are some similar sneakers we carry 👟";
      await sendText(chatId, intro);
      await sendProductImages(chatId, matches, 4);
      const list = matches.map((p, i) => `${i + 1}. ${p.name} – Rs.${p.price}`).join('\n');
      await sendText(chatId, list + "\n\nWould you like to add any of these to your cart? 🛍️");
      client.lastMentionedProduct = {
        productId: String(matches[0].id),
        productName: matches[0].name,
        price: matches[0].price,
        imageUrl: matches[0].imageUrl || null,
      };
      client.markModified('lastMentionedProduct');
    } else {
      await sendText(chatId,
        "Hmm, I couldn't find an exact match in our catalog! 😊\n\n" +
        "Tell me the *brand* or *style* and I'll search for you! 👟"
      );
    }

    client.addMessage('user', userText || '[image]');
    client.addMessage('assistant', identified ? `Vision matched: ${identified}` : 'No vision match');
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
    client.markModified('cart');
    await db.saveClient(client);
    await sendText(chatId, "Cart cleared! 🛒 Start fresh and find your next pair 👟");
    return;
  }

  // ── ADD TO CART ──
  if (isAddToCart(userText)) {
    const last = client.lastMentionedProduct;
    if (last) {
      addToCart(client, last);
      client.addMessage('user', userText);
      client.addMessage('assistant', `Added ${last.productName} to cart`);
      await db.saveClient(client);
      await sendText(chatId,
        `Added *${last.productName}* to your cart! 🛒\n\n${formatCart(client.cart)}\n\nReply *checkout* to order or keep browsing!`
      );
    } else {
      await sendText(chatId, "Which sneaker would you like to add? Browse our catalog first and I'll add it for you 😊");
    }
    return;
  }

  // ── CHECKOUT ──
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

  // Save last mentioned product to MongoDB
  if (products.length) {
    const p = products[0];
    client.lastMentionedProduct = { productId: String(p.id), productName: p.name, price: p.price, imageUrl: p.imageUrl || null };
    client.markModified('lastMentionedProduct');
  } else {
    // Scan reply text for product names
    const catalog = memoryStore.getCatalog();
    for (const p of catalog) {
      if (reply.toLowerCase().includes(p.name.toLowerCase())) {
        client.lastMentionedProduct = { productId: String(p.id), productName: p.name, price: p.price, imageUrl: p.imageUrl || null };
        client.markModified('lastMentionedProduct');
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
