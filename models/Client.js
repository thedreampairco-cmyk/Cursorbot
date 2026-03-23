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
    waId:      { type: String, required: true, unique: true, index: true },
    name:      { type: String, default: '' },

    messages:     { type: [MessageSchema], default: [] },
    preferences:  { type: PreferenceSchema, default: () => ({}) },
    browseHistory:{ type: [BrowseEventSchema], default: [] },

    leadScore:    { type: Number, default: 0 },
    tags:         [String],
    segment:      { type: String, default: 'new' },

    // Cart — persisted in MongoDB so server restarts don't wipe it
    cart:             { type: mongoose.Schema.Types.Mixed, default: [] },
    lastCartActivity: Date,
    cartAbandoned:    { type: Boolean, default: false },

    // Last product mentioned — persisted so "add to cart" works after restart
    lastMentionedProduct: { type: mongoose.Schema.Types.Mixed, default: null },

    // Checkout session — persisted so multi-step flow survives restarts
    checkoutSession: { type: mongoose.Schema.Types.Mixed, default: null },

    handoffActive: { type: Boolean, default: false },

    lastMessageAt:  { type: Date, default: Date.now },
    firstMessageAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

ClientSchema.pre('save', function (next) {
  if (this.messages.length > 50) {
    this.messages = this.messages.slice(-50);
  }
  next();
});

ClientSchema.methods.addMessage = function (role, content) {
  this.messages.push({ role, content, timestamp: new Date() });
  this.lastMessageAt = new Date();
};

module.exports = mongoose.model('Client', ClientSchema);
