/**
 * services/inventoryService.js
 *
 * Public API for all inventory operations.
 *
 * Architecture:
 *   MongoDB  — Source of truth. All writes go here first via atomic ops.
 *   Sheets   — Human-readable mirror. Synced asynchronously after every
 *               MongoDB write. A Sheets failure NEVER blocks a sale.
 *
 *   ┌─────────────┐   atomicDeduct()    ┌─────────────────────┐
 *   │   Webhook   │ ──────────────────► │  MongoDB Inventory  │  (atomic)
 *   └─────────────┘                     └──────────┬──────────┘
 *                                                  │ async, best-effort
 *                                                  ▼
 *                                       ┌─────────────────────┐
 *                                       │   Google Sheets     │  (mirror)
 *                                       └─────────────────────┘
 */

const axios  = require("axios");
const { Inventory, OutOfStockError, SkuNotFoundError } = require("../models/Inventory");

// ─── Re-export error types so callers can instanceof-check them ───────────────
module.exports.OutOfStockError  = OutOfStockError;
module.exports.SkuNotFoundError = SkuNotFoundError;

// ─── Sheets config ────────────────────────────────────────────────────────────
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME     = process.env.GOOGLE_SHEET_TAB || "Inventory";
const COL_SKU        = "A";
const COL_STOCK      = "D";
const COL_UPDATED    = "E";

let _cachedToken    = null;
let _tokenExpiresAt = 0;

// ─── Google OAuth (Service Account JWT) ──────────────────────────────────────
async function getSheetsToken() {
  if (_cachedToken && Date.now() < _tokenExpiresAt - 60_000) return _cachedToken;

  const saKey  = JSON.parse(process.env.GOOGLE_SA_KEY);
  const now    = Math.floor(Date.now() / 1000);
  const payload = {
    iss:   saKey.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud:   "https://oauth2.googleapis.com/token",
    iat:   now,
    exp:   now + 3600,
  };

  const crypto  = require("crypto");
  const header  = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body    = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signing = `${header}.${body}`;
  const sign    = crypto.createSign("RSA-SHA256");
  sign.update(signing);
  const jwt = `${signing}.${sign.sign(saKey.private_key, "base64url")}`;

  const { data } = await axios.post("https://oauth2.googleapis.com/token", null, {
    params: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt },
  });

  _cachedToken    = data.access_token;
  _tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return _cachedToken;
}

async function findSkuRow(token, sku) {
  const { data } = await axios.get(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${SHEET_NAME}!${COL_SKU}:${COL_SKU}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const rows = data.values || [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0]?.toUpperCase() === sku.toUpperCase()) return i + 1;
  }
  return null;
}

/**
 * syncStockToSheets — mirrors the MongoDB stock value into the Google Sheet.
 * Always called with .catch() — a Sheets failure is logged, never thrown.
 *
 * @param {string} sku
 * @param {number} newStock
 */
async function syncStockToSheets(sku, newStock) {
  const token  = await getSheetsToken();
  const rowNum = await findSkuRow(token, sku);
  if (!rowNum) {
    console.warn(`[Sheets] SKU ${sku} not found in sheet — skipping sync`);
    return;
  }

  const range = `${SHEET_NAME}!${COL_STOCK}${rowNum}:${COL_UPDATED}${rowNum}`;
  await axios.put(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}`,
    { range, majorDimension: "ROWS", values: [[newStock, new Date().toISOString()]] },
    { headers: { Authorization: `Bearer ${token}` }, params: { valueInputOption: "RAW" } }
  );
  console.log(`[Sheets] ✅ Synced ${sku} stock = ${newStock}`);
}


// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * deductStock — the main entry point for post-payment inventory deduction.
 *
 * 1. Atomically deducts qty from MongoDB (race-condition safe).
 * 2. Fires an async Sheets sync — does NOT await it, never blocks the caller.
 *
 * @param {string} sku
 * @param {number} qty      Defaults to 1
 * @param {string} orderId  For the audit log
 *
 * @returns {Promise<{ newStock: number }>}
 * @throws  {OutOfStockError}   Stock insufficient — caller should flag refund
 * @throws  {SkuNotFoundError}  SKU missing from DB — needs ops attention
 */
async function deductStock(sku, qty = 1, orderId = "") {
  // ── Step 1: Atomic MongoDB write ─────────────────────────────────────────
  const { newStock } = await Inventory.atomicDeduct(sku, qty, orderId);
  console.log(`[Inventory] ✅ Atomic deduct: ${sku} qty=${qty} → stock=${newStock}`);

  // ── Step 2: Mirror to Sheets (async, fire-and-forget) ────────────────────
  syncStockToSheets(sku, newStock).catch((err) =>
    console.error(`[Sheets] ❌ Sync failed for ${sku}:`, err.message)
  );

  return { newStock };
}

/**
 * getStock — reads current stock from MongoDB (the source of truth).
 *
 * @param {string} sku
 * @returns {Promise<number>}
 */
async function getStock(sku) {
  return Inventory.getStock(sku);
}

/**
 * reserveStock — locks units at order-creation time so two users
 * mid-checkout don't both see the same available count.
 *
 * @param {string} sku
 * @param {string} orderId
 */
async function reserveStock(sku, orderId) {
  const result = await Inventory.reserveStock(sku, 1);
  if (!result) throw new OutOfStockError(sku, 1, 0);
  console.log(`[Inventory] Reserved 1x ${sku} for order ${orderId}`);
  return result;
}

/**
 * releaseReservation — un-locks units when an order expires or is cancelled
 * before payment. The size goes back to available for other buyers.
 *
 * @param {string} sku
 * @param {string} orderId
 */
async function releaseReservation(sku, orderId) {
  await Inventory.releaseReservation(sku, 1);
  console.log(`[Inventory] Released reservation for ${sku} (order ${orderId})`);
}

module.exports = {
  deductStock,
  getStock,
  reserveStock,
  releaseReservation,
  OutOfStockError,
  SkuNotFoundError,
};
