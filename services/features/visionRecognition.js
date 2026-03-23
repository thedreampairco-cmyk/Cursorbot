'use strict';

const axios  = require('axios');
const env    = require('../../config/env');
const { logger } = require('../../errorHandler');
const memoryStore = require('../data/memoryStore');

const VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

// ── Step 1: Detect mime type from buffer magic bytes ─────────────────────────
function detectMimeType(buffer) {
  const hex = buffer.slice(0, 4).toString('hex');
  if (hex.startsWith('ffd8ff'))   return 'image/jpeg';
  if (hex.startsWith('89504e47')) return 'image/png';
  if (hex.startsWith('47494638')) return 'image/gif';
  if (hex.startsWith('52494646')) return 'image/webp';
  return 'image/jpeg';
}

// ── Step 2: Download image from Green API into memory buffer ─────────────────
async function downloadImageBuffer(imageUrl) {
  logger.info('[Vision] Downloading image into memory...', { url: imageUrl.slice(0, 80) });

  const response = await axios({
    url: imageUrl,
    method: 'GET',
    responseType: 'arraybuffer',
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });

  return Buffer.from(response.data);
}

// ── Step 3: Fetch image URL from Green API ───────────────────────────────────
async function fetchImageUrlFromGreenApi(chatId, idMessage) {
  const BASE = env.greenApi.baseUrl || 'https://api.greenapi.com';
  const INST = env.greenApi.instanceId;
  const TOK  = env.greenApi.token;

  logger.info('[Vision] Calling Green API downloadFile...', { idMessage, chatId });

  // Small delay — Green API needs a moment before media is ready
  await new Promise((r) => setTimeout(r, 1500));

  try {
    const res = await axios.post(
      `${BASE}/waInstance${INST}/downloadFile/${TOK}`,
      { chatId, idMessage },
      {
        timeout: 15000,
        headers: { 'Content-Type': 'application/json' },
      }
    );
    logger.info('[Vision] downloadFile JSON response', {
      keys: Object.keys(res.data || {}),
      data: JSON.stringify(res.data).slice(0, 300),
    });
    const url = res.data?.downloadUrl
             || res.data?.fileUrl
             || res.data?.url
             || res.data?.urlFile
             || null;
    if (url) return { url, direct: false };
  } catch (err) {
    logger.warn('[Vision] downloadFile (json) failed', {
      status: err?.response?.status,
      error: err.message,
      data: JSON.stringify(err?.response?.data).slice(0, 200),
    });
  }

  return null;
}

// ── Step 4: Convert buffer to base64 data URL ────────────────────────────────
function bufferToDataUrl(buffer) {
  const mime   = detectMimeType(buffer);
  const base64 = Buffer.from(buffer).toString('base64');
  return `data:${mime};base64,${base64}`;
}

