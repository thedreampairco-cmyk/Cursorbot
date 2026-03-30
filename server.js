require("dotenv").config();

const express      = require("express");
const helmet       = require("helmet");
const morgan       = require("morgan");
const rateLimit    = require("express-rate-limit");
const mongoose     = require("mongoose");

// ─── Routes ──────────────────────────────────────────────────────────────────
const paymentWebhookRouter = require("./routes/webhooks");
const orderNotifyRouter    = require("./routes/orderNotifications");
const greenApiRouter       = require("./routes/webhook");

// ─── Controllers ─────────────────────────────────────────────────────────────
const orderController = require("./controllers/orderController");

// ─── Cron Jobs ───────────────────────────────────────────────────────────────
let cronStarted = false;

// ─── Env Validation ───────────────────────────────────────────────────────────
const REQUIRED_ENV = [
  "MONGODB_URI",
  "GROQ_API_KEY",
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

// Add this line to fix the Render proxy error
app.set('trust proxy', 1); 

app.use(helmet());
app.use(morgan("combined"));

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max:      200,
    standardHeaders: true,
    legacyHeaders:   false,
  })
);

// ─── Raw body routes BEFORE express.json() ───────────────────────────────────

app.set('trust proxy', 1);

// Add this line to parse incoming Green API JSON payloads
app.use(express.json());

// Your routes must come AFTER the body parser


app.use("/api/webhooks/payment",  paymentWebhookRouter);
app.use("/api/webhooks/greenapi", greenApiRouter);

// ─── Global JSON parser ───────────────────────────────────────────────────────
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

// ─── Payment Success Redirect ─────────────────────────────────────────────────
app.get("/payment/success", (req, res) => {
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <h2>✅ Payment Received!</h2>
      <p>Head back to WhatsApp — your size lock confirmation is on its way. 🚀</p>
    </body></html>
  `);
});

// ─── Order notifications ──────────────────────────────────────────────────────
app.use("/api/webhooks/order", orderNotifyRouter);

// ─── MongoDB + Server Start ───────────────────────────────────────────────────
async function startServer() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log("✅ MongoDB connected");

    if (!cronStarted) {
      require("./jobs/tokenExpiryJob");
      cronStarted = true;
    }

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`🚀 Maya server running on port ${PORT}`);
      console.log(`   Green API webhook:  POST /api/webhooks/greenapi`);
      console.log(`   Payment webhook:    POST /api/webhooks/payment`);
      console.log(`   Order webhook:      POST /api/webhooks/order`);
      console.log(`   Health check:       GET  /health`);
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err);
    process.exit(1);
  }
}

startServer();

module.exports = { app, orderController };
