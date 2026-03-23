#!/usr/bin/env node
'use strict';

/**
 * Vision Recognition Test
 * Run: node tests/testVision.js
 * Run with custom image: node tests/testVision.js https://example.com/shoe.jpg
 * Run with local file:   node tests/testVision.js ./shoe.jpg
 */

require('dotenv').config();

const axios = require('axios');
const fs    = require('fs');

const VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GREEN_BASE   = process.env.GREEN_API_BASE_URL || 'https://api.greenapi.com';
const INSTANCE_ID  = process.env.GREEN_API_INSTANCE_ID;
const TOKEN        = process.env.GREEN_API_TOKEN;

// Default test image — a plain JPEG sneaker
const TEST_IMAGE_INPUT = process.argv[2]
  || 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=800&q=80';

let passed = 0;
let failed = 0;

function ok(name, detail = '')   { console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`); passed++; }
function fail(name, reason = '') { console.log(`  ❌ ${name}${reason ? '\n     ↳ ' + reason : ''}`); failed++; }
function info(msg)               { console.log(`  ℹ️  ${msg}`); }
function section(title)          { console.log(`\n${'─'.repeat(50)}\n  ${title}\n${'─'.repeat(50)}`); }

// ── Detect mime type from buffer ──────────────────────────────────────────────
function detectMimeType(buffer) {
  const hex = buffer.slice(0, 4).toString('hex');
  if (hex.startsWith('ffd8ff'))         return 'image/jpeg';
  if (hex.startsWith('89504e47'))       return 'image/png';
  if (hex.startsWith('47494638'))       return 'image/gif';
  if (hex.startsWith('52494646'))       return 'image/webp';
  return 'image/jpeg'; // fallback
}

// ── Load image as base64 data URL ─────────────────────────────────────────────
async function loadImageAsBase64(input) {
  let buffer;

  if (fs.existsSync(input)) {
    buffer = fs.readFileSync(input);
  } else {
    const res = await axios({
      url: input,
      method: 'GET',
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    buffer = Buffer.from(res.data);
  }

  const mime    = detectMimeType(buffer);
  const base64  = buffer.toString('base64');
  const dataUrl = `data:${mime};base64,${base64}`;

  return { dataUrl, mime, sizeKB: Math.round(buffer.length / 1024) };
}

// ── TEST 1: Env Variables ─────────────────────────────────────────────────────
async function testEnv() {
  section('TEST 1 — Environment Variables');
  if (GROQ_API_KEY) ok('GROQ_API_KEY',          GROQ_API_KEY.slice(0, 10) + '...');
  else              fail('GROQ_API_KEY',         'NOT SET');
  if (INSTANCE_ID)  ok('GREEN_API_INSTANCE_ID',  INSTANCE_ID);
  else              fail('GREEN_API_INSTANCE_ID','NOT SET');
  if (TOKEN)        ok('GREEN_API_TOKEN',         TOKEN.slice(0, 8) + '...');
  else              fail('GREEN_API_TOKEN',       'NOT SET');
  if (process.env.GOOGLE_SHEETS_CSV_URL) ok('GOOGLE_SHEETS_CSV_URL', 'set');
  else fail('GOOGLE_SHEETS_CSV_URL', 'NOT SET');
}

// ── TEST 2: Image Load ────────────────────────────────────────────────────────
async function testImageLoad() {
  section('TEST 2 — Image Loading');
  info(`Source: ${TEST_IMAGE_INPUT}`);
  try {
    const { dataUrl, mime, sizeKB } = await loadImageAsBase64(TEST_IMAGE_INPUT);
    ok('Image loaded', `${mime} ~${sizeKB} KB`);
    info(`Data URL prefix: ${dataUrl.slice(0, 50)}...`);
    return dataUrl;
  } catch (err) {
    fail('Image load failed', err.message);
    return null;
  }
}

// ── TEST 3: Groq Vision API ───────────────────────────────────────────────────
async function testGroqVision(dataUrl) {
  section('TEST 3 — Groq Vision API (llama-4-scout)');

  if (!GROQ_API_KEY) { fail('Skipped', 'No GROQ_API_KEY'); return null; }
  if (!dataUrl)      { fail('Skipped', 'No image data from Test 2'); return null; }

  info(`Model: ${VISION_MODEL}`);

  try {
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: VISION_MODEL,
        max_tokens: 200,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Analyze this shoe/sneaker image. Reply ONLY with valid JSON, no markdown.
Format: {"detected_text": "brand and model", "brand": "brand name", "color": "main color", "labels": ["tag1","tag2"]}
Example: {"detected_text": "Nike Air Max 90", "brand": "Nike", "color": "White", "labels": ["running","casual"]}`,
              },
              {
                type: 'image_url',
                image_url: { url: dataUrl },
              },
            ],
          },
        ],
      },
      {
        timeout: 25000,
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const raw    = res.data.choices[0].message.content;
    info(`Raw Groq response: ${raw}`);

    const result = JSON.parse(raw);
    ok('Groq vision success', `"${result.detected_text}"`);
    info(`Brand:  ${result.brand  || '(none)'}`);
    info(`Color:  ${result.color  || '(none)'}`);
    info(`Labels: ${(result.labels || []).join(', ')}`);
    return result;

  } catch (err) {
    const msg = err?.response?.data?.error?.message || err.message;
    fail('Groq vision failed', msg);
    if (err?.response?.data) info(`Full error: ${JSON.stringify(err.response.data)}`);
    return null;
  }
}

