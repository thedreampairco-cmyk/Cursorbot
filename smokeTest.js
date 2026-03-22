'use strict';

/**
 * Smoke test – validates module imports and key utility logic.
 * Run with: node tests/smokeTest.js
 * Does NOT require environment variables or live connections.
 */

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

console.log('\n🧪 Maya Smoke Tests\n');

// ── urlHelper ─────────────────────────────────────────────────────────────────
console.log('urlHelper.js');
const { isValidUrl, extractImageUrl, buildUrl } = require('./urlHelper');

test('isValidUrl accepts https', () => assert(isValidUrl('https://example.com/img.jpg')));
test('isValidUrl rejects filename', () => assert(!isValidUrl('nike.jpg')));
test('isValidUrl rejects empty', () => assert(!isValidUrl('')));
test('extractImageUrl finds imageUrl key', () => {
  const product = { imageUrl: 'https://cdn.example.com/shoe.jpg' };
  assert(extractImageUrl(product) === 'https://cdn.example.com/shoe.jpg');
});
test('extractImageUrl returns null for no URL', () => assert(extractImageUrl({}) === null));
test('buildUrl appends params', () => {
  const url = buildUrl('https://example.com', { page: 1, q: 'nike' });
  assert(url.includes('page=1') && url.includes('q=nike'));
});

// ── memoryStore ───────────────────────────────────────────────────────────────
console.log('\nmemoryStore.js');
const store = require('./services/data/memoryStore');

test('setCatalog stores products', () => {
  store.setCatalog([{ id: '1', name: 'Air Max', brand: 'Nike', category: 'Running', color: 'White', price: 7999, sizes: '7,8,9', stock: 5, inStock: true, imageUrl: 'https://cdn.example.com/airmax.jpg' }]);
  assert(store.getCatalogSize() === 1);
});
test('filterCatalog by brand', () => {
  const res = store.filterCatalog({ brand: 'Nike' });
  assert(res.length === 1);
});
test('filterCatalog by color miss', () => {
  const res = store.filterCatalog({ color: 'Black' });
  assert(res.length === 0);
});
test('findById returns product', () => {
  const p = store.findById('1');
  assert(p && p.name === 'Air Max');
});
test('findById returns null for unknown', () => {
  assert(store.findById('999') === null);
});

// ── buildSystemPrompt ─────────────────────────────────────────────────────────
console.log('\nbuildSystemPrompt.js');
const { buildSystemPrompt } = require('./services/ai/buildSystemPrompt');

test('buildSystemPrompt returns string', () => {
  const prompt = buildSystemPrompt({ name: 'Test', preferences: {}, leadScore: 0, messages: [] });
  assert(typeof prompt === 'string' && prompt.length > 100);
});
test('buildSystemPrompt includes Maya persona', () => {
  const prompt = buildSystemPrompt({});
  assert(prompt.includes('Maya'));
});
test('buildSystemPrompt includes catalog', () => {
  const prompt = buildSystemPrompt({});
  assert(prompt.includes('Air Max'));
});

// ── inventoryService ──────────────────────────────────────────────────────────
console.log('\ninventoryService.js');
const inv = require('./services/features/inventoryService');

test('checkAvailability ok when in stock', () => {
  const { ok } = inv.checkAvailability([{ productId: '1', quantity: 1 }]);
  assert(ok);
});
test('checkAvailability fails when out of stock', () => {
  store.setCatalog([{ id: '2', name: 'Boost', brand: 'Adidas', stock: 0, inStock: false }]);
  const { ok, outOfStock } = inv.checkAvailability([{ productId: '2', quantity: 1 }]);
  assert(!ok && outOfStock.includes('2'));
});
test('reduceStock decrements count', () => {
  store.setCatalog([{ id: '3', name: 'Pegasus', brand: 'Nike', stock: 5, inStock: true }]);
  inv.reduceStock([{ productId: '3', quantity: 2 }]);
  const p = store.findById('3');
  assert(p.stock === 3);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
