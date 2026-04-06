// services/features/intentService.js
"use strict";

const { logger }                   = require("../../errorHandler");
const {
  classifyIntent,
  detectLanguage,
  generateResponse,
  MAYA_SYSTEM_PROMPT,
}                                  = require("../aiIntegration");
const {
  searchProducts,
  getProductBySku,
  getAvailableSizes,
  getCategorySummary,
  getPersonalisedRecommendations,
}                                  = require("./inventoryService");
const {
  getSession,
  updateSession,
  getConversationState,
  setConversationState,
  updateConversationPayload,
  getCart,
  formatCartMessage,
  getCartTotal,
  getUserPrefs,
  setUserPrefs,
}                                  = require("../memoryStore");

// ─── Intent Definitions ───────────────────────────────────────────────────────

const VALID_INTENTS = [
  "browse_catalog",
  "search_product",
  "image_search",
  "add_to_cart",
  "view_cart",
  "checkout",
  "payment_query",
  "order_status",
  "return_exchange",
  "size_help",
  "human_agent",
  "greeting",
  "farewell",
  "unknown",
];

/**
 * Append a message to the phone's session history (max 20 entries retained).
 * FIXED: Coerces text to string before storage — prevents object bleed into Groq content field.
 * @param {string} phone
 * @param {"user"|"assistant"} role
 * @param {string|object} text
 */
function _appendHistory(phone, role, text) {
  const session = getSession(phone) || {};
  const history = Array.isArray(session.history) ? session.history : [];

  // ── CRITICAL FIX ──────────────────────────────────────────────────────────
  // If a handler accidentally returns an object (e.g. { reply, intents, products })
  // and the caller passes result instead of result.response, coerce it safely.
  let safeText;
  if (typeof text === "string") {
    safeText = text;
  } else if (text && typeof text === "object") {
    // Extract the reply field if it exists, otherwise stringify the whole thing
    safeText =
      typeof text.reply    === "string" ? text.reply    :
      typeof text.response === "string" ? text.response :
      JSON.stringify(text);
    logger.warn(
      `[Intent] _appendHistory received an object instead of a string for role="${role}". ` +
      `Extracted: "${safeText.slice(0, 60)}..."`
    );
  } else {
    safeText = String(text ?? "");
  }
  // ── END FIX ───────────────────────────────────────────────────────────────

  history.push({ role, text: safeText, ts: Date.now() });
  if (history.length > 20) history.splice(0, history.length - 20);
  updateSession(phone, { ...session, history });
}

/**
 * Build a 2-turn prior context array from the session for intent classification.
 * FIXED: Sanitizes each entry to guarantee string output.
 * @param {string} phone
 * @returns {string[]}
 */
