const mongoose = require('mongoose');
const User = require('./models/User'); // Adjust path to your User model
require('dotenv').config();

const testUser = {
  whatsappNumber: "918426862111@c.us", 
  name: "Ankit",
  shoeSize: 10,
  recentlyViewed: ["Adidas tokyo", "puma speedcast"],
  // 🛒 Adding a test item to the cart to verify Maya's memory
  cart: [
    { product: "adidas taekwondo", price: 4200 }
  ],
  purchased: []
};

async function seedTestUser() {
  try {
    // Ensure MONGODB_URI is correctly set in your .env file
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ Connected to MongoDB");

    // Using returnDocument: 'after' to satisfy the latest Mongoose standards
    await User.findOneAndUpdate(
      { whatsappNumber: testUser.whatsappNumber },
      testUser,
      { 
        upsert: true, 
        returnDocument: 'after' 
      }
    );

    console.log(`🚀 Success! User "${testUser.name}" (918426862111) is now in the database with a Jordan in their cart.`);
    console.log("----------------------------------------------------------------");
    console.log("TEST INSTRUCTIONS:");
    console.log("1. Send 'Hi' to Maya.");
    console.log("2. Ask: 'Maya, mere cart mein kya hai?' (What's in my cart?)");
    console.log("3. See if she lists the Jordan 1 Retro High from the database!");
    console.log("----------------------------------------------------------------");

    process.exit();
  } catch (err) {
    console.error("❌ MongoDB Error:", err);
    process.exit(1);
  }
}

seedTestUser();
