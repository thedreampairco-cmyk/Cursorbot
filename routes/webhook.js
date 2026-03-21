import express from "express";
import { sendTextMessage } from "../services/whatsapp/greenApiText.js";

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const data = req.body;

    console.log("📩 Incoming Webhook:", JSON.stringify(data, null, 2));

    // Always acknowledge first
    res.sendStatus(200);

    // ✅ CRITICAL FILTER
    if (data.typeWebhook !== "incomingMessageReceived") {
      return;
    }

    const messageData = data.messageData;

    // Only process text messages
    if (messageData?.typeMessage !== "textMessage") {
      return;
    }

    const chatId = data.senderData?.chatId;
    const text = messageData?.textMessageData?.textMessage;

    if (!chatId || !text) return;

    console.log("💬 User Message:", text);

    // TEMP RESPONSE
    await sendTextMessage(
      chatId,
      "👋 Hello! Maya here. Your AI assistant is now active."
    );

  } catch (error) {
    console.error("❌ Webhook Error:", error);
  }
});

export default router;
