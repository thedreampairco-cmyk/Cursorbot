const mongoose = require('mongoose');
const Client = require('./models/Client'); 
require('dotenv').config();

async function fix() {
  await mongoose.connect(process.env.MONGODB_URI);
  
  // This tells your server: "7103529867 is the official ID for TheDreamPair"
  await Client.findOneAndUpdate(
    { idInstance: "7103529867" }, 
    {
      businessName: "The Dream Pair",
      idInstance: "7103529867",
      apiTokenInstance: process.env.GREEN_API_TOKEN || "YOUR_TOKEN", 
      status: "active"
    },
    { upsert: true }
  );
  console.log("✅ Gate Opened! TheDreamPair is now active.");
  process.exit();
}
fix();
