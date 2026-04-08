'use strict';

const { parse } = require('csv-parse/sync');
const { sheetsClient } = require('../../config/api');
const env = require('../../config/env');
const { logger } = require('../../errorHandler');


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
  gender:      ['gender', 'gender preference', 'gender_preference'],
};

function resolveColumn(headers, aliases) {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const alias of aliases) {
    const idx = lower.indexOf(alias.toLowerCase());
    if (idx !== -1) return headers[idx];
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

function fixImageUrl(raw) {
  if (!raw) return '';
  const m = raw.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  return m ? 'https://drive.google.com/uc?export=download&id=' + m[1] : raw;
}


function expandSizes(raw) {
  if (!raw) return [];
  const str = String(raw).trim();
  // Range format: "5-13" or "6-12"
  const rangeMatch = str.match(/^([0-9.]+)-([0-9.]+)$/);
  if (rangeMatch) {
    const start = parseFloat(rangeMatch[1]);
    const end   = parseFloat(rangeMatch[2]);
    const sizes = [];
    for (let s = start; s <= end; s += 0.5) {
      sizes.push(Number.isInteger(s) ? String(s) : s.toFixed(1));
    }
    return sizes;
  }
  // Comma format: "6,7,8,9"
  return str.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseRow(row, colIndex) {
  const get = (field) => {
    const col = colIndex[field];
    return col ? (row[col] || null) : null;
  };
  // Extract brand from first word of name e.g. 'Vans Classic Slip-On' -> 'Vans'
  const fullName = get('name') || '';
  const brand = get('brand') || fullName.split(' ')[0] || '';

  return {
    sku:         get('id'),
    id:          get('id'),
    name:        fullName,
    brand:       brand,
    category:    get('category') || '',
    color:       get('color')    || '',
    price:       parseFloat(String(get('price')).replace(/[^0-9.]/g, '')) || 0,
    stock:       parseInt(get('stock')) || 0,
    sizes:       expandSizes(get('sizes')),
    description: get('description') || '',
    gender:      get('gender') || 'Unisex',
    imageUrl:    fixImageUrl(get('imageUrl')),
  };
}

async function fetchAndSyncCatalog() {
  logger.info('[Sheets] Starting catalog sync...');
  try {
    const response = await sheetsClient.get(env.sheets.csvUrl);
    const csv = response.data;
    const records = parse(csv, { columns: true, skip_empty_lines: true, trim: true });
    if (!records.length) {
      logger.warn('[Sheets] Sheet returned 0 rows - catalog not updated');
      return [];
    }
    const headers  = Object.keys(records[0]);
    const colIndex = buildColumnIndex(headers);
    const products = records
      .map((row) => parseRow(row, colIndex))
      .filter((p) => p.sku && p.name);
    
    logger.info('[Sheets] Catalog synced - ' + products.length + ' products loaded');
    return products;
  } catch (err) {
    logger.error('[Sheets] Failed to fetch catalog', { error: err.message });
    throw err;
  }
}

module.exports = { fetchAndSyncCatalog };