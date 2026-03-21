import axios from "axios";
import { ENV } from "../../config/env.js";

const BASE_URL = `https://api.green-api.com/waInstance${ENV.GREEN_API_ID_INSTANCE}`;

export const sendTextMessage = async (chatId, message) => {
  try {
    const url = `${BASE_URL}/sendMessage/${ENV.GREEN_API_API_TOKEN_INSTANCE}`;

    const response = await axios.post(url, {
      chatId,
      message,
    });

    console.log("✅ Message sent:", response.data);
    return response.data;

  } catch (error) {
    console.error("❌ Error sending message:", error.response?.data || error.message);
  }
};
