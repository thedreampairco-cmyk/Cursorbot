'use strict';

const mongoose = require('mongoose');

const OrderItemSchema = new mongoose.Schema(
  {
    productId: String,
    productName: String,
    brand: String,
    size: String,
    color: String,
    price: Number,
    quantity: { type: Number, default: 1 },
    imageUrl: String,
  },
  { _id: false }
);

const OrderSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true, index: true },
    waId: { type: String, required: true, index: true },
    customerName: String,
    items: [OrderItemSchema],

    status: {
      type: String,
      enum: ['pending_payment', 'paid', 'confirmed', 'shipped', 'delivered', 'cancelled'],
      default: 'pending_payment',
    },

    totalAmount: { type: Number, required: true },

    // Payment
    paymentMethod: { type: String, enum: ['razorpay', 'upi', 'cod', 'other'], default: 'razorpay' },
    razorpayOrderId: String,
    razorpayPaymentId: String,
    paymentLink: String,
    paidAt: Date,

    // Shipping
    awbNumber: String,
    shippingProvider: String,
    shippedAt: Date,
    deliveredAt: Date,

    // Address
    shippingAddress: {
      line1: String,
      city: String,
      state: String,
      pincode: String,
    },

    notes: String,
  },
  { timestamps: true }
);

const userSchema = new mongoose.Schema({
  // ... your user fields (name, phone, etc.)
});
module.exports = mongoose.models.User || mongoose.model('User', userSchema);
