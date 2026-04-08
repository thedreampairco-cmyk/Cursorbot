// services/aiIntegration.js
"use strict";

const Groq               = require("groq-sdk");
const { logger, AppError } = require("../../errorHandler");

if (!process.env.GROQ_API_KEY) {
  console.error("❌ CRITICAL: GROQ_API_KEY is missing. AI features will fail."); return null;
}

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Model Config ────────────────────────────────────────────────────────────

const MODELS = {
  chat:    "llama-3.3-70b-versatile",
  vision:  "meta-llama/llama-4-scout-17b-16e-instruct",
  fast:    "llama-3.1-8b-instant",
};

const DEFAULTS = {
  maxTokensChat:    1024,
  maxTokensVision:  1500,
  maxTokensFast:    256,
  temperature:      0.7,
  tempLow:          0.1,
};

// ─── System Prompts ──────────────────────────────────────────────────────────

const MAYA_SYSTEM_PROMPT = `You are Maya, the friendly AI sales assistant for The Dream Pair — a premium sneaker store.

Personality:
- Enthusiastic about sneaker culture, street style, and fashion
- Concise, warm, and helpful — never pushy or robotic
- Respond in the same language the customer uses (Hindi, Hinglish, or English)
- Use relevant emojis naturally (👟 🔥 💯 ✅ 🛒)

Capabilities:
- Help customers discover and select sneakers
- Provide sizing, fit, and care advice
- Guide customers through the checkout flow
- Handle order and payment queries
- Identify sneakers from customer-shared images
- Escalate to a human agent when genuinely needed

Rules:
- NEVER invent product details, prices, or availability — only use context provided to you
- Keep replies under 150 words unless the customer explicitly asks for more detail
- If a product is out of stock, proactively suggest alternatives
- Always stay positive and solution-focused`;

// ═══════════════════════════════════════════════════════════════════════════════
// CORE LLM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate a conversational response using the Maya persona.
 *
 * @param {Array<{ role: 'user'|'assistant'|'system', content: string }>} messages
 * @param {string|null} [systemPrompt]   - override Maya's default system prompt
 * @param {object}      [options]
 * @param {string}      [options.model]
 * @param {number}      [options.maxTokens]
 * @param {number}      [options.temperature]
 * @returns {Promise<string>}
 */
/**
 * Generate a conversational response using the Maya persona.
 * FIXED: Sanitizes all message content fields to strings before the API call.
 */
async function generateResponse(messages, systemPrompt = null, options = {}) {
  const {
    model       = MODELS.chat,
    maxTokens   = DEFAULTS.maxTokensChat,
    temperature = DEFAULTS.temperature,
  } = options;

  // ── CRITICAL FIX ────────────────────────────────────────────────────────────
  // Groq requires every message.content to be a plain string.
  // Coerce any object that slipped through (e.g. a full result object stored in history).
  const sanitizedMessages = messages.map((m) => {
    if (typeof m.content === "string") return m;

    let coerced;
    if (m.content && typeof m.content === "object") {
      coerced =
        typeof m.content.reply    === "string" ? m.content.reply    :
        typeof m.content.response === "string" ? m.content.response :
        JSON.stringify(m.content);
    } else {
      coerced = String(m.content ?? "");
    }

    logger.warn(
      `[Groq] generateResponse: message.content was not a string (role="${m.role}"). ` +
      `Coerced to: "${coerced.slice(0, 80)}"`
    );

    return { ...m, content: coerced };
  });
  // ── END FIX ─────────────────────────────────────────────────────────────────

  try {
    const completion = await groq.chat.completions.create({
      model,
      max_tokens:  maxTokens,
      temperature,
      messages: [
        { role: "system", content: systemPrompt || MAYA_SYSTEM_PROMPT },
        ...sanitizedMessages,
      ],
    });

    const text = completion.choices?.[0]?.message?.content?.trim();
    if (!text) throw new AppError("Groq returned an empty response.", 502, "LLM_EMPTY_RESPONSE");

    logger.info(`[Groq] Response generated | model=${model} | tokens=${completion.usage?.total_tokens}`);
    return text;
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error(`[Groq] generateResponse failed: ${err.message}`);
    throw new AppError(`LLM generation failed: ${err.message}`, 502, "LLM_FAILED");
  }
}
// ═══════════════════════════════════════════════════════════════════════════════
// VISION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Analyze a sneaker image with Groq's vision model.
 * Accepts either a public URL or a base64 data URI.
 *
 * @param {string} imageInput  - public URL ("https://...") or base64 data URI ("data:image/jpeg;base64,...")
 * @param {string|null} [prompt]  - custom vision prompt; defaults to structured JSON extraction
 * @returns {Promise<string>}  - raw model response (JSON string or plain text depending on prompt)
 */
