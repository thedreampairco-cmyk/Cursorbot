// services/aiResponse.js
const axios = require('axios');
const { GROQ_API_URL, GROQ_MODEL } = require('../config/api');
const env = require('../config/env');
const { findItemByName } = require('./inventoryService');

// 1. Define the tools Maya has access to
const tools = [
  {
    type: "function",
    function: {
      name: "lookup_sneaker_details",
      description: "Look up a sneaker's details (price, sizes, stock, and image URL) by name from the inventory sheet.",
      parameters: {
        type: "object",
        properties: {
          sneaker_name: {
            type: "string",
            description: "The name of the sneaker to look up, e.g., 'Jordan 1' or 'Air Force'"
          }
        },
        required: ["sneaker_name"]
      }
    }
  }
];

/**
 * Calls the Groq LLM API to generate Maya's response, handling tool calls for inventory lookups.
 * @param {Array} messageHistory - Array of message objects
 * @returns {Promise<{text: string, mediaUrl: string|null, mediaName: string|null} | null>}
 */
async function generateMayaResponse(messageHistory) {
  try {
    const payload = {
      model: GROQ_MODEL,
      messages: messageHistory,
      temperature: 0.2, // Keep low for business consistency
      max_tokens: 1024,
      tools: tools,
      tool_choice: "auto" // Let Maya decide when to use the tool
    };

    const response = await axios.post(GROQ_API_URL, payload, {
      headers: {
        'Authorization': `Bearer ${env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const responseMessage = response.data.choices[0].message;

    // 2. Check if Maya decided to call our tool
    if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
      const toolCall = responseMessage.tool_calls[0];

      if (toolCall.function.name === 'lookup_sneaker_details') {
        const args = JSON.parse(toolCall.function.arguments);
        console.log(`[Groq AI] Tool Called: lookup_sneaker_details for "${args.sneaker_name}"`);

        // 3. Fetch data from Google Sheets using the exact SHEET_ID from your .env
        const sneakerData = await findItemByName(env.SHEET_ID, args.sneaker_name);

        // 4. Append the tool call and the result to the message history so Maya sees the data
        messageHistory.push(responseMessage); // Add the assistant's tool call request

        // Format the response for Maya. If the shoe exists, give her the details. If not, tell her it's missing.
        const toolResultContent = sneakerData
          ? JSON.stringify(sneakerData)
          : JSON.stringify({ error: "Sneaker not found in inventory." });

        messageHistory.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: toolResultContent
        });

        // 5. Call Groq AGAIN so Maya can write a natural reply using the newly fetched data
        const secondPayload = {
          model: GROQ_MODEL,
          messages: messageHistory,
          temperature: 0.2,
          max_tokens: 1024
        };

        const secondResponse = await axios.post(GROQ_API_URL, secondPayload, {
          headers: {
            'Authorization': `Bearer ${env.GROQ_API_KEY}`,
            'Content-Type': 'application/json'
          }
        });

        const finalText = secondResponse.data.choices[0].message.content;

        // Return both the final text AND the extracted image URL to the webhook
        return {
          text: finalText,
          // FIX: Fetch strictly from the sheet data URL, ignoring specific image names
          mediaUrl: sneakerData ? sneakerData.imageUrl : null,
          mediaName: sneakerData ? 'product_image.jpeg' : null 
        };
      }
    }

    // 6. If no tool was called (e.g., standard conversation), just return the text
    return {
      text: responseMessage.content,
      mediaUrl: null,
      mediaName: null
    };

  } catch (error) {
    console.error('[Groq API Error] Failed to generate AI response:', error.response?.data || error.message);
    return null;
  }
}

module.exports = {
  generateMayaResponse
};
