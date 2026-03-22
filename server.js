'use strict';

// Load env first – before any other module reads process.env
const env = require('./config/env');

const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { errorMiddleware, logger } = require('./errorHandler');
const webhookRouter = require('./routes/webhook');
const { router: catalogRouter, startCatalogCron } = require('./routes/catalogSync');
const { router: adminRouter, startMarketingCrons } = require('./routes/masterAdmin');
const { fetchAndSyncCatalog } = require('./services/data/googleSheetsFetch');

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();

// Security
app.use(helmet());
app.set('trust proxy', 1);

// Logging
app.use(morgan(env.isProd ? 'combined' : 'dev'));

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Rate limiting – 300 req/min per IP (webhook)
const limiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests' },
});
app.use(limiter);

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, service: 'maya', timestamp: new Date() }));

app.use('/webhook', webhookRouter);
app.use('/catalog', catalogRouter);
app.use('/admin', adminRouter);

// 404
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

// Global error handler
app.use(errorMiddleware);

// ── Bootstrap ──────────────────────────────────────────────────────────────────
async function bootstrap() {
  // 1. Connect to MongoDB
  logger.info('[Boot] Connecting to MongoDB…');
  await mongoose.connect(env.mongo.uri, {
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
  });
  logger.info('[Boot] MongoDB connected');

  // 2. Load catalog from Google Sheets
  logger.info('[Boot] Loading initial catalog from Google Sheets…');
  try {
    await fetchAndSyncCatalog();
  } catch (err) {
    logger.warn('[Boot] Initial catalog sync failed – will retry on cron', { error: err.message });
  }

  // 3. Start background jobs
  startCatalogCron();
  startMarketingCrons();

  // 4. Start HTTP server
  const server = app.listen(env.port, () => {
    logger.info(`[Boot] Maya is live on port ${env.port} (${env.nodeEnv})`);
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info(`[Boot] ${signal} received – shutting down gracefully`);
    server.close(async () => {
      await mongoose.disconnect();
      logger.info('[Boot] Shutdown complete');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 15_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('[Boot] Unhandled rejection', { reason });
  });
  process.on('uncaughtException', (err) => {
    logger.error('[Boot] Uncaught exception', { error: err.message, stack: err.stack });
    process.exit(1);
  });
}

bootstrap().catch((err) => {
  console.error('[Boot] Fatal startup error:', err);
  process.exit(1);
});

module.exports = app; // for testing
