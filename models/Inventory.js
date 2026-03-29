/**
 * models/Inventory.js
 *
 * MongoDB is the atomic source of truth for stock levels.
 * Google Sheets is a human-readable mirror — synced after every deduction.
 *
 * Why MongoDB and not Sheets for the atomic op?
 * Google Sheets has no concept of conditional writes. Two concurrent
 * requests both read stock=1, both write stock=0, and you've just
 * sold a pair you don't have. MongoDB's findOneAndUpdate with a
 * filter condition is atomic at the document level — only ONE of
 * two concurrent requests can satisfy { stock: { $gte: qty } }.
 * The loser gets null back. That's the entire race condition fix.
 */

const mongoose = require("mongoose");

// ─── Custom error types for clean error handling upstream ─────────────────────
class OutOfStockError extends Error {
  constructor(sku, requested, available) {
    super(`OUT_OF_STOCK: ${sku} — requested ${requested}, available ${available}`);
    this.code      = "OUT_OF_STOCK";
    this.sku       = sku;
    this.requested = requested;
    this.available = available;
  }
}

class SkuNotFoundError extends Error {
  constructor(sku) {
    super(`SKU_NOT_FOUND: ${sku}`);
    this.code = "SKU_NOT_FOUND";
    this.sku  = sku;
  }
}

// ─── Schema ───────────────────────────────────────────────────────────────────
const inventorySchema = new mongoose.Schema(
  {
    sku: {
      type:     String,
      required: true,
      unique:   true,
      index:    true,
      uppercase: true,
      trim:     true,
    },
    name:  { type: String, required: true },  // "New Balance 550 Pandas"
    size:  { type: String, required: true },  // "42"
    color: { type: String, default: "" },

    stock: {
      type:    Number,
      required: true,
      default: 0,
      min:     0,   // schema-level guard; atomic op is the real enforcement
    },

    // How many units are currently locked (token paid, not yet delivered)
    reserved: {
      type:    Number,
      default: 0,
      min:     0,
    },

    // Denormalized convenience field: stock - reserved
    available: {
      type: Number,
      default: function () { return this.stock - this.reserved; },
    },

    // Audit log of every deduction: who, when, how many, which order
    deduction_log: [
      {
        order_id:   { type: String, required: true },
        qty:        { type: Number, required: true },
        deducted_at:{ type: Date,   default: Date.now },
        note:       { type: String, default: "" },
      },
    ],
  },
  {
    timestamps: true,  // createdAt, updatedAt
    toJSON:  { virtuals: true },
    toObject:{ virtuals: true },
  }
);

// ── Virtual: is the item available to sell? ───────────────────────────────────
inventorySchema.virtual("is_in_stock").get(function () {
  return this.stock > 0;
});

// ── Pre-save: keep available in sync ──────────────────────────────────────────
inventorySchema.pre("save", function (next) {
  this.available = Math.max(0, this.stock - this.reserved);
  next();
});

// ─── Static Methods ───────────────────────────────────────────────────────────

/**
 * atomicDeduct — the race-condition-safe inventory deduction.
 *
 * Uses a single findOneAndUpdate with the stock condition baked into
 * the query filter. MongoDB evaluates filter + update atomically —
 * if two requests race on the last unit, only ONE will match the
 * { stock: { $gte: qty } } condition. The other gets null.
 *
 * @param {string} sku      - Product SKU
 * @param {number} qty      - Units to deduct (usually 1)
 * @param {string} orderId  - For the audit log
 * @returns {Promise<{ newStock: number, item: InventoryDoc }>}
 * @throws  {OutOfStockError}  — stock insufficient (includes race condition loser)
 * @throws  {SkuNotFoundError} — SKU doesn't exist in DB
 */
inventorySchema.statics.atomicDeduct = async function (sku, qty = 1, orderId = "") {
  const upperSku = sku.toUpperCase();

  // ── The atomic operation ────────────────────────────────────────────────────
  // Filter:  { sku, stock >= qty }
  // Update:  decrement stock, push to audit log, update available
  // Returns: the updated document (new: true), or null if filter didn't match
  const updated = await this.findOneAndUpdate(
    {
      sku:   upperSku,
      stock: { $gte: qty },   // ← This is the race condition guard
    },
    {
      $inc: { stock: -qty, available: -qty },
      $push: {
        deduction_log: {
          order_id:    orderId,
          qty,
          deducted_at: new Date(),
          note:        `Deducted ${qty} via payment webhook`,
        },
      },
      $set: { updatedAt: new Date() },
    },
    {
      new:        true,   // return the document AFTER the update
      runValidators: true,
    }
  );

  // ── null means the filter didn't match — figure out why ────────────────────
  if (!updated) {
    const existing = await this.findOne({ sku: upperSku }).select("sku stock").lean();

    if (!existing) {
      throw new SkuNotFoundError(upperSku);
    }

    // SKU exists but stock was insufficient (race condition loser lands here too)
    throw new OutOfStockError(upperSku, qty, existing.stock);
  }

  return { newStock: updated.stock, item: updated };
};

/**
 * getStock — non-blocking read of current stock level.
 * Uses .lean() for raw JS object (faster, no Mongoose overhead).
 *
 * @param {string} sku
 * @returns {Promise<number>}  Returns 0 if SKU not found.
 */
inventorySchema.statics.getStock = async function (sku) {
  const item = await this.findOne({ sku: sku.toUpperCase() })
    .select("stock")
    .lean();
  return item?.stock ?? 0;
};

/**
 * reserveStock — increments the reserved counter without deducting stock.
 * Call this when an order is created (AWAITING_TOKEN state) so two users
 * can't both see the same available count while one is mid-checkout.
 *
 * @param {string} sku
 * @param {number} qty
 */
inventorySchema.statics.reserveStock = async function (sku, qty = 1) {
  return this.findOneAndUpdate(
    { sku: sku.toUpperCase(), stock: { $gte: qty } },
    { $inc: { reserved: qty, available: -qty } },
    { new: true }
  );
};

/**
 * releaseReservation — decrements the reserved counter.
 * Call this when an order expires (EXPIRED state) or is cancelled
 * before payment, so the slot goes back to available.
 *
 * @param {string} sku
 * @param {number} qty
 */
inventorySchema.statics.releaseReservation = async function (sku, qty = 1) {
  return this.findOneAndUpdate(
    { sku: sku.toUpperCase() },
    { $inc: { reserved: -qty, available: qty } },
    { new: true }
  );
};

const Inventory = mongoose.model("Inventory", inventorySchema);

module.exports = { Inventory, OutOfStockError, SkuNotFoundError };
