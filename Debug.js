#!/usr/bin/env node
'use strict';

/**
 * Maya Debug Tool
 * Run: node debug.js
 * Tests every component and shows exactly where the failure is.
 */

require('dotenv').config();
const https = require('https');
const http = require('http');

const BASE_URL = process.env.RENDER_URL || 'http://localhost:3000';

const GREEN_INSTANCE = process.env.GREEN_API_INSTANCE_ID;
const GREEN_TOKEN    = process.env.GREEN_API_TOKEN;
const GROQ_KEY       = process.env.GROQ_API_KEY;
const MONGO_URI      = process.env.MONGO_URI;
const SHEETS_URL     = process.env.GOOGLE_SHEETS_CSV_URL;
const ADMIN_SECRET   = process.env.ADMIN_SECRET || 'changeme';

const ok  = (msg) => console.log(`  ✅  ${msg}`);
const err = (msg) => console.log(`  ❌  ${msg}`);
const inf = (msg) => console.log(`  ℹ️   ${msg}`);
const hdr = (msg) => console.log(`\n${'─'.repeat(50)}\n  ${msg}\n${'─'.repeat(50)}`);

function fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const options = { ...require('url').parse(url), ...opts };
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout after 10s')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function checkEnvVars() {
  hdr('1. Environment Variables');
  const vars = {
    MONGO_URI:              MONGO_URI,
    GROQ_API_KEY:           GROQ_KEY,
    GREEN_API_INSTANCE_ID:  GREEN_INSTANCE,
    GREEN_API_TOKEN:        GREEN_TOKEN,
    GOOGLE_SHEETS_CSV_URL:  SHEETS_URL,
    ADMIN_SECRET:           ADMIN_SECRET,
  };
  let allOk = true;
  for (const [k, v] of Object.entries(vars)) {
    if (v && v.length > 3) {
      ok(`${k} = ${v.slice(0, 6)}...`);
    } else {
      err(`${k} is MISSING or empty`);
      allOk = false;
    }
  }
  return allOk;
}

async function checkHealth() {
  hdr('2. Server Health Check');
  try {
    const res = await fetch(`${BASE_URL}/health`);
    if (res.status === 200) {
      ok(`Server is UP — ${BASE_URL}/health → ${res.status}`);
      inf(`Response: ${res.body}`);
    } else {
      err(`Health check failed → HTTP ${res.status}`);
      inf(`Body: ${res.body}`);
    }
  } catch (e) {
    err(`Cannot reach server at ${BASE_URL}`);
    inf(`Error: ${e.message}`);
    inf(`Make sure server is running or set RENDER_URL=https://your-app.onrender.com`);
  }
}

async function checkCatalog() {
  hdr('3. Catalog Sync');
  try {
    // Trigger sync
    const syncRes = await fetch(`${BASE_URL}/catalog/sync`, {
      method: 'POST',
      headers: { 'x-admin-token': ADMIN_SECRET, 'Content-Type': 'application/json' },
    });
    if (syncRes.status === 200) {
      const data = JSON.parse(syncRes.body);
      if (data.synced > 0) {
        ok(`Catalog synced — ${data.synced} products loaded`);
      } else {
        err(`Catalog synced but 0 products — check your Google Sheet URL and column headers`);
        inf(`Sheet URL: ${SHEETS_URL}`);
      }
    } else if (syncRes.status === 401) {
      err(`Admin token rejected — ADMIN_SECRET mismatch`);
      inf(`Used token: ${ADMIN_SECRET}`);
    } else {
      err(`Catalog sync failed → HTTP ${syncRes.status}`);
      inf(`Body: ${syncRes.body}`);
    }
  } catch (e) {
    err(`Catalog sync request failed: ${e.message}`);
  }
}

async function checkGroq() {
  hdr('4. Groq AI Connection');
  if (!GROQ_KEY) { err('GROQ_API_KEY not set — skipping'); return; }
  try {
    const payload = JSON.stringify({
      model: process.env.GROQ_MODEL || 'llama3-70b-8192',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'Say: GROQ_OK' }],
    });
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      body: payload,
    });
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      const reply = data?.choices?.[0]?.message?.content || '';
      ok(`Groq API working — replied: "${reply.trim()}"`);
    } else if (res.status === 401) {
      err(`Groq API key is INVALID → 401 Unauthorized`);
    } else if (res.status === 429) {
      err(`Groq API rate limit hit → 429`);
    } else {
      err(`Groq API error → HTTP ${res.status}`);
      inf(`Body: ${res.body.slice(0, 300)}`);
    }
  } catch (e) {
    err(`Groq connection failed: ${e.message}`);
  }
}

