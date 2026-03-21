import express from "express";
import { sendTextMessage } from "../services/whatsapp/greenApiText.js";

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const data = req.body;

    console.log("📩 Incoming Webhook:", JSON.stringify(data, null, 2));

    // Acknowledge immediately
    res.sendStatus(200);

    // Extract chatId safely
    const chatId = data?.senderData?.chatId;

    if (!chatId) return;

    // TEMP TEST RESPONSE
    await sendTextMessage(chatId, "👋 Hello! Maya here. Your AI assistant is now active.");

  } catch (error) {
    console.error("❌ Webhook Error:", error);
  }
});

export default router;
