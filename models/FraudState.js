const mongoose = require('mongoose');

const FraudStateSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true, index: true },
    phone: { type: String, required: true, index: true },
    paymentMethod: { type: String, enum: ['prepaid', 'cod'], required: true },

    deposit: {
      required: { type: Boolean, default: false },
      amount: { type: Number, default: 500 },
      status: { type: String, enum: ['pending', 'paid', 'waived'], default: 'pending' },
      razorpayLinkId: { type: String },
      razorpayPaymentId: { type: String },
      paidAt: { type: Date },
    },

    location: {
      status: { type: String, enum: ['pending', 'verified', 'failed', 'skipped'], default: 'pending' },
      receivedAt: { type: Date },
      latitude: { type: Number },
      longitude: { type: Number },
      resolvedPincode: { type: String },
      orderPincode: { type: String },
      pincodeMatch: { type: Boolean },
    },

    unboxing: {
      contractSentAt: { type: Date },
      videoReceivedAt: { type: Date },
      videoMediaId: { type: String },
    },

    overallStatus: {
      type: String,
      enum: ['awaiting_deposit', 'awaiting_location', 'cleared', 'blocked', 'escalated'],
      default: 'awaiting_deposit',
    },

    blockedReason: { type: String },
    adminNotifiedAt: { type: Date },
    attemptCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

FraudStateSchema.methods.isCleared = function () {
  return this.overallStatus === 'cleared';
};

FraudStateSchema.methods.isBlocked = function () {
  return this.overallStatus === 'blocked';
};

module.exports = mongoose.model('FraudState', FraudStateSchema);
