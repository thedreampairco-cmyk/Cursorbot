import express from "express";
import { sendTextMessage } from "../services/whatsapp/greenApiText.js";
import { generateAIResponse } from "../services/ai/aiIntegration.js";

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const data = req.body;

    console.log("📩 Incoming Webhook:", JSON.stringify(data, null, 2));

    // Acknowledge immediately
    res.sendStatus(200);

    // ✅ Only process incoming user messages
    if (data.typeWebhook !== "incomingMessageReceived") {
      return;
    }

    const messageData = data.messageData;
    const chatId = data.senderData?.chatId;

    if (!chatId || !messageData) return;

    let userText = "";

    // Handle normal text
    if (messageData.typeMessage === "textMessage") {
      userText = messageData.textMessageData?.textMessage;
    }

    // Handle extended text
    if (messageData.typeMessage === "extendedTextMessage") {
      userText = messageData.extendedTextMessageData?.text;
    }

    if (!userText) return;

    console.log("💬 User Message:", userText);

    // 🔥 AI RESPONSE
    const aiReply = await generateAIResponse(userText);

    await sendTextMessage(chatId, aiReply);

  } catch (error) {
    console.error("❌ Webhook Error:", error);
  }
});

export default router;
