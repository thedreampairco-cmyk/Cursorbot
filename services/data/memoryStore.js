'use strict';

/**
 * In-process memory store for the sneaker catalog.
 * Acts as a fast lookup layer between MongoDB/Sheets fetches.
 * Products are loaded from Google Sheets on startup and on every cron sync.
 */

let _catalog = [];          // Array<Product>
let _lastSyncAt = null;     // Date

function setCatalog(products) {
  _catalog = Array.isArray(products) ? products : [];
  _lastSyncAt = new Date();
}

function getCatalog() {
  return _catalog;
}

function getLastSyncAt() {
  return _lastSyncAt;
}

function getCatalogSize() {
  return _catalog.length;
}

/**
 * Filter catalog by optional criteria.
 * All filters are case-insensitive substring matches.
 */
function filterCatalog({ brand, category, size, color, maxPrice, minPrice, query } = {}) {
  return _catalog.filter((p) => {
    if (brand && !strMatch(p.brand, brand)) return false;
    if (category && !strMatch(p.category, category)) return false;
    if (color && !strMatch(p.color, color)) return false;
    if (maxPrice && parseFloat(p.price) > maxPrice) return false;
    if (minPrice && parseFloat(p.price) < minPrice) return false;
    if (size) {
      const available = String(p.sizes || p.size || '');
      if (!strMatch(available, size)) return false;
    }
    if (query) {
      const haystack = `${p.name} ${p.brand} ${p.category} ${p.color} ${p.description || ''}`.toLowerCase();
      if (!haystack.includes(query.toLowerCase())) return false;
    }
    return true;
  });
}

function strMatch(field, value) {
  if (!field) return false;
  return String(field).toLowerCase().includes(String(value).toLowerCase());
}

/**
 * Find a single product by id.
 */
function findById(id) {
  return _catalog.find((p) => String(p.id) === String(id)) || null;
}

module.exports = { setCatalog, getCatalog, getLastSyncAt, getCatalogSize, filterCatalog, findById };
