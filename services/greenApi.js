// services/greenApi.js
require('dotenv').config();

const GREEN_API_ID_INSTANCE = process.env.GREEN_API_ID_INSTANCE;
const GREEN_API_API_TOKEN_INSTANCE = process.env.GREEN_API_API_TOKEN_INSTANCE;
console.log("ID:", GREEN_API_ID_INSTANCE);
console.log("TOKEN:", GREEN_API_API_TOKEN_INSTANCE);
/**
 * Sends a standard text message via Green API.
 */
async function sendMessage(chatId, message) {
    const url = `https://api.green-api.com/waInstance${GREEN_API_ID_INSTANCE}/sendMessage/${GREEN_API_API_TOKEN_INSTANCE}`;

    const payload = {
        chatId: chatId,
        message: message
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`Green API Text Error: ${response.status} - ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        console.error("[Green API] Error in sendMessage:", error.message);
        throw error;
    }
}

/**
 * Sends a media file via URL to a WhatsApp chat.
 * Expects a direct, raw image URL (handled by urlHelper).
 */
async function sendMediaByUrl(chatId, fileUrl, fileName, caption = "") {
    const url = `https://api.green-api.com/waInstance${GREEN_API_ID_INSTANCE}/sendFileByUrl/${GREEN_API_API_TOKEN_INSTANCE}`;

    // --- Resilient fileName Generation ---
    let safeFileName = "sneaker-image.jpeg";

    if (fileName && typeof fileName === 'string') {
        safeFileName = fileName.replace(/[^a-zA-Z0-9-.]/g, '_');
        if (!safeFileName.match(/\.(jpg|jpeg|png)$/i)) {
            safeFileName = safeFileName.replace(/\.+$/, '') + '.jpeg';
        }
    }

    console.log(`[Green API] Sending media: ${fileUrl} as ${safeFileName}`);

    const payload = {
        chatId: chatId,
        urlFile: fileUrl,
        fileName: safeFileName,
        caption: caption
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`Green API Media Error: ${response.status} - ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        console.error("[Green API] Error in sendMediaByUrl:", error.message);
        throw error;
    }
}

module.exports = {
    sendMediaByUrl,
    sendMessage
};
