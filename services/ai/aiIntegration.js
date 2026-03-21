import axios from "axios";
import { ENV } from "../../config/env.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export const generateAIResponse = async (userMessage) => {
  try {
    const response = await axios.post(
      GROQ_URL,
      {
        model: "llama3-8b-8192",
        messages: [
          {
            role: "user",
            content: userMessage,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${ENV.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const aiText =
      response.data?.choices?.[0]?.message?.content || "Sorry, I didn't understand that.";

    return aiText;

  } catch (error) {
    console.error(
      "❌ Groq API Error:",
      error.response?.data || error.message
    );

    return "⚠️ Maya is having trouble responding right now. Please try again.";
  }
};
