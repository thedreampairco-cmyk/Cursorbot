const mongoose = require("mongoose");

// ─── Payment Status State Machine ────────────────────────────────────────────
//
//  AWAITING_TOKEN  ──► TOKEN_RECEIVED ──► DELIVERED
//        │                  │
//        ├──► EXPIRED        └──► RTO_CANCELLED
//        │
//        └──► REFUND_PENDING  (payment received, OOS — ops issues refund)
//
// ─────────────────────────────────────────────────────────────────────────────

const PAYMENT_STATUS = {
  AWAITING_TOKEN:  "AWAITING_TOKEN",   // COD order created; ₹500 token not yet paid
  TOKEN_RECEIVED:  "TOKEN_RECEIVED",   // ₹500 confirmed; size locked in warehouse
  DELIVERED:       "DELIVERED",        // COD balance collected at door
  RTO_CANCELLED:   "RTO_CANCELLED",    // Return-to-origin / cancelled after dispatch
  EXPIRED:         "EXPIRED",          // Token window (15 min) lapsed; slot released
  PREPAID_COMPLETE:"PREPAID_COMPLETE", // Full amount paid online (non-COD path)
  REFUND_PENDING:  "REFUND_PENDING",   // Payment received but OOS — awaiting ops refund
};

const addressSchema = new mongoose.Schema(
  {
    line1:   { type: String, required: true },
    line2:   { type: String, default: "" },
    city:    { type: String, required: true },
    state:   { type: String, required: true },
    pincode: { type: String, required: true, match: /^\d{6}$/ },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    // ── Identifiers ──────────────────────────────────────────────────────────
    order_id: {
      type:     String,
      required: true,
      unique:   true,
      index:    true,
    },
    whatsapp_number: {
      type:     String,
      required: true,
      index:    true,
      // Store in E.164 format: "919876543210"
    },

    // ── Product ──────────────────────────────────────────────────────────────
    product: {
      sku:     { type: String, required: true },   // e.g. "PANDA-WHT-42"
      name:    { type: String, required: true },   // e.g. "New Balance 550 Pandas"
      size:    { type: String, required: true },
      color:   { type: String, default: "" },
      image_url: { type: String, default: "" },
    },

    // ── Payment Breakdown ────────────────────────────────────────────────────
    total_amount: {
      type:     Number,
      required: true,
      min:      0,
      comment:  "Full MRP of the sneaker in INR paise or rupees — store in rupees",
    },
    advance_paid: {
      type:    Number,
      default: 0,
      min:     0,
      comment: "Token amount collected online (e.g. ₹500)",
    },
    cod_balance: {
      type:    Number,
      default: function () {
        return this.total_amount - this.advance_paid;
      },
      comment: "Amount the delivery agent collects at the door",
    },

    // ── Payment Status ───────────────────────────────────────────────────────
    payment_status: {
      type:    String,
      enum:    Object.values(PAYMENT_STATUS),
      default: PAYMENT_STATUS.AWAITING_TOKEN,
      index:   true,
    },

    // ── Payment Gateway Details ──────────────────────────────────────────────
    razorpay: {
      payment_link_id: { type: String, default: null },
      payment_link_url:{ type: String, default: null },
      payment_id:      { type: String, default: null },  // filled on webhook
      order_id:        { type: String, default: null },  // Razorpay order id
      signature:       { type: String, default: null },
      paid_at:         { type: Date,   default: null },
    },

    // ── Token Expiry Window ──────────────────────────────────────────────────
    token_expires_at: {
      type:    Date,
      default: null,
      comment: "Set to Date.now() + 15 min when order is created",
    },

    // ── Delivery ─────────────────────────────────────────────────────────────
    delivery_address: { type: addressSchema, default: null },
    tracking_id:      { type: String, default: null },

    // ── Audit ────────────────────────────────────────────────────────────────
    status_history: [
      {
        status:     { type: String, enum: Object.values(PAYMENT_STATUS) },
        changed_at: { type: Date, default: Date.now },
        note:       { type: String, default: "" },
      },
    ],
  },
  {
    timestamps: true, // createdAt, updatedAt
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// ── Virtual: is the token window still open? ─────────────────────────────────
orderSchema.virtual("is_token_window_open").get(function () {
  if (!this.token_expires_at) return false;
  return new Date() < this.token_expires_at;
});

// ── Instance method: transition status with audit trail ─────────────────────
orderSchema.methods.transitionStatus = async function (newStatus, note = "") {
  const allowed = {
    [PAYMENT_STATUS.AWAITING_TOKEN]:  [PAYMENT_STATUS.TOKEN_RECEIVED, PAYMENT_STATUS.EXPIRED, PAYMENT_STATUS.REFUND_PENDING],
    [PAYMENT_STATUS.TOKEN_RECEIVED]:  [PAYMENT_STATUS.DELIVERED, PAYMENT_STATUS.RTO_CANCELLED],
    [PAYMENT_STATUS.DELIVERED]:       [],
    [PAYMENT_STATUS.RTO_CANCELLED]:   [],
    [PAYMENT_STATUS.EXPIRED]:         [],
    [PAYMENT_STATUS.PREPAID_COMPLETE]:[PAYMENT_STATUS.DELIVERED, PAYMENT_STATUS.RTO_CANCELLED],
    [PAYMENT_STATUS.REFUND_PENDING]:  [],   // terminal — ops handles manually
  };

  if (!allowed[this.payment_status]?.includes(newStatus)) {
    throw new Error(
      `Invalid transition: ${this.payment_status} → ${newStatus}`
    );
  }

  this.status_history.push({ status: newStatus, note });
  this.payment_status = newStatus;
  return this.save();
};

// ── Pre-save: keep cod_balance in sync ───────────────────────────────────────
orderSchema.pre("save", function (next) {
  this.cod_balance = this.total_amount - this.advance_paid;
  next();
});

const Order = mongoose.model("Order", orderSchema);

module.exports = { Order, PAYMENT_STATUS };
