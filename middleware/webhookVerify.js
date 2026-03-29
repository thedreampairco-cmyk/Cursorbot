const crypto = require("crypto");

/**
 * Middleware: verifyRazorpayWebhook
 *
 * Validates the X-Razorpay-Signature header against the raw request body
 * using HMAC-SHA256 and your RAZORPAY_WEBHOOK_SECRET.
 *
 * IMPORTANT: This middleware must run BEFORE express.json() parses the body,
 * so we need the raw body buffer. See server.js for how this is set up using
 * express.raw() on the /api/webhooks route specifically.
 */
function verifyRazorpayWebhook(req, res, next) {
  const signature = req.headers["x-razorpay-signature"];

  if (!signature) {
    console.warn("[WebhookVerify] Missing X-Razorpay-Signature header");
    return res.status(400).json({ success: false, message: "Missing webhook signature" });
  }

  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[WebhookVerify] RAZORPAY_WEBHOOK_SECRET is not set in environment");
    return res.status(500).json({ success: false, message: "Webhook secret not configured" });
  }

  // req.body here is the raw Buffer (because we use express.raw() on this route)
  const rawBody = req.body;

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  // Use timingSafeEqual to prevent timing attacks
  const sigBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expectedSignature, "hex");

  if (
    sigBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    console.warn("[WebhookVerify] Signature mismatch — possible spoofed request");
    return res.status(403).json({ success: false, message: "Invalid webhook signature" });
  }

  // Signature is valid — parse the raw body into JSON for the controller
  try {
    req.body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ success: false, message: "Invalid JSON in webhook body" });
  }

  next();
}

module.exports = { verifyRazorpayWebhook };
