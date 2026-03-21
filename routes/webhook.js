import express from "express";
import { sendTextMessage } from "../services/whatsapp/greenApiText.js";
import { generateAIResponse } from "../services/ai/aiIntegration.js";
import { saveUserMessage } from "../services/data/memoryStore.js";

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const data = req.body;

    console.log("📩 Incoming Webhook:", JSON.stringify(data, null, 2));

    res.sendStatus(200);

    if (data.typeWebhook !== "incomingMessageReceived") {
      return;
    }

    const messageData = data.messageData;
    const chatId = data.senderData?.chatId;

    if (!chatId || !messageData) return;

    let userText = "";

    if (messageData.typeMessage === "textMessage") {
      userText = messageData.textMessageData?.textMessage;
    }

    if (messageData.typeMessage === "extendedTextMessage") {
      userText = messageData.extendedTextMessageData?.text;
    }

    if (!userText) return;

    console.log("💬 User Message:", userText);

    // ✅ Save user message
    saveUserMessage(chatId, "user", userText);

    // ✅ Generate AI response with memory
    const aiReply = await generateAIResponse(chatId, userText);

    // ✅ Save AI response
    saveUserMessage(chatId, "assistant", aiReply);

    await sendTextMessage(chatId, aiReply);

  } catch (error) {
    console.error("❌ Webhook Error:", error);
  }
});

export default router;
