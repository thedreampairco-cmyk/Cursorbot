import express from "express";

const router = express.Router();

// WhatsApp Webhook Endpoint
router.post("/", async (req, res) => {
  try {
    const data = req.body;

    console.log("📩 Incoming Webhook:", JSON.stringify(data, null, 2));

    // Acknowledge immediately (VERY IMPORTANT for Green API)
    res.sendStatus(200);

    // NOTE:
    // We will process this data in next steps
    // (message parsing, AI response, etc.)

  } catch (error) {
    console.error("❌ Webhook Error:", error);
    res.sendStatus(500);
  }
});

export default router;