async function checkGreenApi() {
  hdr('5. Green API Connection');
  if (!GREEN_INSTANCE || !GREEN_TOKEN) {
    err('GREEN_API_INSTANCE_ID or GREEN_API_TOKEN not set — skipping');
    return;
  }
  try {
    const url = `https://api.greenapi.com/waInstance${GREEN_INSTANCE}/getStateInstance/${GREEN_TOKEN}`;
    const res = await fetch(url);
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      const state = data?.stateInstance;
      if (state === 'authorized') {
        ok(`Green API instance is AUTHORIZED ✅`);
      } else {
        err(`Green API instance state: "${state}" — NOT authorized`);
        inf(`You need to scan the QR code in Green API dashboard`);
        inf(`Go to: https://app.greenapi.com → your instance → Scan QR`);
      }
      inf(`Full state: ${JSON.stringify(data)}`);
    } else {
      err(`Green API check failed → HTTP ${res.status}`);
      inf(`Body: ${res.body.slice(0, 300)}`);
      inf(`Instance ID: ${GREEN_INSTANCE}`);
    }
  } catch (e) {
    err(`Green API connection failed: ${e.message}`);
  }
}

async function checkGreenApiWebhook() {
  hdr('6. Green API Webhook Settings');
  if (!GREEN_INSTANCE || !GREEN_TOKEN) { err('Credentials missing — skipping'); return; }
  try {
    const url = `https://api.greenapi.com/waInstance${GREEN_INSTANCE}/getSettings/${GREEN_TOKEN}`;
    const res = await fetch(url);
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      const webhookUrl = data?.webhookUrl || data?.webhookUrlToken || '';
      if (webhookUrl && webhookUrl.includes('onrender.com')) {
        ok(`Webhook URL set: ${webhookUrl}`);
      } else if (webhookUrl) {
        err(`Webhook URL is set but may be wrong: ${webhookUrl}`);
        inf(`Expected something like: https://cursorbot-xai5.onrender.com/webhook`);
      } else {
        err(`Webhook URL is NOT set in Green API`);
        inf(`Set it at: https://app.greenapi.com → your instance → Settings → Webhook URL`);
        inf(`Value should be: ${BASE_URL}/webhook`);
      }
      inf(`Incoming webhooks enabled: ${data?.incomingWebhook || 'unknown'}`);
    } else {
      err(`Could not fetch Green API settings → HTTP ${res.status}`);
    }
  } catch (e) {
    err(`Green API settings check failed: ${e.message}`);
  }
}

async function checkGreenApiSend() {
  hdr('7. Green API Send Message Test');
  const testNumber = process.env.TEST_WHATSAPP_NUMBER;
  if (!testNumber) {
    inf(`Skipping send test — set TEST_WHATSAPP_NUMBER=91XXXXXXXXXX in .env to enable`);
    return;
  }
  if (!GREEN_INSTANCE || !GREEN_TOKEN) { err('Credentials missing — skipping'); return; }
  try {
    const chatId = testNumber.includes('@') ? testNumber : `${testNumber}@c.us`;
    const payload = JSON.stringify({ chatId, message: '🧪 Maya debug test message — ignore' });
    const url = `https://api.greenapi.com/waInstance${GREEN_INSTANCE}/sendMessage/${GREEN_TOKEN}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      body: payload,
    });
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      ok(`Message sent successfully — idMessage: ${data?.idMessage}`);
    } else {
      err(`Send message failed → HTTP ${res.status}`);
      inf(`Body: ${res.body.slice(0, 300)}`);
    }
  } catch (e) {
    err(`Send message test failed: ${e.message}`);
  }
}

async function simulateWebhook() {
  hdr('8. Simulated Webhook Message (end-to-end)');
  const testChatId = process.env.TEST_WHATSAPP_NUMBER
    ? `${process.env.TEST_WHATSAPP_NUMBER}@c.us`
    : '919999999999@c.us';

  const fakePayload = JSON.stringify({
    typeWebhook: 'incomingMessageReceived',
    senderData: { chatId: testChatId, senderName: 'DebugUser' },
    messageData: {
      typeMessage: 'textMessage',
      textMessageData: { textMessage: 'Hi Maya, show me Nike shoes' },
    },
  });

  try {
    const res = await fetch(`${BASE_URL}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(fakePayload) },
      body: fakePayload,
    });
    if (res.status === 200) {
      ok(`Webhook accepted simulated message → HTTP ${res.status}`);
      inf(`Now check Render logs for [Webhook] and [AI] entries`);
      inf(`If TEST_WHATSAPP_NUMBER is set, check that WhatsApp number for Maya's reply`);
    } else {
      err(`Webhook rejected simulated message → HTTP ${res.status}`);
      inf(`Body: ${res.body}`);
    }
  } catch (e) {
    err(`Simulated webhook failed: ${e.message}`);
  }
}

async function main() {
  console.log('\n🔍 Maya Full Debug Report');
  console.log(`   Timestamp: ${new Date().toISOString()}`);
  console.log(`   Target:    ${BASE_URL}`);

  await checkEnvVars();
  await checkHealth();
  await checkCatalog();
  await checkGroq();
  await checkGreenApi();
  await checkGreenApiWebhook();
  await checkGreenApiSend();
  await simulateWebhook();

  console.log('\n' + '═'.repeat(50));
  console.log('  Debug complete. Fix all ❌ items above.');
  console.log('  Then send a WhatsApp message and check logs.');
  console.log('═'.repeat(50) + '\n');
}

main().catch(console.error);
