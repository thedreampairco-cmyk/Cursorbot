// services/features/visionRecognition.js
"use strict";

const { logger, AppError }           = require("../../errorHandler");
const {
  analyzeSneakerImage,
  matchSneakerFromCatalog,
  generateResponse,
  MAYA_SYSTEM_PROMPT,
}                                    = require("../aiIntegration");
const {
  fetchIncomingMedia,
  getMediaDownloadUrl,
}                                    = require("../whatsapp/greenApiMedia");
const {
  getCatalog,
  getAvailableSizes,
  suggestAlternatives,
}                                    = require("./inventoryService");
const {
  updateConversationPayload,
  setUserPrefs,
  getUserPrefs,
}                                    = require("../memoryStore");

// ─── Constants ────────────────────────────────────────────────────────────────

const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_IMAGE_BYTES        = 10 * 1024 * 1024; // 10 MB

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Convert a Buffer to a base64 data URI.
 * @param {Buffer} buffer
 * @param {string} [mimeType="image/jpeg"]
 * @returns {string}
 */
function _bufferToDataUri(buffer, mimeType = "image/jpeg") {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

/**
 * Safely parse JSON from a raw LLM response string.
 * Extracts the first {...} or [...] block found.
 * @param {string} raw
 * @returns {object|null}
 */
function _safeParseJson(raw) {
  const match = raw.match(/(\{[\s\S]*?\}|\[[\s\S]*?\])/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * Validate that a mimeType is a supported image format.
 * @param {string} mimeType
 * @returns {boolean}
 */
function isSupportedImageType(mimeType) {
  return SUPPORTED_IMAGE_TYPES.includes((mimeType || "").toLowerCase());
}

// ═══════════════════════════════════════════════════════════════════════════════
// IMAGE ACQUISITION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Download an incoming WhatsApp image from Green API and return as a base64 data URI.
 * Called when a customer sends an image in WhatsApp.
 *
 * @param {string} chatIdStr  - "919876543210@c.us"
 * @param {string} idMessage  - Green API message ID
 * @returns {Promise<{ dataUri: string, mimeType: string, sizeBytes: number }>}
 */
async function downloadWhatsAppImage(chatIdStr, idMessage) {
  try {
    // Step 1: resolve the download URL from Green API
    const { downloadUrl, mimeType } = await getMediaDownloadUrl(chatIdStr, idMessage);

    if (!isSupportedImageType(mimeType)) {
      throw new AppError(
        `Unsupported image type "${mimeType}". Please send a JPEG, PNG, or WebP image.`,
        415,
        "UNSUPPORTED_IMAGE_TYPE"
      );
    }

    // Step 2: download the binary
    const res = await fetch(downloadUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());

    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new AppError(
        `Image is too large (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB). Max 10 MB.`,
        413,
        "IMAGE_TOO_LARGE"
      );
    }

    const dataUri = _bufferToDataUri(buffer, mimeType);
    logger.info(
      `[Vision] Image downloaded | idMessage=${idMessage} | mime=${mimeType} | bytes=${buffer.byteLength}`
    );

    return { dataUri, mimeType, sizeBytes: buffer.byteLength };
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error(`[Vision] downloadWhatsAppImage failed: ${err.message}`);
    throw new AppError(
      "Failed to download your image. Please try sending it again.",
      502,
      "IMAGE_DOWNLOAD_FAILED"
    );
  }
}

/**
 * Fetch a publicly accessible image URL and return as a base64 data URI.
 * Use when the customer provides a product URL rather than uploading directly.
 *
 * @param {string} imageUrl
 * @returns {Promise<{ dataUri: string, mimeType: string }>}
 */
async function fetchPublicImage(imageUrl) {
  try {
    const buffer = await fetchIncomingMedia(imageUrl);
    // Naive MIME detection from URL extension
    const ext      = imageUrl.split("?")[0].split(".").pop().toLowerCase();
    const mimeMap  = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
    const mimeType = mimeMap[ext] || "image/jpeg";

    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new AppError("Image URL content exceeds the 10 MB limit.", 413, "IMAGE_TOO_LARGE");
    }

    return { dataUri: _bufferToDataUri(buffer, mimeType), mimeType };
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error(`[Vision] fetchPublicImage failed: ${err.message}`);
    throw new AppError("Failed to fetch the image URL.", 502, "IMAGE_FETCH_FAILED");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// VISION ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Analyse a sneaker image (data URI or public URL) with the Groq vision model.
 * Returns a structured recognition result.
 *
 * @param {string} imageInput  - base64 data URI or public URL
 * @returns {Promise<{
 *   brand:       string|null,
 *   model:       string|null,
 *   colorway:    string,
 *   silhouette:  string,
 *   keyFeatures: string[],
 *   priceRange:  string,
 *   confidence:  number,
 *   rawResponse: string
 * }>}
 */
async function analyseImage(imageInput) {
  try {
    const rawResponse = await analyzeSneakerImage(imageInput);
    const parsed      = _safeParseJson(rawResponse);

    if (!parsed) {
      logger.warn(`[Vision] analyseImage: could not parse JSON. raw="${rawResponse.slice(0, 120)}"`);
      return {
        brand:       null,
        model:       null,
        colorway:    "unknown",
        silhouette:  "unknown",
        keyFeatures: [],
        priceRange:  "unknown",
        confidence:  0,
        rawResponse,
      };
    }

    return {
      brand:       parsed.brand       || null,
      model:       parsed.model       || null,
      colorway:    parsed.colorway    || "unknown",
      silhouette:  parsed.silhouette  || "unknown",
      keyFeatures: Array.isArray(parsed.keyFeatures) ? parsed.keyFeatures : [],
      priceRange:  parsed.priceRange  || "unknown",
      confidence:  typeof parsed.confidence === "number" ? parsed.confidence : 0,
      rawResponse,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error(`[Vision] analyseImage failed: ${err.message}`);
    throw new AppError("Sneaker analysis failed. Please try a clearer photo.", 502, "VISION_ANALYSIS_FAILED");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATALOG MATCHING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a searchable description string from a vision analysis result.
 * @param {object} analysis  - output of analyseImage
 * @returns {string}
 */
function buildSearchDescription(analysis) {
  const parts = [];
  if (analysis.brand)                       parts.push(analysis.brand);
  if (analysis.model)                       parts.push(analysis.model);
  if (analysis.colorway && analysis.colorway !== "unknown") parts.push(analysis.colorway);
  if (analysis.silhouette && analysis.silhouette !== "unknown") parts.push(analysis.silhouette);
  if (analysis.keyFeatures.length)          parts.push(...analysis.keyFeatures.slice(0, 2));
  return parts.join(" ");
}

/**
 * Match an analysed image to products in the catalog.
 * Falls back to keyword search if AI catalog matching returns nothing.
 *
 * @param {object} analysis  - output of analyseImage
 * @param {number} [topK=3]
 * @returns {Promise<object[]>}
 */
async function matchToProducts(analysis, topK = 3) {
  try {
    const catalog     = await getCatalog();
    const description = buildSearchDescription(analysis);

    if (!description.trim()) {
      logger.warn("[Vision] matchToProducts: empty description, returning top featured products.");
      return catalog.slice(0, topK);
    }

    // Primary: AI-powered semantic match
    const aiMatches = await matchSneakerFromCatalog(description, catalog, topK);
    if (aiMatches.length > 0) {
      logger.info(`[Vision] AI match: ${aiMatches.length} result(s) for "${description}"`);
      return aiMatches;
    }

    // Fallback: naive keyword search
    const terms    = description.toLowerCase().split(/\s+/).filter(Boolean);
    const fallback = catalog.filter((p) => {
      const hay = `${p.brand} ${p.name} ${p.category} ${p.description}`.toLowerCase();
      return terms.some((t) => hay.includes(t));
    });

    logger.info(`[Vision] Keyword fallback: ${fallback.length} result(s) for "${description}"`);
    return fallback.slice(0, topK);
  } catch (err) {
    logger.error(`[Vision] matchToProducts failed: ${err.message}`);
    return []; // Graceful degradation
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FULL PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run the complete vision pipeline for a WhatsApp image message.
 *
 *  1. Download the image from Green API
 *  2. Analyse with Groq vision model
 *  3. Match to catalog products
 *  4. Generate a Maya response
 *  5. Update conversation state with found products
 *
 * @param {string} phone       - customer phone
 * @param {string} chatIdStr   - Green API chat ID
 * @param {string} idMessage   - Green API message ID
 * @returns {Promise<{
 *   analysis:  object,
 *   products:  object[],
 *   response:  string,
 *   matched:   boolean
 * }>}
 */
async function processWhatsAppImage(phone, chatIdStr, idMessage) {
  try {
    // 1. Download
    const { dataUri } = await downloadWhatsAppImage(chatIdStr, idMessage);

    // 2. Analyse
    const analysis = await analyseImage(dataUri);
    logger.info(
      `[Vision] Analysis complete for ${phone} | brand=${analysis.brand} | confidence=${analysis.confidence}`
    );

    // 3. Match
    const products = await matchToProducts(analysis, 3);

    // 4. Generate response
    const response = await _buildVisionResponse(phone, analysis, products);

    // 5. Update state
    if (products.length > 0) {
      updateConversationPayload(phone, { lastSearchResults: products.map((p) => p.sku) });

      // Capture brand preference for personalisation
      if (analysis.brand && analysis.confidence >= 0.7) {
        setUserPrefs(phone, { preferredBrand: analysis.brand });
      }
    }

    return { analysis, products, response, matched: products.length > 0 };
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error(`[Vision] processWhatsAppImage failed for ${phone}: ${err.message}`);
    throw new AppError(
      "I couldn't analyse that image. Please send a clearer photo of the sneaker.",
      502,
      "VISION_PIPELINE_FAILED"
    );
  }
}

/**
 * Run the vision pipeline for a publicly accessible image URL.
 *
 * @param {string} phone
 * @param {string} imageUrl
 * @returns {Promise<{ analysis: object, products: object[], response: string, matched: boolean }>}
 */
async function processImageUrl(phone, imageUrl) {
  try {
    const { dataUri } = await fetchPublicImage(imageUrl);
    const analysis    = await analyseImage(dataUri);
    const products    = await matchToProducts(analysis, 3);
    const response    = await _buildVisionResponse(phone, analysis, products);

    if (products.length > 0) {
      updateConversationPayload(phone, { lastSearchResults: products.map((p) => p.sku) });
    }

    return { analysis, products, response, matched: products.length > 0 };
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error(`[Vision] processImageUrl failed for ${phone}: ${err.message}`);
    throw new AppError("Failed to process the image URL.", 502, "VISION_URL_PIPELINE_FAILED");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESPONSE GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build Maya's conversational reply for a vision search result.
 * @param {string}   phone
 * @param {object}   analysis
 * @param {object[]} products
 * @returns {Promise<string>}
 */
async function _buildVisionResponse(phone, analysis, products) {
  const prefs    = getUserPrefs(phone);
  const language = prefs.language || "en";

  if (products.length === 0) {
    return _noMatchResponse(analysis, language);
  }

  // Enrich products with available sizes
  const enriched = await Promise.all(
    products.map(async (p) => ({
      ...p,
      availableSizes: await getAvailableSizes(p.sku),
    }))
  );

  const productContext = enriched
    .map(
      (p, i) =>
        `${i + 1}. ${p.brand} ${p.name} | SKU: ${p.sku} | ` +
        `₹${p.price.toLocaleString("en-IN")} | ` +
        `Sizes: ${p.availableSizes.join(", ") || "ask us"} | ` +
        `Stock: ${p.stock > 0 ? "In stock" : "Out of stock"}`
    )
    .join("\n");

  const visionSummary =
    analysis.brand
      ? `Detected: ${analysis.brand}${analysis.model ? " " + analysis.model : ""} ` +
        `(${Math.round(analysis.confidence * 100)}% confidence)`
      : "Sneaker detected (brand unconfirmed)";

  const userContent =
    `A customer sent a sneaker photo. Vision analysis: "${visionSummary}".\n\n` +
    `Matching catalog products:\n${productContext}\n\n` +
    `Respond as Maya. Mention what was detected, list the matches enthusiastically, ` +
    `and invite the customer to select a product or ask for sizes. ` +
    `${language === "hi" ? "Respond in Hindi/Hinglish." : "Respond in English."} ` +
    `Keep it under 120 words.`;

  try {
    return await generateResponse(
      [{ role: "user", content: userContent }],
      MAYA_SYSTEM_PROMPT
    );
  } catch {
    return _fallbackVisionResponse(enriched);
  }
}

/**
 * Fallback plain-text response when the LLM is unavailable.
 * @param {object[]} products
 * @returns {string}
 */
function _fallbackVisionResponse(products) {
  const lines = products.map(
    (p, i) =>
      `${i + 1}. 👟 *${p.brand} ${p.name}* — ₹${p.price.toLocaleString("en-IN")}`
  );
  return (
    `🔍 I found these matches for your photo!\n\n` +
    lines.join("\n") +
    `\n\nReply with the number to see sizes & details 👆`
  );
}

/**
 * Response when no catalog match is found.
 * @param {object} analysis
 * @param {string} language
 * @returns {string}
 */
function _noMatchResponse(analysis, language) {
  const brand = analysis.brand || "that sneaker";
  if (language === "hi") {
    return (
      `😔 Ek dum sahi match nahi mila *${brand}* ke liye abhi.\n\n` +
      `Aap humara catalog dekh sakte hain ya koi aur photo bhej sakte hain! 👟`
    );
  }
  return (
    `😔 I couldn't find an exact match for *${brand}* in our catalog right now.\n\n` +
    `Try browsing our full collection or send a different photo! 👟`
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MULTI-PRODUCT VISION COMPARISON
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compare two vision analysis results and generate a comparison response.
 * Useful when a customer sends two photos asking "which is better?".
 *
 * @param {string}   phone
 * @param {object}   analysisA  - first analysis result
 * @param {object}   analysisB  - second analysis result
 * @returns {Promise<string>}
 */
async function compareVisionResults(phone, analysisA, analysisB) {
  const prefs    = getUserPrefs(phone);
  const language = prefs.language || "en";

  const descA = buildSearchDescription(analysisA);
  const descB = buildSearchDescription(analysisB);

  const userContent =
    `A customer shared two sneaker images and wants a comparison.\n\n` +
    `Sneaker A: "${descA}" (confidence: ${Math.round(analysisA.confidence * 100)}%)\n` +
    `Sneaker B: "${descB}" (confidence: ${Math.round(analysisB.confidence * 100)}%)\n\n` +
    `Give a fun, knowledgeable comparison as Maya covering style, use-case, and fit. ` +
    `${language === "hi" ? "Respond in Hindi/Hinglish." : "Respond in English."} Under 120 words.`;

  try {
    return await generateResponse(
      [{ role: "user", content: userContent }],
      MAYA_SYSTEM_PROMPT
    );
  } catch {
    return `👟 *Sneaker A:* ${descA || "Unknown"}\n👟 *Sneaker B:* ${descB || "Unknown"}\n\nBoth look great! Which would you like to add to your cart? 🔥`;
  }
}

/**
 * Analyse a customer-provided image against a known SKU for similarity check.
 * Used to verify if the customer received the correct product.
 *
 * @param {string} imageInput  - data URI or URL
 * @param {string} sku         - expected SKU
 * @returns {Promise<{ match: boolean, confidence: number, analysis: object }>}
 */
async function verifySneakerIdentity(imageInput, sku) {
  try {
    const product  = await getCatalog().then((c) => c.find((p) => p.sku === sku));
    if (!product) throw new AppError(`SKU "${sku}" not found in catalog.`, 404, "SKU_NOT_FOUND");

    const analysis = await analyseImage(imageInput);
    const brandMatch = analysis.brand
      ? product.brand.toLowerCase().includes(analysis.brand.toLowerCase()) ||
        analysis.brand.toLowerCase().includes(product.brand.toLowerCase())
      : false;

    const nameWords  = product.name.toLowerCase().split(/\s+/);
    const modelMatch = analysis.model
      ? nameWords.some((w) => analysis.model.toLowerCase().includes(w))
      : false;

    const match      = (brandMatch || modelMatch) && analysis.confidence >= 0.5;
    logger.info(
      `[Vision] Identity check for SKU ${sku}: match=${match} | confidence=${analysis.confidence}`
    );

    return { match, confidence: analysis.confidence, analysis };
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error(`[Vision] verifySneakerIdentity failed: ${err.message}`);
    throw new AppError("Product verification failed.", 502, "VISION_VERIFY_FAILED");
  }
}


/**
 * Wrapper function to bridge Green API webhook with the vision AI
 */
async function getVisionAnalysis(downloadUrl) {
  try {
    console.log('🌐 Downloading directly, bypassing GreenAPI wrappers...');
    const res = await fetch(downloadUrl);
    if (!res.ok) {
       throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const dataUri = _bufferToDataUri(buffer, "image/jpeg");
    const analysis = await analyseImage(dataUri);
    const description = buildSearchDescription(analysis);
    return description.trim() ? description : "a sneaker";
  } catch (err) {
    console.error("[Vision] getVisionAnalysis failed:", err.message);
    throw err;
  }
}
}

module.exports = {
  getVisionAnalysis,
  // Image Acquisition
  downloadWhatsAppImage,
  fetchPublicImage,
  isSupportedImageType,

  // Analysis
  analyseImage,
  buildSearchDescription,

  // Matching
  matchToProducts,

  // Full Pipelines
  processWhatsAppImage,
  processImageUrl,

  // Comparisons & Verification
  compareVisionResults,
  verifySneakerIdentity,
};