// ── TEST 4: Catalog Load + Match ──────────────────────────────────────────────
async function testCatalogMatch(visionResult) {
  section('TEST 4 — Google Sheets Catalog + Matching');

  const csvUrl = process.env.GOOGLE_SHEETS_CSV_URL;
  if (!csvUrl) { fail('Skipped', 'GOOGLE_SHEETS_CSV_URL not set'); return; }

  // Load catalog
  let catalog = [];
  try {
    const { parse } = require('csv-parse/sync');
    const res       = await axios.get(csvUrl, { timeout: 12000 });
    const records   = parse(res.data, { columns: true, skip_empty_lines: true, trim: true });

    if (!records.length) { fail('Catalog empty', 'Sheet returned 0 rows'); return; }

    // Show raw headers so we can see exact column names
    const headers = Object.keys(records[0]);
    info(`Sheet headers: ${headers.join(', ')}`);
    info(`First row sample: ${JSON.stringify(records[0]).slice(0, 200)}`);

    // Flexible column mapping
    const get = (row, ...keys) => {
      for (const k of keys) {
        const match = Object.keys(row).find((h) => h.toLowerCase().trim() === k.toLowerCase());
        if (match && row[match]) return row[match];
      }
      return '';
    };

    catalog = records.map((r) => ({
      id:       get(r, 'id', 'product_id', 'sku', 'ID', 'SKU'),
      name:     get(r, 'name', 'product_name', 'title', 'Name', 'Title'),
      brand:    get(r, 'brand', 'Brand'),
      color:    get(r, 'color', 'colour', 'Color', 'Colour'),
      category: get(r, 'category', 'type', 'Category'),
      price:    get(r, 'price', 'mrp', 'selling_price', 'Price'),
      sizes:    get(r, 'sizes', 'size', 'available_sizes', 'Sizes'),
      stock:    parseInt(get(r, 'stock', 'inventory', 'qty', 'Stock') || '0', 10),
    })).filter((p) => p.name);

    ok(`Catalog loaded`, `${catalog.length} products`);
    info(`Brands: ${[...new Set(catalog.map((p) => p.brand).filter(Boolean))].join(', ')}`);

  } catch (err) {
    fail('Catalog load failed', err.message);
    return;
  }

  // Match
  const query = visionResult
    ? { brand: visionResult.brand, model: visionResult.detected_text, color: visionResult.color }
    : { brand: 'Nike', model: 'Nike', color: '' };

  info(`Matching against: brand="${query.brand}" model="${query.model}" color="${query.color}"`);

  const scored = catalog
    .filter((p) => p.stock > 0)
    .map((p) => {
      let score = 0;
      if (query.brand && p.brand?.toLowerCase().includes(query.brand.toLowerCase())) score += 4;
      if (query.model && p.name?.toLowerCase().includes(query.model.toLowerCase().split(' ')[0])) score += 3;
      if (query.color && p.color?.toLowerCase().includes(query.color.toLowerCase())) score += 2;
      return { ...p, score };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  if (scored.length) {
    ok(`${scored.length} catalog matches found`);
    scored.forEach((p, i) => info(`  ${i + 1}. [${p.id}] ${p.name} | ${p.brand} | Rs.${p.price} | score:${p.score}`));
  } else {
    fail('No matches found', 'Detected brand not in catalog — check brand names match');
    info('Try sending a photo of: ' + [...new Set(catalog.map(p => p.brand).filter(Boolean))].slice(0,5).join(', '));
  }
}

// ── TEST 5: Green API getFileByIdMessage ──────────────────────────────────────
async function testGreenApiFileDownload() {
  section('TEST 5 — Green API getFileByIdMessage');

  const testMsgId  = process.argv[3];
  const testChatId = process.argv[4]
    || (process.env.TEST_WHATSAPP_NUMBER
        ? process.env.TEST_WHATSAPP_NUMBER.replace(/\D/g, '') + '@c.us'
        : null);

  if (!testMsgId || !testChatId) {
    info('Skipped — to test, run:');
    info('  node tests/testVision.js <imageUrl> <messageId> <chatId>');
    info('  Example: node tests/testVision.js ./shoe.jpg 3EB0ABC 919876543210@c.us');
    return;
  }

  try {
    const res = await axios.post(
      `${GREEN_BASE}/waInstance${INSTANCE_ID}/getFileByIdMessage/${TOKEN}`,
      { chatId: testChatId, idMessage: testMsgId },
      { timeout: 10000 }
    );
    const url = res.data?.downloadUrl || res.data?.fileUrl || res.data?.url || null;
    if (url) {
      ok('Got image URL from Green API', url.slice(0, 80));
    } else {
      fail('No URL in response', `Keys returned: ${Object.keys(res.data).join(', ')}`);
      info(`Full response: ${JSON.stringify(res.data)}`);
    }
  } catch (err) {
    fail('getFileByIdMessage failed', err?.response?.data?.message || err.message);
    if (err?.response?.data) info(`Response: ${JSON.stringify(err.response.data)}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n👟 Maya Vision Test\n' + '═'.repeat(50));
  console.log(`  Model : ${VISION_MODEL}`);
  console.log(`  Image : ${TEST_IMAGE_INPUT}`);
  console.log('═'.repeat(50));

  await testEnv();
  const dataUrl      = await testImageLoad();
  const visionResult = await testGroqVision(dataUrl);
  await testCatalogMatch(visionResult);
  await testGreenApiFileDownload();

  console.log('\n' + '═'.repeat(50));
  console.log(`  ✅ ${passed} passed    ❌ ${failed} failed`);
  console.log(failed === 0
    ? '\n  🎉 Vision pipeline fully working!\n'
    : '\n  ⛔ Fix the ❌ items above\n'
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\n💥 Crashed:', err.message);
  process.exit(1);
});
