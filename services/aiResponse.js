const axios = require("axios");
const { GROQ_API_KEY } = require("../config/api");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

async function getAIResponse(userMessage) {
  try {
    const response = await axios.post(
      GROQ_URL,
      {
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: "You are a helpful assistant for a sneaker store.",
          },
          {
            role: "user",
            content: userMessage,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const reply = response?.data?.choices?.[0]?.message?.content;

    if (!reply) {
      throw new Error("Empty response from Groq");
    }

    return reply;
  } catch (error) {
    console.error(
      "❌ Groq API Error:",
      error.response?.data || error.message
    );

    return "Sorry, I'm having trouble responding right now.";
  }
}

module.exports = { getAIResponse };
