const axios = require('axios');
require('dotenv').config();

// Import your test modules
const webhookTest = require('./webhookTest');
const inventoryTest = require('./inventoryTest');
const aiTest = require('./aiTest');
const visionTest = require('./visionTest');

async function startSystemAudit() {
    console.log(`\n==========================================================`);
    console.log(`🛡️  DREAM PAIR SYSTEM AUDIT | ${new Date().toLocaleString()}`);
    console.log(`==========================================================\n`);

    const results = [];

    // 1. Test Core Webhook
    results.push(await webhookTest.run());

    // 2. Test Inventory Service
    results.push(await inventoryTest.run());

    // 3. Test AI & System Prompt
    results.push(await aiTest.run());

    // 4. Test Vision AI Pipeline
    results.push(await visionTest.run());

    console.log(`\n--- 📊 FINAL HEALTH REPORT ---`);
    results.forEach(res => {
        const icon = res.passed ? "🟢" : "🔴";
        console.log(`${icon} ${res.component}: ${res.status}`);
        if (!res.passed) console.log(`   └─ Error: ${res.error}`);
    });
    console.log(`\n==========================================================`);
}

startSystemAudit();
