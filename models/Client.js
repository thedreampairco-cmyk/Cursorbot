'use strict';

const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const PreferenceSchema = new mongoose.Schema(
  {
    brand: [String],
    category: [String],
    size: [String],
    color: [String],
    priceMin: Number,
    priceMax: Number,
  },
  { _id: false }
);

const BrowseEventSchema = new mongoose.Schema(
  {
    productId: String,
    productName: String,
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const ClientSchema = new mongoose.Schema(
  {
    // WhatsApp number (e.g. "919876543210@c.us")
    waId: { type: String, required: true, unique: true, index: true },
    name: { type: String, default: '' },

    // Rolling conversation window (last 50 messages)
    messages: { type: [MessageSchema], default: [] },

    preferences: { type: PreferenceSchema, default: () => ({}) },
    browseHistory: { type: [BrowseEventSchema], default: [] },

    // Lead & marketing
    leadScore: { type: Number, default: 0 },
    tags: [String],
    segment: { type: String, default: 'new' }, // new | warm | hot | customer

    // Cart
    cart: { type: mongoose.Schema.Types.Mixed, default: [] },
    lastCartActivity: Date,
    cartAbandoned: { type: Boolean, default: false },

    // Handoff
    handoffActive: { type: Boolean, default: false },

    // Timestamps
    lastMessageAt: { type: Date, default: Date.now },
    firstMessageAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Trim message history to last 50 entries before saving
ClientSchema.pre('save', function (next) {
  if (this.messages.length > 50) {
    this.messages = this.messages.slice(-50);
  }
  next();
});

// Helper: push a new message and update lastMessageAt
ClientSchema.methods.addMessage = function (role, content) {
  this.messages.push({ role, content, timestamp: new Date() });
  this.lastMessageAt = new Date();
};

module.exports = mongoose.model('Client', ClientSchema);
