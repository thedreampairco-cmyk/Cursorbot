require('dotenv').config();
const mongoose = require('mongoose');

async function addTestImages() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error("❌ Cannot find MONGO_URI in .env file.");
    process.exit(1);
  }
  
  try {
    await mongoose.connect(uri);
    console.log("✅ Connected to MongoDB...");
    
    // We use the raw collection to avoid needing your exact Model file
    const collection = mongoose.connection.collection('products');
    
    // The Unsplash sneaker image we know works
    const testImageUrl = "https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=500&q=80";
    
    const result = await collection.updateMany(
      { $or: [ { imgUrl: { $exists: false } }, { imgUrl: null } ] },
      { $set: { imgUrl: testImageUrl } }
    );
    
    console.log(`✅ Successfully added test images to ${result.modifiedCount} sneakers!`);
    process.exit(0);
  } catch (err) {
    console.error("❌ Error updating database:", err.message);
    process.exit(1);
  }
}

addTestImages();
