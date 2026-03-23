'use strict';

require('dotenv').config();

const required = [
  'MONGO_URI',
  'GROQ_API_KEY',
  'GREEN_API_INSTANCE_ID',
  'GREEN_API_TOKEN',
  'GOOGLE_SHEETS_CSV_URL',
];

const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`[ENV] Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',

  mongo: {
    uri: process.env.MONGO_URI,
  },

  groq: {
    apiKey: process.env.GROQ_API_KEY,
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  },

  greenApi: {
    instanceId: process.env.GREEN_API_INSTANCE_ID,
    token: process.env.GREEN_API_TOKEN,
    baseUrl: process.env.GREEN_API_BASE_URL || 'https://api.greenapi.com',
  },

  sheets: {
    csvUrl: process.env.GOOGLE_SHEETS_CSV_URL,
  },

  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
  },

  handoff: {
    agentNumber: process.env.HUMAN_AGENT_WHATSAPP || '',
    triggerKeywords: (process.env.HANDOFF_TRIGGER_KEYWORDS || 'agent,human,support')
      .split(',')
      .map((k) => k.trim().toLowerCase()),
  },

  admin: {
    secret: process.env.ADMIN_SECRET || 'changeme',
  },

  catalog: {
    syncCron: process.env.CATALOG_SYNC_CRON || '*/30 * * * *',
  },

  marketing: {
    abandonedCartHours: parseInt(process.env.ABANDONED_CART_HOURS || '2', 10),
  },
};
