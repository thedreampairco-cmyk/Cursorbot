// config/env.js
require('dotenv').config();

module.exports = {
    BOT_NAME: process.env.BOT_NAME || 'TheDreamPair',
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GREEN_API_ID_INSTANCE: process.env.GREEN_API_ID_INSTANCE,
    GREEN_API_API_TOKEN_INSTANCE: process.env.GREEN_API_API_TOKEN_INSTANCE,
    PORT: process.env.PORT || 3000,
    SHEET_ID: process.env.SHEET_ID,
    GOOGLE_VISION_API_KEY: process.env.GOOGLE_VISION_API_KEY,
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    SYNC_TOKEN: process.env.SYNC_TOKEN,
    MONGODB_URI: process.env.MONGODB_URI
};