async function analyzeSneakerImage(imageInput, prompt = null) {
  const defaultPrompt =
    `Analyze this sneaker image and extract the following information. ` +
    `Respond ONLY with a valid JSON object and no additional text:\n` +
    `{\n` +
    `  "brand": "<brand name or null>",\n` +
    `  "model": "<model/style name or null>",\n` +
    `  "colorway": "<color description>",\n` +
    `  "silhouette": "<low-top|mid-top|high-top|slide|boot>",\n` +
    `  "keyFeatures": ["<feature1>", "<feature2>"],\n` +
    `  "priceRange": "<budget|mid|premium|luxury>",\n` +
    `  "confidence": <0.0-1.0>\n` +
    `}`;

  try {
    const completion = await groq.chat.completions.create({
      model:      MODELS.vision,
      max_tokens: DEFAULTS.maxTokensVision,
      messages: [
        {
          role:    "user",
          content: [
            { type: "image_url", image_url: { url: imageInput } },
            { type: "text",      text: (prompt || defaultPrompt) + "\n\nCRITICAL INSTRUCTION: You MUST output ONLY valid JSON. No conversational text, no markdown formatting, and no extra phrases." },
          ],
        },
      ],
    });

    const text = completion.choices?.[0]?.message?.content?.trim();
    if (!text) throw new AppError("Groq vision returned an empty response.", 502, "VISION_EMPTY_RESPONSE");

    logger.info(`[Groq Vision] Image analyzed | tokens=${completion.usage?.total_tokens}`);
    return text;
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error(`[Groq Vision] analyzeSneakerImage failed: ${err.message}`);
    throw new AppError(`Vision analysis failed: ${err.message}`, 502, "VISION_FAILED");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATALOG MATCHING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Match a customer's text query or vision-extracted description to catalog items.
 *
 * @param {string}   description  - free text query or JSON string from analyzeSneakerImage
 * @param {object[]} catalog      - product objects from fetchCatalogFromSheet
 * @param {number}   [topK=3]
 * @returns {Promise<object[]>}  - matching catalog items ordered by relevance
 */
async function matchSneakerFromCatalog(description, catalog, topK = 3) {
  if (!catalog || catalog.length === 0) return [];

  const catalogSummary = catalog
    .filter((p) => p.active !== false)
    .map(
      (p) =>
        `SKU:${p.sku}|Brand:${p.brand}|Name:${p.name}|` +
        `Price:₹${p.price}|Sizes:${(p.sizes || []).join(",")}|` +
        `Category:${p.category}`
    )
    .join("\n");

  const prompt =
    `You are a sneaker catalog matching engine. Return the top ${topK} best-matching SKUs for the customer query.\n\n` +
    `Customer query: "${description}"\n\n` +
    `Available catalog:\n${catalogSummary}\n\n` +
    `Respond ONLY with a valid JSON array of SKU strings, ordered by relevance.\n` +
    `Example: ["SKU001", "SKU023", "SKU047"]`;

  try {
    const completion = await groq.chat.completions.create({
      model:       MODELS.chat,
      max_tokens:  DEFAULTS.maxTokensFast,
      temperature: DEFAULTS.tempLow,
      messages:    [{ role: "user", content: prompt }],
    });

    const raw      = completion.choices?.[0]?.message?.content?.trim() || "";
    const arrMatch = raw.match(/\[.*?\]/s);

    let skus;
    try {
      skus = JSON.parse(arrMatch ? arrMatch[0] : raw);
    } catch {
      logger.warn(`[Groq] matchSneakerFromCatalog: unable to parse SKU list. raw="${raw.slice(0, 80)}"`);
      return [];
    }

    if (!Array.isArray(skus)) return [];

    const matched = skus
      .map((sku) => catalog.find((p) => p.sku === sku))
      .filter(Boolean)
      .slice(0, topK);

    logger.info(`[Groq] Catalog match: ${matched.length} result(s) for "${description.slice(0, 60)}"`);
    return matched;
  } catch (err) {
    logger.error(`[Groq] matchSneakerFromCatalog failed: ${err.message}`);
    return []; // Graceful degradation — caller can fall back to keyword search
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORDER SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate a natural-language WhatsApp order summary as Maya.
 *
 * @param {{ orderId, items, total, address, paymentMethod }} order
 * @returns {Promise<string>}
 */
async function generateOrderSummary(order) {
  const { orderId, items, total, address, paymentMethod } = order;
  const itemText = (items || [])
    .map((i) => `${i.qty}× ${i.brand || ""} ${i.name} (Size ${i.size}) @ ₹${i.price}`)
    .join(", ");

  const userContent =
    `Write a friendly, concise WhatsApp order confirmation message as Maya for:\n` +
    `Order ID: ${orderId}\n` +
    `Items: ${itemText}\n` +
    `Total: ₹${total}\n` +
    `Address: ${address}\n` +
    `Payment method: ${paymentMethod}\n\n` +
    `Keep it under 100 words. Use emojis. End with an encouraging note.`;

  return generateResponse([{ role: "user", content: userContent }]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTENT CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Classify the intent of an incoming customer message.
 *
 * @param {string}   message
 * @param {string[]} [priorContext=[]]  - last 2–3 conversation excerpts
 * @returns {Promise<{
 *   intent: string,
 *   confidence: number,
 *   entities: { brand: string|null, size: string|null, sku: string|null, category: string|null }
 * }>}
 */
async function classifyIntent(message, priorContext = []) {
  const contextBlock = priorContext.length
    ? `Recent conversation:\n${priorContext.join("\n")}\n\n`
    : "";

  const prompt =
    `${contextBlock}` +
    `Classify the customer message for a sneaker e-commerce WhatsApp bot.\n\n` +
    `Customer message: "${message}"\n\n` +
    `Valid intents:\n` +
    `browse_catalog | search_product | image_search | add_to_cart | view_cart |\n` +
    `checkout | payment_query | order_status | return_exchange | size_help |\n` +
    `human_agent | greeting | farewell | unknown\n\n` +
    `Respond ONLY with valid JSON and no other text:\n` +
    `{ "intent": "<intent>", "confidence": <0.0-1.0>, ` +
    `"entities": { "brand": null, "size": null, "sku": null, "category": null } }`;

  try {
    const completion = await groq.chat.completions.create({
      model:       MODELS.fast,
      max_tokens:  200,
      temperature: DEFAULTS.tempLow,
      messages:    [{ role: "user", content: prompt }],
    });

    const raw      = completion.choices?.[0]?.message?.content?.trim() || "";
    const objMatch = raw.match(/\{.*\}/s);

    const parsed = JSON.parse(objMatch ? objMatch[0] : raw);
    logger.info(`[Groq] Intent: ${parsed.intent} (${parsed.confidence})`);
    return parsed;
  } catch (err) {
    logger.warn(`[Groq] classifyIntent fallback to unknown: ${err.message}`);
    return { intent: "unknown", confidence: 0, entities: { brand: null, size: null, sku: null, category: null } };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LANGUAGE DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detect whether a message is primarily Hindi/Hinglish or English.
 *
 * @param {string} message
 * @returns {Promise<'hi'|'en'|'mixed'>}
 */
async function detectLanguage(message) {
  try {
    const completion = await groq.chat.completions.create({
      model:       MODELS.fast,
      max_tokens:  5,
      temperature: 0,
      messages: [
        {
          role:    "user",
          content: `Detect the primary language of this message: "${message.slice(0, 200)}"\nReply with ONLY one word: "hi" for Hindi or Hinglish, "en" for English, or "mixed".`,
        },
      ],
    });

    const lang = completion.choices?.[0]?.message?.content?.trim().toLowerCase();
    if (["hi", "en", "mixed"].includes(lang)) return lang;
    return "en";
  } catch (err) {
    logger.warn(`[Groq] detectLanguage failed, defaulting to "en": ${err.message}`);
    return "en";
  }
}

module.exports = {
  generateResponse,
  analyzeSneakerImage,
  matchSneakerFromCatalog,
  generateOrderSummary,
  classifyIntent,
  detectLanguage,
  MAYA_SYSTEM_PROMPT,
  MODELS,
};
