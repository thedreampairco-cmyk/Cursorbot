// services/googleSheets.js
"use strict";

const axios  = require("axios");
const crypto = require("crypto");
const { parse } = require("csv-parse/sync");
const { logger, AppError } = require("../errorHandler");

const CSV_URL             = process.env.GOOGLE_SHEETS_CSV_URL;
const SHEET_ID            = process.env.GOOGLE_SHEET_ID;
const LOW_STOCK_THRESHOLD = parseInt(process.env.LOW_STOCK_THRESHOLD || "5", 10);

// ─── Service Account Parsing ─────────────────────────────────────────────────

let _serviceAccount = null;

function _getServiceAccount() {
  if (_serviceAccount) return _serviceAccount;
  const raw = process.env.GOOGLE_SA_KEY;
  if (!raw) throw new AppError("GOOGLE_SA_KEY is not set.", 500, "MISSING_ENV");
  try {
    _serviceAccount = JSON.parse(raw);
    return _serviceAccount;
  } catch {
    throw new AppError("GOOGLE_SA_KEY is not valid JSON.", 500, "INVALID_SA_KEY");
  }
}

// ─── JWT / OAuth2 ───────────────────────────────────────────────────────────

let _accessToken  = null;
let _tokenExpiry  = 0;

function _base64url(str) {
  return Buffer.from(str)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function _buildJwt(sa) {
  const iat = Math.floor(Date.now() / 1000);
  const header  = _base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = _base64url(
    JSON.stringify({
      iss:   sa.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud:   "https://oauth2.googleapis.com/token",
      iat,
      exp:   iat + 3600,
    })
  );
  const unsigned  = `${header}.${payload}`;
  const signer    = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  const sig = signer
    .sign(sa.private_key)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${unsigned}.${sig}`;
}

async function _getAccessToken() {
  if (_accessToken && Date.now() < _tokenExpiry) return _accessToken;

  const sa  = _getServiceAccount();
  const jwt = _buildJwt(sa);

  const { data } = await axios.post(
    "https://oauth2.googleapis.com/token",
    new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion:  jwt,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10000 }
  );

  _accessToken = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  logger.info("[GoogleSheets] OAuth2 access token refreshed.");
  return _accessToken;
}

// ─── URL Builder ────────────────────────────────────────────────────────────

function _sheetsUrl(path) {
  if (!SHEET_ID) throw new AppError("GOOGLE_SHEET_ID is not set.", 500, "MISSING_ENV");
  return `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}${path}`;
}

// ─── Auth Header Helper ─────────────────────────────────────────────────────

async function _authHeader() {
  const token = await _getAccessToken();
  return { Authorization: `Bearer ${token}` };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATALOG READ (via public CSV export)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch the full sneaker catalog from a publicly shared Google Sheets CSV URL.
 * Expected columns: sku, brand, name, price, sizes, stock, imageUrl, description, category, active
 * @returns {Promise<object[]>}
 */
async function fetchCatalogFromSheet() {
  if (!CSV_URL) throw new AppError("GOOGLE_SHEETS_CSV_URL is not set.", 500, "MISSING_ENV");

  try {
    const { data } = await axios.get(CSV_URL, { responseType: "text", timeout: 15000 });

    const records = parse(data, { columns: true, skip_empty_lines: true, trim: true });

    return records.map((row) => ({
      sku:         row.sku         || row.SKU         || "",
      brand:       row.brand       || row.Brand       || "",
      name:        row.name        || row.Name        || "",
      price:       parseFloat(row.price  || row.Price  || 0),
      sizes:       (row.sizes || row.Sizes || "")
                     .split(",")
                     .map((s) => s.trim())
                     .filter(Boolean),
      stock:       parseInt(row.stock  || row.Stock  || 0, 10),
      imageUrl:    row.imageUrl    || row.image_url   || row.ImageUrl   || "",
      description: row.description || row.Description || "",
      category:    row.category    || row.Category    || "Uncategorized",
      active:      (row.active || row.Active || "true").toLowerCase() !== "false",
    }));
  } catch (err) {
    logger.error(`[GoogleSheets] fetchCatalogFromSheet failed: ${err.message}`);
    throw new AppError("Failed to fetch catalog from Google Sheets.", 502, "SHEETS_CATALOG_FAILED");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// INVENTORY (via Sheets API v4)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sync inventory data from the Inventory sheet tab.
 * @param {string} [sheetName="Inventory"]
 * @returns {Promise<Array<{ sku: string, stock: number, rowIndex: number }>>}
 */
async function syncInventory(sheetName = "Inventory") {
  try {
    const headers = await _authHeader();
    const range   = encodeURIComponent(`${sheetName}!A:D`);
    const { data } = await axios.get(
      _sheetsUrl(`/values/${range}`),
      { headers, timeout: 10000 }
    );

    const rows   = data.values || [];
    if (rows.length < 2) return [];

    const header   = rows[0].map((h) => h.toLowerCase().trim());
    const skuIdx   = header.findIndex((h) => h === "sku");
    const stockIdx = header.findIndex((h) => h === "stock");

    if (skuIdx === -1 || stockIdx === -1) {
      throw new AppError(
        `Inventory sheet "${sheetName}" is missing a "sku" or "stock" column.`,
        500,
        "SHEET_SCHEMA_ERROR"
      );
    }

    return rows.slice(1).map((row, i) => ({
      sku:      (row[skuIdx]   || "").trim(),
      stock:    parseInt(row[stockIdx] || "0", 10),
      rowIndex: i + 2, // 1-based, offset by header row
    }));
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error(`[GoogleSheets] syncInventory failed: ${err.message}`);
    throw new AppError("Failed to sync inventory from Google Sheets.", 502, "SHEETS_SYNC_FAILED");
  }
}

/**
 * Decrement stock for a SKU. Logs a low-stock warning if threshold is breached.
 * @param {string} sku
 * @param {number} qty
 * @param {string} [sheetName="Inventory"]
 * @returns {Promise<{ sku: string, newStock: number, lowStock: boolean }>}
 */
async function deductStock(sku, qty, sheetName = "Inventory") {
  try {
    const inventory = await syncInventory(sheetName);
    const item      = inventory.find((i) => i.sku === sku);

    if (!item) {
      throw new AppError(`SKU "${sku}" not found in inventory.`, 404, "SKU_NOT_FOUND");
    }
    if (item.stock < qty) {
      throw new AppError(
        `Insufficient stock for SKU "${sku}". Available: ${item.stock}, requested: ${qty}.`,
        409,
        "INSUFFICIENT_STOCK"
      );
    }

    const newStock     = item.stock - qty;
    const headers      = await _authHeader();
    const cellRange    = `${sheetName}!${_stockColumnLetter(sheetName)}${item.rowIndex}`;
    const encodedRange = encodeURIComponent(cellRange);

    await axios.put(
      _sheetsUrl(`/values/${encodedRange}`),
      { range: cellRange, majorDimension: "ROWS", values: [[String(newStock)]] },
      { headers, params: { valueInputOption: "RAW" }, timeout: 10000 }
    );

    const lowStock = newStock <= LOW_STOCK_THRESHOLD;
    if (lowStock) {
      logger.warn(`[GoogleSheets] LOW STOCK: "${sku}" has ${newStock} units remaining.`);
    }

    logger.info(`[GoogleSheets] Stock deducted: ${sku} ${item.stock} → ${newStock}`);
    return { sku, newStock, lowStock };
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error(`[GoogleSheets] deductStock failed for ${sku}: ${err.message}`);
    throw new AppError(`Failed to deduct stock for SKU "${sku}".`, 502, "SHEETS_STOCK_DEDUCT_FAILED");
  }
}

/**
 * Determine the column letter for "stock" in the given sheet.
 * Currently assumes column C (index 2). Extend with dynamic lookup if schema varies.
 * @param {string} _sheetName
 * @returns {string}
 */
function _stockColumnLetter(_sheetName) {
  return "C";
}

/**
 * Check whether a SKU has sufficient stock.
 * @param {string} sku
 * @param {number} [qty=1]
 * @param {string} [sheetName="Inventory"]
 * @returns {Promise<boolean>}
 */
async function isInStock(sku, qty = 1, sheetName = "Inventory") {
  try {
    const inventory = await syncInventory(sheetName);
    const item      = inventory.find((i) => i.sku === sku);
    return !!item && item.stock >= qty;
  } catch (err) {
    logger.error(`[GoogleSheets] isInStock check failed for ${sku}: ${err.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Append a confirmed order row to the Orders sheet.
 * Columns: orderId | phone | items | total | address | paymentMethod | paymentStatus | createdAt
 * @param {object} order
 * @param {string} [sheetName="Orders"]
 */
async function appendOrderToSheet(order, sheetName = "Orders") {
  try {
    const headers = await _authHeader();
    const {
      orderId, phone, items, total,
      address, paymentMethod, paymentStatus, createdAt,
    } = order;

    const itemsSummary = (items || [])
      .map((i) => `${i.sku}×${i.qty}(sz${i.size})`)
      .join("; ");

    const row = [
      orderId,
      phone,
      itemsSummary,
      total,
      address,
      paymentMethod  || "unknown",
      paymentStatus  || "pending",
      createdAt      || new Date().toISOString(),
    ];

    const range = encodeURIComponent(`${sheetName}!A:H`);
    await axios.post(
      _sheetsUrl(`/values/${range}:append`),
      { values: [row] },
      {
        headers,
        params: { valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS" },
        timeout: 10000,
      }
    );

    logger.info(`[GoogleSheets] Order ${orderId} appended to "${sheetName}".`);
  } catch (err) {
    logger.error(`[GoogleSheets] appendOrderToSheet failed: ${err.message}`);
    throw new AppError("Failed to append order to Google Sheets.", 502, "SHEETS_APPEND_FAILED");
  }
}

/**
 * Update the payment status column for an existing order row.
 * @param {string} orderId
 * @param {string} status  - e.g. "paid", "refunded", "failed"
 * @param {string} [sheetName="Orders"]
 */
async function updateOrderPaymentStatus(orderId, status, sheetName = "Orders") {
  try {
    const headers = await _authHeader();

    // Fetch all rows to locate the target orderId
    const range = encodeURIComponent(`${sheetName}!A:G`);
    const { data } = await axios.get(
      _sheetsUrl(`/values/${range}`),
      { headers, timeout: 10000 }
    );

    const rows   = data.values || [];
    const rowIdx = rows.findIndex((r) => r[0] === orderId);

    if (rowIdx === -1) {
      logger.warn(`[GoogleSheets] updateOrderPaymentStatus: order ${orderId} not found.`);
      return;
    }

    // Column G (index 6) = paymentStatus; row is 1-based
    const cellRef      = `${sheetName}!G${rowIdx + 1}`;
    const encodedRange = encodeURIComponent(cellRef);

    await axios.put(
      _sheetsUrl(`/values/${encodedRange}`),
      { range: cellRef, majorDimension: "ROWS", values: [[status]] },
      { headers, params: { valueInputOption: "RAW" }, timeout: 10000 }
    );

    logger.info(`[GoogleSheets] Order ${orderId} payment status → "${status}".`);
  } catch (err) {
    logger.error(`[GoogleSheets] updateOrderPaymentStatus failed: ${err.message}`);
    throw new AppError("Failed to update order status in Google Sheets.", 502, "SHEETS_UPDATE_FAILED");
  }
}

module.exports = {
  fetchCatalogFromSheet,
  syncInventory,
  deductStock,
  isInStock,
  appendOrderToSheet,
  updateOrderPaymentStatus,
};
