// errorHandler.js
"use strict";

const winston = require("winston");

// ─── Logger ────────────────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack }) =>
      stack
        ? `[${timestamp}] ${level.toUpperCase()}: ${message}\n${stack}`
        : `[${timestamp}] ${level.toUpperCase()}: ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: "logs/error.log",
      level: "error",
      maxsize: 5 * 1024 * 1024, // 5 MB
      maxFiles: 3,
    }),
    new winston.transports.File({
      filename: "logs/combined.log",
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
    }),
  ],
});

// ─── Custom Error Class ─────────────────────────────────────────────────────────
class AppError extends Error {
  /**
   * @param {string} message
   * @param {number} statusCode
   * @param {string} [code]       - machine-readable error code, e.g. "PAYMENT_FAILED"
   * @param {boolean} [isOperational] - true = expected error, false = programmer bug
   */
  constructor(message, statusCode = 500, code = "INTERNAL_ERROR", isOperational = true) {
    super(message);
    this.name       = "AppError";
    this.statusCode = statusCode;
    this.code       = code;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

// ─── asyncHandler ───────────────────────────────────────────────────────────────
/**
 * Wraps an async Express route/controller so that any thrown error
 * is automatically forwarded to next(err) — no try/catch boilerplate needed.
 *
 * @param {(req, res, next) => Promise<any>} fn
 * @returns {(req, res, next) => void}
 */
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ─── 404 Handler ───────────────────────────────────────────────────────────────
/**
 * Express middleware — catches unmatched routes and forwards a 404 AppError.
 */
function notFoundHandler(req, res, next) {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404, "NOT_FOUND"));
}

// ─── Global Express Error Handler ──────────────────────────────────────────────
/**
 * Express 4-argument error middleware.
 * Must be registered LAST in app.js after all routes.
 */
// eslint-disable-next-line no-unused-vars
function globalErrorHandler(err, req, res, next) {
  // Default values
  let statusCode = err.statusCode || 500;
  let code       = err.code       || "INTERNAL_ERROR";
  let message    = err.message    || "An unexpected error occurred.";

  // Mongoose Validation Error
  if (err.name === "ValidationError") {
    statusCode = 422;
    code       = "VALIDATION_ERROR";
    message    = Object.values(err.errors)
      .map((e) => e.message)
      .join("; ");
  }

  // Mongoose Duplicate Key
  if (err.code === 11000) {
    statusCode = 409;
    code       = "DUPLICATE_KEY";
    const field = Object.keys(err.keyValue || {}).join(", ");
    message    = `Duplicate value for field(s): ${field}`;
  }

  // Mongoose Cast Error (bad ObjectId)
  if (err.name === "CastError") {
    statusCode = 400;
    code       = "INVALID_ID";
    message    = `Invalid value for field '${err.path}': ${err.value}`;
  }

  // JWT errors
  if (err.name === "JsonWebTokenError") {
    statusCode = 401;
    code       = "INVALID_TOKEN";
    message    = "Invalid authentication token.";
  }
  if (err.name === "TokenExpiredError") {
    statusCode = 401;
    code       = "TOKEN_EXPIRED";
    message    = "Authentication token has expired.";
  }

  // Log severity
  if (statusCode >= 500) {
    logger.error(`[${code}] ${message}`, { stack: err.stack, path: req.originalUrl });
  } else {
    logger.warn(`[${code}] ${message}`, { path: req.originalUrl });
  }

  // Never leak stack traces in production
  const response = {
    success: false,
    code,
    message,
  };

  if (process.env.NODE_ENV === "development") {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
}

// ─── Unhandled Rejections & Exceptions ─────────────────────────────────────────
/**
 * Call once at app startup (in server.js) to wire up process-level safety nets.
 */
function registerProcessHandlers() {
  process.on("unhandledRejection", (reason, promise) => {
    logger.error("Unhandled Promise Rejection", { reason, promise });
    // Give the logger time to flush, then exit so the process manager restarts cleanly
    setTimeout(() => process.exit(1), 500);
  });

  process.on("uncaughtException", (err) => {
    logger.error("Uncaught Exception — shutting down", { stack: err.stack });
    setTimeout(() => process.exit(1), 500);
  });
}

module.exports = {
  logger,
  AppError,
  asyncHandler,
  notFoundHandler,
  globalErrorHandler,
  registerProcessHandlers,
};
