// routes/webhook.js

const express = require("express");
const router = express.Router();

const { sendMessage } = require("../services/greenApi");

/**
 * Green API Webhook Handler
 * Receives incoming WhatsApp messages
 */
router.post("/", async (req, res) => {
  try {
    const body = req.body;

    console.log("📩 Incoming Webhook:", JSON.stringify(body, null, 2));

    // ✅ Only process incoming messages
    if (body.typeWebhook !== "incomingMessageReceived") {
      return res.sendStatus(200);
    }

    const messageData = body.messageData;

    // ❌ Ignore non-text for now (Step 1 scope)
    if (!messageData?.textMessageData?.textMessage) {
      return res.sendStatus(200);
    }

    const userMessage = messageData.textMessageData.textMessage;
    const chatId = body.senderData.chatId;

    console.log(`👤 User (${chatId}): ${userMessage}`);

    // ✅ TEMP RESPONSE (Step 1 validation)
    await sendMessage(chatId, "Maya is online ✅");

    return res.sendStatus(200);

  } catch (error) {
    console.error("❌ Webhook Error:", error.message);
    return res.sendStatus(500);
  }
});

module.exports = router;
