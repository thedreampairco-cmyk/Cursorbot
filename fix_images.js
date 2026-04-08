const fs = require('fs');

// ── Fix 1: greenApiMedia.js — remove wrong Bearer auth ──────────────────────
const mediaFile = 'services/whatsapp/greenApiMedia.js';
let media = fs.readFileSync(mediaFile, 'utf8');

media = media.replace(
  `      headers: { Authorization: \`Bearer \${TOKEN}\` },`,
  `      // Green API auth is in the URL path — no extra headers needed`
);

// Remove now-unused TOKEN constant
media = media.replace(
  `const TOKEN = process.env.GREEN_API_TOKEN;\n`,
  ``
);

fs.writeFileSync(mediaFile, media);
console.log('greenApiMedia.js fixed');

// ── Fix 2 & 3: whatsappService.js ───────────────────────────────────────────
const wsFile = 'services/features/whatsappService.js';
let ws = fs.readFileSync(wsFile, 'utf8');

// Add greenApiMedia import at top after axios require
ws = ws.replace(
  `const axios = require("axios");`,
  `const axios = require("axios");\nconst { sendImageByUrl } = require("../whatsapp/greenApiMedia");`
);

// Fix sendImage — delegate to greenApiMedia instead of raw axios
const oldSendImage = `async function sendImage(to, imageUrl, caption = "") {
  try {
    const chatId = \`\${to}@c.us\`;
    await axios.post(endpoint("sendFileByUrl"), {
      chatId,
      urlFile: imageUrl,
      fileName: "sneaker.jpg",
      caption,
    });
  } catch (err) {
    console.error("[WhatsApp] sendImage failed:", err.response?.data || err.message);
  }
}`;

const newSendImage = `async function sendImage(to, imageUrl, caption = "") {
  try {
    // Fix Drive URLs: export=download redirects break Green API — use export=view
    const fixedUrl = imageUrl.includes('drive.google.com/uc?export=download')
      ? imageUrl.replace('export=download', 'export=view')
      : imageUrl;
    await sendImageByUrl(to, fixedUrl, caption);
  } catch (err) {
    console.error("[WhatsApp] sendImage failed:", err.message);
  }
}`;

ws = ws.replace(oldSendImage, newSendImage);

// Fix sendPaymentLink — replace hardcoded ₹500 with dynamic tokenAmount
ws = ws.replace(
  '`💳 *Complete your ₹500 token here:*\\n`',
  '`💳 *Complete your ₹${tokenAmount} token here:*\\n`'
);

fs.writeFileSync(wsFile, ws);
console.log('whatsappService.js fixed');
