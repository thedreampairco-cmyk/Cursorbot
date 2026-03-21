const express = require("express");
const router = express.Router();
router.post("/onboard", async (req, res) => {
  const { businessName, greenApiUrl, sheetId, whatsappNumber } = req.body;
const Client = require("../models/Client");
// ⬇️ ADD THIS LINE ⬇️
const { sendMessage } = require("../services/greenApi");  
  const newClient = {
    clientId: Date.now().toString(),
    businessName,
    greenApiUrl,
    sheetId,
    whatsappNumber,
    syncToken: `SECRET_${Math.random().toString(36).substring(7)}`,
    status: "active"
  };

  // 1. Save to clients.json
  // 2. Automatically send a "Welcome" message to their WhatsApp
  await sendMessage(whatsappNumber, `Welcome to the SaaS! Your Master Bot is now live.`, greenApiUrl);

  res.json({ message: "Onboarding successful!", config: newClient });
});

module.exports = router;
