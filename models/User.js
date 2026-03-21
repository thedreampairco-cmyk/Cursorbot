const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  whatsappNumber: { type: String, required: true, unique: true },
  name: String,
  shoeSize: Number,
  history: Array, // Optional: store last few messages
  cart: Array,
  favorites: Array,
  purchased: Array,
  recentlyViewed: Array,
  lastInteraction: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', UserSchema);
