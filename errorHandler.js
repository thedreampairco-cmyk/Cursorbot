'use strict';

const winston = require('winston');
const env = require('./config/env');

// ── Logger ────────────────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (env.isProd ? 'info' : 'debug'),
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    env.isProd
      ? winston.format.json()
      : winston.format.combine(winston.format.colorize(), winston.format.simple())
  ),
  transports: [
    new winston.transports.Console(),
    ...(env.isProd
      ? [
          new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
          new winston.transports.File({ filename: 'logs/combined.log' }),
        ]
      : []),
  ],
});

// ── Express error middleware ───────────────────────────────────────────────────
function errorMiddleware(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;
  logger.error('[Express] Unhandled error', { message: err.message, stack: err.stack, path: req.path });
  res.status(status).json({
    ok: false,
    error: env.isProd ? 'Internal server error' : err.message,
  });
}

// ── Async wrapper to avoid try/catch boilerplate ──────────────────────────────
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { logger, errorMiddleware, asyncHandler };
