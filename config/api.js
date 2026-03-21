// config/api.js
const { GREEN_API_ID_INSTANCE, GREEN_API_API_TOKEN_INSTANCE } = require('./env');

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

// Constructs the full endpoint for sending messages via Green API
const GREEN_API_URL = `https://api.green-api.com/waInstance${GREEN_API_ID_INSTANCE}/sendMessage/${GREEN_API_API_TOKEN_INSTANCE}`;

module.exports = {
  GROQ_API_URL,
  GROQ_MODEL,
  GREEN_API_URL
};
