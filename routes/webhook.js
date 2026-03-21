// routes/webhook.js
const express = require('express');
const router = express.Router();
// IMPORT FIX: Added sendMediaByUrl
const { sendMessage, sendMediaByUrl } = require('../services/greenApi');
const { generateMayaResponse } = require('../services/aiResponse');
const { buildSystemPrompt } = require('../services/buildSystemPrompt');

/**
 * POST /api/webhook
 * Handles incoming messages from Green API, applies NLP guardrails, and routes to Groq AI.
 */
router.post('/', async (req, res) => {
  try {
    const body = req.body;

    // DIAGNOSTIC FIX: Log the raw body so we know Green API actually hit the server
    console.log('[Webhook] Raw Payload Received:', JSON.stringify(body, null, 2));

    // 1. Filter out delivery receipts/system events
    if (body.typeWebhook !== 'incomingMessageReceived') {
      return res.status(200).send('Ignored: Not an incoming message');
    }

    const messageData = body.messageData;
    const senderData = body.senderData;

    // 2. Process only text messages
    const type = messageData?.typeMessage;

    if (type !== 'textMessage' && type !== 'extendedTextMessage') {
      return res.status(200).send('Ignored: Not a text message');
    }

    const chatId = senderData.chatId;
    let incomingText = '';

    // Extract text based on the specific message type
    if (type === 'textMessage') {
      incomingText = messageData.textMessageData.textMessage;
    } else if (type === 'extendedTextMessage') {
      incomingText = messageData.extendedTextMessageData.text;
    }

    console.log(`[Webhook] User ${chatId} says: "${incomingText}"`);
    
    // 3. Construct message history using the dedicated NLP System Prompt
    const systemMessage = buildSystemPrompt({});

    const messageHistory = [
      systemMessage,
      { role: 'user', content: incomingText }
    ];

    // 4. Generate AI Response via Groq
    console.log('[Webhook] Calling Groq AI...');
    // VARIABLE FIX: Expecting an object now, not just text
    const aiResponse = await generateMayaResponse(messageHistory);
    console.log('[Webhook] Groq AI Response generated:', aiResponse ? 'Success' : 'Failed/Empty');

    // 5. Handle Fallbacks
    if (!aiResponse || !aiResponse.text) {
      // SYNTAX FIX: Repaired the broken string and missing closures
      await sendMessage(chatId, "I'm currently optimizing my systems. Please give me a moment and try again.");
      return res.status(200).send('Success - Fallback Sent');
    }

    // 6. --- STEP 4 IMAGE ROUTING ---
    // If Maya used her tool and found an image URL, send it first!
    if (aiResponse.mediaUrl) {
      console.log(`[Webhook] Tool triggered! Sending Image: ${aiResponse.mediaName}...`);
      try {
        await sendMediaByUrl(chatId, aiResponse.mediaUrl, aiResponse.mediaName, "");
      } catch (mediaError) {
        console.error('[Webhook Error] Failed to send media, continuing with text...', mediaError.message);
      }
    }

    // 7. Send the text reply via Green API
    console.log(`[Webhook] Sending text reply to chatId: ${chatId}...`);
    await sendMessage(chatId, aiResponse.text);
    console.log('[Webhook] Reply successfully dispatched to Green API!');

    // 8. FINALLY, acknowledge receipt to Green API AFTER all logic is done
    return res.status(200).send('Success');

  } catch (error) {
    console.error('[Webhook Error] Critical failure in webhook processing:', error.message || error);
    return res.status(200).send('Error handled gracefully');
  }
});

module.exports = router;
