import express from "express";
import { sendTextMessage } from "../services/whatsapp/greenApiText.js";

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const data = req.body;

    console.log("📩 Incoming Webhook:", JSON.stringify(data, null, 2));

    // Acknowledge immediately
    res.sendStatus(200);

    // ✅ Only incoming user messages
    if (data.typeWebhook !== "incomingMessageReceived") {
      return;
    }

    const messageData = data.messageData;
    const chatId = data.senderData?.chatId;

    if (!chatId || !messageData) return;

    let userText = "";

    // ✅ Handle normal text
    if (messageData.typeMessage === "textMessage") {
      userText = messageData.textMessageData?.textMessage;
    }

    // ✅ Handle extended text (MOST IMPORTANT)
    if (messageData.typeMessage === "extendedTextMessage") {
      userText = messageData.extendedTextMessageData?.text;
    }

    if (!userText) return;

    console.log("💬 User Message:", userText);

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
