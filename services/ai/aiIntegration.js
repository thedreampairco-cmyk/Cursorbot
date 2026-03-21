import axios from "axios";
import { ENV } from "../../config/env.js";
import { buildSystemPrompt } from "./buildSystemPrompt.js";
import { getUserMemory } from "../data/memoryStore.js";
import { handleError } from "../../errorHandler.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export const generateAIResponse = async (chatId, userMessage) => {
  try {
    const history = getUserMemory(chatId);

    const response = await axios.post(
      GROQ_URL,
      {
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: buildSystemPrompt(),
          },
          ...history,
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
        timeout: 10000 // ⏱️ 10 sec timeout
      }
    );

    const aiText =
      response.data?.choices?.[0]?.message?.content ||
      "Sorry, I didn't understand that.";

    return aiText;

  } catch (error) {
    handleError("Groq AI", error);

    return "⚠️ I'm having a little delay right now... try again in a moment 🙏";
  }
};
