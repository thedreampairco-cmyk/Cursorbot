require("dotenv").config();

// CONFIG & PROMPTS
const { buildSystemPrompt } = require("./services/buildSystemPrompt");

// SERVICES
const { getAIResponse } = require("./services/aiResponse");
const { getVisionAnalysis } = require("./services/visionService");

// --- GREEN API SERVICE ---
const { sendMessage, sendMediaByUrl, setProduct } = require("./services/greenApi");

// --- INVENTORY SERVICE ---
const { getInventory, searchProducts, getInventoryText } = require("./inventory");

// ROUTES
const webhookRouter = require("./routes/webhook");

// ==========================================
// 🚀 THE DREAM PAIR EXPORTS
// ==========================================
module.exports = {
  getAIResponse,
  getVisionAnalysis,
  sendMessage,
  sendMediaByUrl,
  sendMedia,
  setProduct,
  getInventory,
  searchProducts,
  getInventoryText,
  buildSystemPrompt,
  webhookRouter
};
