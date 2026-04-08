require('dotenv').config();
const wa = require('./services/whatsapp/greenApiMedia'); // testing the patched file directly

const phone = "918426862111@c.us";
const safeUrl = "https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=500&q=80";

console.log("🚀 Testing Green API Image Dispatch...");
wa.sendImageByUrl(phone, safeUrl, "👟 Architect Test Image")
  .then(() => console.log("✅ SUCCESS: Green API dispatched the image!"))
  .catch(err => console.error("❌ FAILED: ", err.message || err));
