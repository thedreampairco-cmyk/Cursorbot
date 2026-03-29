/**
 * server.js  —  Dream Pair Maya Backend
 *
 * Boot order:
 *   1. Env validation
 *   2. MongoDB connection
 *   3. Express middleware
 *   4. Route mounting
 *   5. Cron jobs
 *   6. HTTP server start
 */

require("dotenv").config();

const express      = require("express");
const helmet       = require("helmet");
const morgan       = require("morgan");
const rateLimit    = require("express-rate-limit");
const mongoose     = require("mongoose");

// ─── Routes ──────────────────────────────────────────────────────────────────
const paymentWebhookRouter = require("./routes/webhooks");
const orderNotifyRouter    = require("./routes/orderNotifications");

// ─── Controllers (used by bot middleware, exported for testing) ───────────────
const orderController = require("./controllers/orderController");

// ─── Cron Jobs ───────────────────────────────────────────────────────────────
// Import triggers the scheduler — keep this after DB connection
let cronStarted = false;

// ─── Env Validation ───────────────────────────────────────────────────────────
const REQUIRED_ENV = [
  "MONGODB_URI",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "GREEN_API_INSTANCE_ID",
  "GREEN_API_TOKEN",
  "GOOGLE_SHEET_ID",
  "GOOGLE_SA_KEY",
  "BASE_URL",
  "SENDGRID_API_KEY",
  "SLACK_WEBHOOK_URL",
  "ORDER_WEBHOOK_SECRET",
];

const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error("❌ Missing required environment variables:", missing.join(", "));
  process.exit(1);
}

// ─── App Setup ───────────────────────────────────────────────────────────────
const app = express();

app.use(helmet());
app.use(morgan("combined"));

// Global rate limiter (protects all endpoints)
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000, // 15 min
    max:      200,
    standardHeaders: true,
    legacyHeaders:   false,
  })
);

// ─── IMPORTANT: Webhook route uses raw body parser ───────────────────────────
// Mount BEFORE global json() so HMAC verification has access to raw bytes.
app.use("/api/webhooks/payment", paymentWebhookRouter);

// Global JSON parser for all other routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status:   "ok",
    service:  "maya-dream-pair",
    uptime:   process.uptime(),
    db:       mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});

// ─── Payment Success Redirect (Razorpay callback) ─────────────────────────────
app.get("/payment/success", (req, res) => {
  // Razorpay redirects here after hosted-page payment.
  // The real confirmation comes via webhook; this page is just UX polish.
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <h2>✅ Payment Received!</h2>
      <p>Head back to WhatsApp — your size lock confirmation is on its way. 🚀</p>
    </body></html>
  `);
});

// ─── Order notifications (email + admin alert) ───────────────────────────────
// Uses parsed JSON body — mounted AFTER express.json()
app.use("/api/webhooks/order", orderNotifyRouter);

// ─── [TODO] Add your Green API / LLM message handler route here ──────────────
// app.use("/api/messages", require("./routes/messages"));

// ─── MongoDB Connection ────────────────────────────────────────────────────────
async function startServer() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log("✅ MongoDB connected");

    // Start cron jobs only after DB is ready
    if (!cronStarted) {
      require("./jobs/tokenExpiryJob");
      cronStarted = true;
    }

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`🚀 Maya server running on port ${PORT}`);
      console.log(`   Webhook endpoint: POST /api/webhooks/payment`);
      console.log(`   Webhook endpoint: POST /api/webhooks/order`);
      console.log(`   Health check:     GET  /health`);
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err);
    process.exit(1);
  }
}

startServer();

module.exports = { app, orderController }; // exported for tests