// ── Step 5: Send base64 image to Groq Vision ─────────────────────────────────
async function analyseWithGroqVision(base64DataUrl) {
  logger.info('[Vision] Sending base64 image to Groq llama-4-scout...');

  // Build catalog brand list for better recognition
  const catalog   = memoryStore.getCatalog();
  const brandList = [...new Set(catalog.map((p) => p.name))].slice(0, 20).join(', ');

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: VISION_MODEL,
      max_tokens: 200,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Analyze this sneaker/shoe image. Reply ONLY with valid JSON, no markdown.
Format: {"detected_text": "brand and model name", "brand": "brand name", "color": "main color", "labels": ["tag1","tag2"]}
Try to match these products if possible: ${brandList}
Example: {"detected_text": "Nike Air Max 90", "brand": "Nike", "color": "White", "labels": ["running","casual"]}`,
            },
            {
              type: 'image_url',
              image_url: { url: base64DataUrl },
            },
          ],
        },
      ],
    },
    {
      timeout: 25000,
      headers: {
        Authorization: `Bearer ${env.groq.apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const raw    = response.data.choices[0].message.content;
  const result = JSON.parse(raw);
  logger.info('[Vision] Groq result', { result });
  return result;
}

// ── Step 6: Match vision result to catalog ───────────────────────────────────
function matchToCatalog(visionResult) {
  if (!visionResult?.detected_text) return [];

  const { brand, detected_text, color } = visionResult;
  const catalog = memoryStore.getCatalog();

  const scored = catalog
    .filter((p) => p.inStock)
    .map((p) => {
      let score = 0;
      if (brand        && p.brand?.toLowerCase().includes(brand.toLowerCase()))                          score += 4;
      if (detected_text && p.name?.toLowerCase().includes(detected_text.toLowerCase().split(' ')[0]))   score += 3;
      if (color        && p.color?.toLowerCase().includes(color.toLowerCase()))                          score += 2;
      const hay = `${p.name} ${p.brand} ${p.category}`.toLowerCase();
      if (detected_text && hay.includes(detected_text.toLowerCase().split(' ')[0]))                      score += 1;
      return { product: p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((x) => x.product);

  return scored;
}

// ── MAIN: Full pipeline ───────────────────────────────────────────────────────
/**
 * Full vision pipeline:
 * 1. Get image URL from Green API using message ID
 * 2. Download image into memory buffer
 * 3. Convert buffer to base64
 * 4. Send to Groq Vision
 * 5. Match result to catalog
 *
 * @param {string} chatId     - WhatsApp chat ID
 * @param {string} idMessage  - Green API message ID
 * @param {string} imageUrl   - Direct URL if already available (optional)
 * @param {string} jpegThumb  - base64 thumbnail fallback (optional)
 */
async function matchSneakerFromImage(chatId, idMessage, imageUrl = null, jpegThumb = null) {
  let base64DataUrl = null;

  // ── Try to get image from Green API using message ID ──
  if (!base64DataUrl && idMessage && chatId) {
    try {
      const result = await fetchImageUrlFromGreenApi(chatId, idMessage);
      if (result?.direct) {
        // Already have base64 from direct file download
        base64DataUrl = result.dataUrl;
        logger.info('[Vision] Got base64 directly from Green API downloadFile');
      } else if (result?.url) {
        // Got a URL — download it
        imageUrl = result.url;
      }
    } catch (err) {
      logger.warn('[Vision] fetchImageUrlFromGreenApi failed', { error: err.message });
    }
  }

  // ── Download image from URL into memory ──
  if (!base64DataUrl && imageUrl) {
    try {
      const buffer = await downloadImageBuffer(imageUrl);
      base64DataUrl = bufferToDataUrl(buffer);
      logger.info('[Vision] Image downloaded from URL', {
        sizeKB: Math.round(buffer.length / 1024),
      });
    } catch (err) {
      logger.warn('[Vision] Image download from URL failed', { error: err.message });
    }
  }

  // ── Fallback: use jpegThumbnail from Green API payload ──
  if (!base64DataUrl && jpegThumb) {
    logger.info('[Vision] Using jpegThumbnail as fallback');
    base64DataUrl = jpegThumb.startsWith('data:')
      ? jpegThumb
      : `data:image/jpeg;base64,${jpegThumb}`;
  }

  // ── No image available ──
  if (!base64DataUrl) {
    logger.warn('[Vision] No image data available after all attempts');
    return { identified: null, matches: [], noUrl: true };
  }

  // ── Send to Groq Vision ──
  let visionResult = null;
  try {
    visionResult = await analyseWithGroqVision(base64DataUrl);
  } catch (err) {
    logger.error('[Vision] Groq vision failed', { error: err.message });
    return { identified: null, matches: [] };
  }

  if (!visionResult?.detected_text) {
    return { identified: null, matches: [] };
  }

  const matches    = matchToCatalog(visionResult);
  const identified = visionResult.detected_text;

  logger.info('[Vision] Pipeline complete', { identified, matches: matches.length });
  return { identified, matches };
}

// ── Utility exports ───────────────────────────────────────────────────────────
function findMatchesByDescription({ brand, model, color, query } = {}) {
  const catalog = memoryStore.getCatalog();
  return catalog
    .filter((p) => p.inStock)
    .map((p) => {
      let score = 0;
      if (brand && p.brand?.toLowerCase().includes(brand.toLowerCase())) score += 4;
      if (model && p.name?.toLowerCase().includes(model.toLowerCase().split(' ')[0])) score += 3;
      if (color && p.color?.toLowerCase().includes(color.toLowerCase())) score += 2;
      if (query) {
        const hay = `${p.name} ${p.brand} ${p.category} ${p.color}`.toLowerCase();
        if (hay.includes(query.toLowerCase())) score += 2;
      }
      return { product: p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((x) => x.product);
}

module.exports = {
  matchSneakerFromImage,
  findMatchesByDescription,
  downloadImageBuffer,
  fetchImageUrlFromGreenApi,
  bufferToDataUrl,
  analyseWithGroqVision,
};
