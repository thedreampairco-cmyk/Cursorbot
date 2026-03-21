const express = require("express");
const router = express.Router();
// ✅ FIX: We import the function directly, NOT a 'greenApi' object
const { setProduct } = require("../import");

router.post("/sync-catalog", async (req, res) => {
  try {
    const syncToken = req.headers['x-sync-token'];

    // Security Check
    if (!syncToken || syncToken !== process.env.SYNC_TOKEN) {
      console.log("⚠️ Unauthorized Sync Attempt");
      return res.status(403).json({ error: "Unauthorized" });
    }

    const { id, name, category, price, stock, imageUrl, gender } = req.body;

    // Build the WhatsApp Catalog Payload
    const catalogPayload = {
      productId: id.toString(),
      name: `${name} (${gender})`,
      price: parseFloat(price),
      description: `Category: ${category} | Sizes Available.`,
      isAvailable: parseInt(stock) > 0,
      imageLink: imageUrl
    };

    // ✅ FIX: Call setProduct directly
    const result = await setProduct(catalogPayload);

    if (result) {
      console.log(`✅ Auto-Sync Success: ${name} (Stock: ${stock})`);
      return res.status(200).json({ message: "Catalog updated" });
    }
  } catch (err) {
    console.error("❌ Sync Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
