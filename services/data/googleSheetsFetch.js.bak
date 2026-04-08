'use strict';

const { parse } = require('csv-parse/sync');
const { sheetsClient } = require('../../config/api');
const env = require('../../config/env');
const { logger } = require('../../errorHandler');
const memoryStore = require('../features/memoryStore');

/**
 * Required column names in the Google Sheet (case-insensitive matching applied).
 * The sheet MUST have at least: id, name, brand, category, price, sizes/size,
 * color, stock, and one of imageUrl / image_url / image / img.
 */
const COLUMN_MAP = {
  id:          ['id', 'product_id', 'sku'],
  name:        ['name', 'product_name', 'title'],
  brand:       ['brand'],
  category:    ['category', 'catagory', 'type'],
  price:       ['price', 'mrp', 'selling_price'],
  sizes:       ['sizes', 'size', 'available_sizes'],
  color:       ['color', 'colour'],
  stock:       ['stock', 'inventory', 'qty', 'quantity'],
  description: ['description', 'desc'],
  imageUrl:    ['imageurl', 'image_url', 'image', 'img', 'photo', 'picture'],
};

function resolveColumn(headers, aliases) {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const alias of aliases) {
    const idx = lower.indexOf(alias.toLowerCase());
    if (idx !== -1) return headers[idx]; // original casing
  }
  return null;
}

function buildColumnIndex(headers) {
  const index = {};
  for (const [field, aliases] of Object.entries(COLUMN_MAP)) {
    index[field] = resolveColumn(headers, aliases);
  }
  return index;
}

function parseRow(row, colIndex) {
  // colIndex is { field: "OriginalColumnName" } built by buildColumnIndex
  const get = (field) => {
    const col = colIndex[field];
    return col ? (row[col] || null) : null;
  };

  const rawImage = get('imageUrl') || '';
  // Convert Google Drive viewer URLs to direct download URLs
  const imageUrl = rawImage.replace(
    /https://drive.google.com/file/d/([^/]+)/view[^"]*/,
    'https://drive.google.com/uc?export=download&id=$1'
  );

  return {
    sku:         get('id'),
    id:          get('id'),
    name:        get('name'),
    brand:       get('brand')   || '',
    category:    get('category') || '',
    color:       get('color')   || '',
    price:       parseFloat(String(get('price')).replace(/[^0-9.]/g, '')) || 0,
    stock:       parseInt(get('stock'))  || 0,
    sizes:       String(get('sizes') || '').split(',').map(s => s.trim()).filter(Boolean),
    description: get('description') || '',
    imageUrl,
  };
}

async function fetchAndSyncCatalog() {
  logger.info('[Sheets] Starting catalog sync…');
  try {
    const response = await sheetsClient.get(env.sheets.csvUrl);
    const csv = response.data;

    const records = parse(csv, { columns: true, skip_empty_lines: true, trim: true });
    if (!records.length) {
      logger.warn('[Sheets] Sheet returned 0 rows – catalog not updated');
      return [];
    }

    const headers = Object.keys(records[0]);
    const colIndex = buildColumnIndex(headers);

    const products = records
      .map((row) => parseRow(row, colIndex))
      .filter((p) => p.sku && p.name); // require at minimum sku + name

    memoryStore.setCatalog(products);
    logger.info(`[Sheets] Catalog synced – ${products.length} products loaded`);
    return products;
  } catch (err) {
    logger.error('[Sheets] Failed to fetch catalog', { error: err.message });
    throw err;
  }
}

module.exports = { fetchAndSyncCatalog };