function _buildPriorContext(phone) {
  const session = getSession(phone);
  if (!session || !Array.isArray(session.history)) return [];
  return session.history
    .slice(-4)
    .map((h) => {
      // ── CRITICAL FIX ──────────────────────────────────────────────────────
      const text =
        typeof h.text === "string"   ? h.text :
        typeof h.text === "object"   ? (h.text?.reply || h.text?.response || JSON.stringify(h.text)) :
        String(h.text ?? "");
      // ── END FIX ───────────────────────────────────────────────────────────
      return `${h.role === "user" ? "Customer" : "Maya"}: ${text}`;
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Classify an incoming customer message into a structured intent.
 * Merges Groq's classification with local heuristic overrides for speed-critical paths.
 *
 * @param {string}   phone
 * @param {string}   message
 * @returns {Promise<{
 *   intent:     string,
 *   confidence: number,
 *   entities:   { brand: string|null, size: string|null, sku: string|null, category: string|null },
 *   language:   string
 * }>}
 */
async function extractIntent(phone, message) {
  // Use optional chaining or a fallback to ensure it's a string before trimming
  const trimmed = (typeof message === "string" ? message : "").trim();


  // ── Fast-path heuristics (no LLM call needed) ──
  const lower = trimmed.toLowerCase();

  if (trimmed.startsWith("Image analysis:")) {
    return { intent: "search_product", confidence: 1.0, entities: _emptyEntities(), language: "en" };
  }

  if (trimmed.startsWith('Image analysis:')) {
    return { intent: 'search_product', confidence: 1.0, entities: _emptyEntities(), language: 'en' };
  }

  if (/^(hi|hello|hey|hii+|namaste|namaskar|jai hind)[\s!]*$/i.test(trimmed)) {
    return { intent: "greeting", confidence: 1.0, entities: _emptyEntities(), language: "en" };
  }
  if (/^(bye|goodbye|tata|alvida|ok bye|thanks? bye)[\s!]*$/i.test(trimmed)) {
    return { intent: "farewell", confidence: 1.0, entities: _emptyEntities(), language: "en" };
  }
  if (/\b(cart|my cart|show cart|view cart|mera cart)\b/i.test(lower)) {
    return { intent: "view_cart", confidence: 0.95, entities: _emptyEntities(), language: _guessLang(lower) };
  }
  if (/\b(checkout|place order|confirm order|buy now|order karo)\b/i.test(lower)) {
    return { intent: "checkout", confidence: 0.95, entities: _emptyEntities(), language: _guessLang(lower) };
  }
  if (/\b(human|agent|support|help me|baat karo|koi insaan)\b/i.test(lower)) {
    return { intent: "human_agent", confidence: 0.9, entities: _emptyEntities(), language: _guessLang(lower) };
  }
  if (/\b(size|sizing|fit|fitting|kitna size|konsa size)\b/i.test(lower)) {
    const sizeMatch = lower.match(/\b(3|4|5|6|7|8|9|10|11|12|13|14|uk\s*\d+|eu\s*\d+)\b/);
    return {
      intent:     "size_help",
      confidence: 0.88,
      entities:   { ..._emptyEntities(), size: sizeMatch ? sizeMatch[1].trim() : null },
      language:   _guessLang(lower),
    };
  }

  // ── Full LLM classification ──
  try {
    const [classification, language] = await Promise.all([
      classifyIntent(trimmed, _buildPriorContext(phone)),
      detectLanguage(trimmed),
    ]);

    const intent = VALID_INTENTS.includes(classification.intent)
      ? classification.intent
      : "unknown";

    // Persist language preference
    if (language !== "en") {
      setUserPrefs(phone, { language });
    }

    return {
      intent,
      confidence: classification.confidence ?? 0,
      entities:   _mergeEntities(classification.entities),
      language,
    };
  } catch (err) {
    logger.warn(`[Intent] classifyIntent LLM failed for ${phone}: ${err.message}. Defaulting to unknown.`);
    return { intent: "unknown", confidence: 0, entities: _emptyEntities(), language: "en" };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTENT HANDLERS — each returns { response: string, stateUpdates?: object }
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle 'greeting' intent — personalised welcome based on session history.
 * @param {string} phone
 * @param {string} language
 * @returns {Promise<{ response: string }>}
 */
async function handleGreeting(phone, language) {
  const session = getSession(phone) || {};
  const isReturn = Array.isArray(session.history) && session.history.length > 2;
  const prefs    = getUserPrefs(phone);

  const userContent = isReturn
    ? `A returning customer said hello. Their preferred brand is "${prefs.preferredBrand || "not set"}". ` +
      `Greet them warmly, reference their past visit, and offer personalised help. ` +
      `${language === "hi" ? "Reply in Hindi/Hinglish." : ""}`
    : `A new customer sent a greeting. Welcome them to The Dream Pair sneaker store, ` +
      `briefly explain what Maya can do (browse, search, checkout, image search), and invite them to explore. ` +
      `${language === "hi" ? "Reply in Hindi/Hinglish." : ""}`;

  const response = await _generate(phone, userContent, language);
  setConversationState(phone, "browsing");
  return { response };
}

/**
 * Handle 'browse_catalog' intent — send category summary and product recommendations.
 * @param {string} phone
 * @param {string} language
 * @returns {Promise<{ response: string, categories: object[], featured: object[] }>}
 */
async function handleBrowseCatalog(phone, language) {
  const [categories, featured] = await Promise.all([
    getCategorySummary(),
    getPersonalisedRecommendations(phone, 3),
  ]);

  const catList      = categories.map((c) => `• ${c.name} (${c.count} styles)`).join("\n");
  const featuredList = featured.map((p) => `• ${p.brand} ${p.name} — ₹${p.price.toLocaleString("en-IN")}`).join("\n");

  const userContent =
    `Customer wants to browse the catalog. Available categories:\n${catList}\n\n` +
    `Recommended for them:\n${featuredList}\n\n` +
    `Present the categories as a menu and highlight their recommendations. ` +
    `${language === "hi" ? "Reply in Hindi/Hinglish." : ""} Under 120 words.`;

  const response = await _generate(phone, userContent, language);
  setConversationState(phone, "browsing");
  return { response, categories, featured };
}

/**
 * Handle 'search_product' intent — keyword or entity-based product search.
 * @param {string} phone
 * @param {string} message   - original customer message
 * @param {object} entities  - { brand, category, size, sku }
 * @param {string} language
 * @returns {Promise<{ response: string, products: object[] }>}
 */
async function handleSearchProduct(phone, message, entities, language) {
  // Build search query from entities + raw message
  const queryParts = [
    entities.brand,
    entities.category,
    entities.model,
    message,
  ].filter(Boolean);
  const query    = queryParts.join(" ");
  const products = await searchProducts(query);

  if (products.length === 0) {
    const userContent =
      `Customer searched for "${query}" but no products were found in the catalog. ` +
      `Apologise warmly, suggest they browse categories or send an image instead. ` +
      `${language === "hi" ? "Reply in Hindi/Hinglish." : ""}`;
    const response = await _generate(phone, userContent, language);
    return { response, products: [] };
  }

  const top3        = products.slice(0, 3);
  const productList = top3
    .map((p, i) => `${i + 1}. *${p.brand} ${p.name}* | ₹${p.price.toLocaleString("en-IN")} | SKU: ${p.sku}`)
    .join("\n");

  const userContent =
    `Customer searched for "${query}". Found ${products.length} result(s). Showing top 3:\n${productList}\n\n` +
    `Present these results enthusiastically, mention stock availability, and invite size selection. ` +
    `${language === "hi" ? "Reply in Hindi/Hinglish." : ""} Under 120 words.`;

  const response = await _generate(phone, userContent, language);

  updateConversationPayload(phone, { lastSearchResults: top3.map((p) => p.sku) });
  return { response, products: top3 };
}

/**
 * Handle 'size_help' intent — provide size guidance for a specific product or general chart.
 * @param {string} phone
 * @param {object} entities  - { sku, brand, size }
 * @param {string} language
 * @returns {Promise<{ response: string, availableSizes?: string[] }>}
 */
async function handleSizeHelp(phone, entities, language) {
  let availableSizes = [];
  let productContext = "";

  let sku = entities.sku;
  if (!sku) {
    const state = getConversationState(phone);
    sku = state?.payload?.lastSelectedSku || null;
  }

  if (sku) {
    const product = await getProductBySku(sku);
    if (product) {
      availableSizes = await getAvailableSizes(sku);
      productContext = `Product: ${product.brand} ${product.name} | Available sizes: ${availableSizes.join(", ") || "out of stock"}. `;
    }
  }

  const sizeText = entities.size ? `They mentioned size "${entities.size}". ` : "";

  const userContent =
    `Customer is discussing sizing. ${productContext}` +
    sizeText +
    `RULES:\n` +
    `1. If they provide a size (e.g., "7"), confirm it and ask to add to cart.\n` +
    `2. If they say "No", assume they are happy with the current selection and move to checkout.\n` +
    `3. ONLY provide a size chart if explicitly asked.\n` +
    `${language === "hi" ? "Reply in Hindi/Hinglish." : ""} Under 60 words.`;

  const response = await _generate(phone, userContent, language);
  return { response, availableSizes };
}

/**
 * Handle 'view_cart' intent — present cart summary.
 * @param {string} phone
 * @param {string} language
 * @returns {Promise<{ response: string, cartMessage: string, total: number }>}
 */
async function handleViewCart(phone, language) {
  const cart        = getCart(phone);
  const cartMessage = formatCartMessage(phone);
  const total       = getCartTotal(phone);

  if (!cart || cart.items.length === 0) {
    const userContent =
      `Customer's cart is empty. Tell them warmly, suggest browsing the catalog or searching for a sneaker. ` +
      `${language === "hi" ? "Reply in Hindi/Hinglish." : ""}`;
    const response = await _generate(phone, userContent, language);
    return { response, cartMessage, total: 0 };
  }

  const userContent =
    `Customer wants to view their cart.\n${cartMessage}\n\n` +
    `Present the cart summary, confirm the total, and ask if they'd like to checkout or continue shopping. ` +
    `${language === "hi" ? "Reply in Hindi/Hinglish." : ""} Under 100 words.`;

  const response = await _generate(phone, userContent, language);
  return { response, cartMessage, total };
}

/**
 * Handle 'payment_query' intent — answer payment method / status questions.
 * @param {string} phone
 * @param {string} message
 * @param {string} language
 * @returns {Promise<{ response: string }>}
 */
async function handlePaymentQuery(phone, message, language) {
  const state   = getConversationState(phone);
  const orderId = state?.payload?.orderId || null;

  const userContent =
    `Customer has a payment query: "${message}". ` +
    `${orderId ? `Their active order ID is ${orderId}. ` : ""}` +
    `Accepted payment methods: UPI, Credit Card, Debit Card, Net Banking (via Razorpay), and Cash on Delivery (COD) with a refundable deposit. ` +
    `Provide a clear, reassuring answer. ` +
    `${language === "hi" ? "Reply in Hindi/Hinglish." : ""} Under 100 words.`;

  const response = await _generate(phone, userContent, language);
  return { response };
}

/**
 * Handle 'order_status' intent — look up order information from conversation state.
 * @param {string} phone
 * @param {string} language
 * @returns {Promise<{ response: string }>}
 */
async function handleOrderStatus(phone, language) {
  const state   = getConversationState(phone);
  const orderId = state?.payload?.orderId    || null;
  const status  = state?.payload?.orderStatus || null;

  const userContent = orderId
    ? `Customer is asking about order "${orderId}" with current status "${status || "being processed"}". ` +
      `Provide a friendly update and suggest they wait or contact support if needed. ` +
      `${language === "hi" ? "Reply in Hindi/Hinglish." : ""} Under 80 words.`
    : `Customer is asking about order status but no active order is found in their session. ` +
      `Ask them to share their order ID. ` +
      `${language === "hi" ? "Reply in Hindi/Hinglish." : ""} Under 60 words.`;

  const response = await _generate(phone, userContent, language);
  return { response };
}

/**
 * Handle 'return_exchange' intent.
 * @param {string} phone
 * @param {string} language
 * @returns {Promise<{ response: string }>}
 */
async function handleReturnExchange(phone, language) {
  const userContent =
    `Customer is asking about returns or exchange. Policy: ` +
    `7-day exchange for unworn items with original packaging and unboxing video proof. ` +
    `No direct refunds — store credit or size exchange only. COD deposit is refunded separately. ` +
    `Explain warmly and ask them to share their order ID and unboxing video. ` +
    `${language === "hi" ? "Reply in Hindi/Hinglish." : ""} Under 100 words.`;

  const response = await _generate(phone, userContent, language);
  return { response };
}

/**
 * Handle 'farewell' intent.
 * @param {string} phone
 * @param {string} language
 * @returns {Promise<{ response: string }>}
 */
async function handleFarewell(phone, language) {
  const userContent =
    `Customer is saying goodbye. Give a warm, brief farewell and invite them back. ` +
    `${language === "hi" ? "Reply in Hindi/Hinglish." : ""} Max 2 sentences.`;
  const response = await _generate(phone, userContent, language);
  return { response };
}

/**
 * Handle 'unknown' intent — graceful fallback.
 * @param {string} phone
 * @param {string} message
 * @param {string} language
 * @returns {Promise<{ response: string }>}
 */
async function handleUnknown(phone, message, language) {
  const userContent =
    `Customer sent a message Maya didn't understand: "${message}". ` +
    `Acknowledge politely, explain what Maya can help with (browse catalog, search sneakers, ` +
    `image search, checkout, order status, returns), and ask how to help. ` +
    `${language === "hi" ? "Reply in Hindi/Hinglish." : ""} Under 80 words.`;
  const response = await _generate(phone, userContent, language);
  return { response };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Master intent dispatcher.
 * Extracts intent from the customer message, routes to the correct handler,
 * appends message history, and returns a unified result object.
 *
 * @param {string} phone
 * @param {string} message
 * @returns {Promise<{
 *   intent:     string,
 *   confidence: number,
 *   language:   string,
 *   response:   string,
 *   products?:  object[],
 *   categories?: object[],
 *   cartMessage?: string,
 *   total?:     number,
 *   handoff?:   boolean
 * }>}
 */
async function processMessage(phone, message) {
  // 1. Extract intent
  const { intent, confidence, entities, language } = await extractIntent(phone, message);

  logger.info(`[Intent] phone=${phone} | intent=${intent} | confidence=${confidence} | lang=${language}`);

  // 2. Append user message to history
  _appendHistory(phone, "user", message);

  // 3. Route to handler
  let result = {};

  switch (intent) {
    case "greeting":
      result = await handleGreeting(phone, language);
      break;

    case "browse_catalog":
      result = await handleBrowseCatalog(phone, language);
      break;

    case "search_product":
      result = await handleSearchProduct(phone, message, entities, language);
      break;

    case "size_help":
      result = await handleSizeHelp(phone, entities, language);
      break;

    case "view_cart":
      result = await handleViewCart(phone, language);
      break;

    case "checkout":
      // Checkout triggers a state transition — the controller handles the full flow
      setConversationState(phone, "payment_pending");
      result = { response: null, triggerCheckout: true };
      break;

    case "payment_query":
      result = await handlePaymentQuery(phone, message, language);
      break;

    case "order_status":
      result = await handleOrderStatus(phone, language);
      break;

    case "return_exchange":
      result = await handleReturnExchange(phone, language);
      break;

    case "image_search":
      // Image search is handled by the vision pipeline externally —
      // return a prompt asking the user to send the image
      result = await handleImageSearchPrompt(phone, language);
      break;

    case "human_agent":
      result = { response: null, handoff: true };
      break;

    case "farewell":
      result = await handleFarewell(phone, language);
      break;

    default:
      result = await handleUnknown(phone, message, language);
  }

  // 4. Append assistant response to history (if any)
  if (result.response) {
    _appendHistory(phone, "assistant", result.response);
  }

  return { intent, confidence, language, entities, ...result };
}

/**
 * Prompt the customer to send an image for the image search flow.
 * @param {string} phone
 * @param {string} language
 * @returns {Promise<{ response: string }>}
 */
async function handleImageSearchPrompt(phone, language) {
  const userContent =
    `Customer wants to search by image. Ask them to send a clear photo of the sneaker ` +
    `(front-facing, good lighting). Explain that Maya will identify it and find matches. ` +
    `${language === "hi" ? "Reply in Hindi/Hinglish." : ""} Under 60 words.`;
  const response = await _generate(phone, userContent, language);
  setConversationState(phone, "browsing", { awaitingImage: true });
  return { response };
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate a Maya response, falling back to a safe default if LLM fails.
 * @param {string} phone
 * @param {string} userContent
 * @param {string} language
 * @returns {Promise<string>}
 */
async function _generate(phone, userContent, language) {
  const prefs      = getUserPrefs(phone);
  const systemNote = language === "hi"
    ? `${MAYA_SYSTEM_PROMPT}\n\nIMPORTANT: The customer prefers Hindi/Hinglish. Always reply in Hindi/Hinglish.`
    : MAYA_SYSTEM_PROMPT;

  try {
    return await generateResponse(
      [{ role: "user", content: userContent }],
      systemNote
    );
  } catch (err) {
    logger.error(`[Intent] _generate failed for ${phone}: ${err.message}`);
    return language === "hi"
      ? "Maafi kijiye, abhi thodi samasya aa rahi hai. Kripya thodi der baad try karein. 🙏"
      : "Sorry, I'm experiencing a brief issue. Please try again in a moment. 🙏";
  }
}

/**
 * Return an empty entities object.
 * @returns {{ brand: null, size: null, sku: null, category: null }}
 */
function _emptyEntities() {
  return { brand: null, size: null, sku: null, category: null };
}

/**
 * Merge and sanitise an entities object from the LLM.
 * @param {object|null} raw
 * @returns {{ brand: string|null, size: string|null, sku: string|null, category: string|null }}
 */
function _mergeEntities(raw) {
  const base = _emptyEntities();
  if (!raw || typeof raw !== "object") return base;
  return {
    brand:    raw.brand    || null,
    size:     raw.size     || null,
    sku:      raw.sku      || null,
    category: raw.category || null,
  };
}

/**
 * Heuristic language guess from message content (avoids LLM call for fast-path intents).
 * @param {string} lower
 * @returns {"hi"|"en"}
 */
function _guessLang(lower) {
  const hindiWords = ["karo", "mera", "hai", "nahi", "kuch", "bata", "kitna", "konsa", "ek"];
  return hindiWords.some((w) => lower.includes(w)) ? "hi" : "en";
}

module.exports = {
  // Core
  extractIntent,
  processMessage,

  // Individual Handlers (exported for direct controller use)
  handleGreeting,
  handleBrowseCatalog,
  handleSearchProduct,
  handleSizeHelp,
  handleViewCart,
  handlePaymentQuery,
  handleOrderStatus,
  handleReturnExchange,
  handleFarewell,
  handleUnknown,
  handleImageSearchPrompt,
};
