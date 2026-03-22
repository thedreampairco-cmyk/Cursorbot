'use strict';

const { groqClient } = require('../../config/api');
const env = require('../../config/env');
const { logger } = require('../../errorHandler');
const { buildSystemPrompt } = require('./buildSystemPrompt');
const memoryStore = require('../data/memoryStore');

// ── Intent extraction ─────────────────────────────────────────────────────────

function extractIntents(text) {
  const intents = {
    wantsBuy: false,
    wantsImages: [],
    wantsHandoff: false,
    wantsReengagement: false,
  };

  if (/\[INTENT:BUY\]/.test(text)) intents.wantsBuy = true;
  if (/\[INTENT:HANDOFF\]/.test(text)) intents.wantsHandoff = true;
  if (/\[INTENT:REENGAGEMENT\]/.test(text)) intents.wantsReengagement = true;

  const imgMatch = text.match(/\[INTENT:IMAGES:([^\]]+)\]/);
  if (imgMatch) {
    intents.wantsImages = imgMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
  }

  return intents;
}

/**
 * Strip internal intent tags from AI response before sending to customer.
 */
function stripIntentTags(text) {
  return text
    .replace(/\[INTENT:[^\]]+\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Resolve product IDs returned by the AI into catalog objects.
 */
function resolveProducts(ids) {
  return ids.map((id) => memoryStore.findById(id)).filter(Boolean);
}

/**
 * Main AI message handler.
 * Sends conversation history + system prompt to Groq, returns structured result.
 *
 * @param {object} client   - Client Mongoose doc
 * @param {string} userText - latest user message
 * @returns {{ reply: string, intents: object, products: object[] }}
 */
async function processMessage(client, userText) {
  const systemPrompt = buildSystemPrompt(client);

  // Build Groq messages from rolling history
  const historyMessages = (client.messages || []).slice(-20).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const messages = [
    { role: 'user', content: userText },
  ];

  // Prepend history (Groq expects alternating roles)
  if (historyMessages.length) {
    messages.unshift(...historyMessages);
  }

  let rawReply = '';
  try {
    const response = await groqClient.post('/chat/completions', {
      model: env.groq.model,
      max_tokens: 600,
      temperature: 0.7,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    });

    rawReply = response.data?.choices?.[0]?.message?.content || '';
  } catch (err) {
    logger.error('[AI] Groq API call failed', { error: err.message });
    return {
      reply: "I'm having a little trouble right now 😅 Please try again in a moment!",
      intents: extractIntents(''),
      products: [],
    };
  }

  const intents = extractIntents(rawReply);
  const cleanReply = stripIntentTags(rawReply);
  const products = resolveProducts(intents.wantsImages);

  logger.debug('[AI] Reply generated', { wantsBuy: intents.wantsBuy, imageCount: products.length });

  return { reply: cleanReply, intents, products };
}

/**
 * Analyse a user-sent image URL for sneaker similarity.
 * Uses Groq vision (llama3-vision if available) or falls back to text stub.
 */
async function analyseImageForSneakers(imageUrl) {
  if (!imageUrl) return null;
  try {
    const response = await groqClient.post('/chat/completions', {
      model: env.groq.model,
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageUrl } },
            {
              type: 'text',
              text: 'Identify the sneaker brand and model in this image. Reply with just: Brand | Model | Primary Color. If unsure, say Unknown.',
            },
          ],
        },
      ],
    });
    return response.data?.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

module.exports = { processMessage, analyseImageForSneakers };
