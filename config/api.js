'use strict';

const axios = require('axios');
const env = require('./env');
const logger = require('../errorHandler').logger;

// ── Groq HTTP client ──────────────────────────────────────────────────────────
const groqClient = axios.create({
  baseURL: 'https://api.groq.com/openai/v1',
  timeout: 30_000,
  headers: {
    Authorization: `Bearer ${env.groq.apiKey}`,
    'Content-Type': 'application/json',
  },
});

groqClient.interceptors.response.use(
  (r) => r,
  (err) => {
    logger.error('[Groq] API error', { status: err?.response?.status, data: err?.response?.data });
    return Promise.reject(err);
  }
);

// ── Green API HTTP client ─────────────────────────────────────────────────────
const greenApiClient = axios.create({
  baseURL: `${env.greenApi.baseUrl}/waInstance${env.greenApi.instanceId}`,
  timeout: 20_000,
});

greenApiClient.interceptors.response.use(
  (r) => r,
  (err) => {
    logger.error('[GreenAPI] request error', { status: err?.response?.status, data: err?.response?.data });
    return Promise.reject(err);
  }
);

// ── Google Sheets plain fetch (CSV) ──────────────────────────────────────────
const sheetsClient = axios.create({
  timeout: 15_000,
});

module.exports = { groqClient, greenApiClient, sheetsClient };
