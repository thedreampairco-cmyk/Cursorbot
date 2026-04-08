const wa = require('./services/features/whatsappService');

// Using your number from the earlier logs
const phone = "918426862111@c.us"; 
const safeUrl = "https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=500&q=80"; 

console.log("🚀 Testing Green API Image Dispatch...");
wa.sendImage(phone, safeUrl, "👟 Architect Test Image")
  .then(() => console.log("✅ SUCCESS: Green API and whatsappService.js are working!"))
  .catch(err => console.error("❌ FAILED: ", err.message || err));
