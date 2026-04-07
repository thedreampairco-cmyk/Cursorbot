const axios = require("axios");
const { GROQ_API_URL, GROQ_MODEL } = require("../config/api");
const { GROQ_API_KEY } = require("../config/env");

const SYSTEM_PROMPT = require("../prompts/systemPrompt");

async function getAIResponse(message) {
  try {
    const response = await axios.post(
      GROQ_API_URL,
      {
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: message }
        ]
      },
      {
        headers: {
          "Authorization": `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    return response.data.choices[0].message.content;
  } catch (error) {
    console.error("AI Error:", error.response?.data || error.message);
    return "Sorry, something went wrong. Please try again later.";
  }
}

module.exports = { getAIResponse };
