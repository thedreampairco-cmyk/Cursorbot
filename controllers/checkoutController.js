const { createPaymentLink } = require("../services/paymentService");
const { sendPaymentLinkMessage } = require("../services/features/whatsappService");
const Order = require("../models/Order");

/**
 * POST /api/checkout
 *
 * Creates a Razorpay Payment Link and sends it to the customer via WhatsApp.
 *
 * Expected request body:
 * {
 *   "order_id":       "ORD-12345",
 *   "customer_name":  "Priya Sharma",
 *   "customer_phone": "919876543210",   ← include country code, no '+'
 *   "amount":         1299              ← in rupees
 * }
 */
async function createCheckout(req, res) {
  const { order_id, customer_name, customer_phone, amount } = req.body;

  // ── 1. Input validation ────────────────────────────────────────────────────
  if (!order_id || !customer_name || !customer_phone || !amount) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields: order_id, customer_name, customer_phone, amount",
    });
  }

  if (typeof amount !== "number" || amount <= 0) {
    return res.status(400).json({
      success: false,
      message: "amount must be a positive number (in rupees)",
    });
  }

  try {
    // ── 2. Create or fetch the order record in our DB ────────────────────────
    // Using findOneAndUpdate with upsert to be idempotent —
    // re-sending the same order_id won't create duplicates.
    let order = await Order.findOneAndUpdate(
      { orderId: order_id },
      {
        $setOnInsert: {
          orderId: order_id,
          customerName: customer_name,
          customerPhone: customer_phone,
          amount,
          status: "pending",
        },
      },
      { upsert: true, new: true }
    );

    // If the order is already paid, don't regenerate a link
    if (order.status === "paid") {
      return res.status(409).json({
        success: false,
        message: `Order ${order_id} has already been paid.`,
      });
    }

    // ── 3. Create Razorpay Payment Link ──────────────────────────────────────
    const paymentLink = await createPaymentLink({
      orderId: order_id,
      customerName: customer_name,
      customerPhone: customer_phone,
      amount,
    });

    const shortUrl = paymentLink.short_url;

    // ── 4. Persist the Razorpay link details to our order ───────────────────
    await Order.findOneAndUpdate(
      { orderId: order_id },
      {
        razorpayPaymentLinkId: paymentLink.id,
        razorpayPaymentLinkUrl: shortUrl,
      }
    );

    // ── 5. Send WhatsApp message ─────────────────────────────────────────────
    await sendPaymentLinkMessage({
      customerPhone: customer_phone,
      customerName: customer_name,
      amount,
      paymentUrl: shortUrl,
    });

    // ── 6. Respond to frontend ───────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      message: "Payment link created and sent via WhatsApp.",
      data: {
        order_id,
        payment_link_id: paymentLink.id,
        payment_url: shortUrl,
        expires_at: new Date(paymentLink.expire_by * 1000).toISOString(),
      },
    });
  } catch (error) {
    console.error("[checkoutController] Error:", error?.error || error?.message || error);

    // Surface Razorpay-specific error messages when available
    const razorpayError = error?.error?.description || null;

    return res.status(500).json({
      success: false,
      message: razorpayError || "Failed to create payment link. Please try again.",
      ...(process.env.NODE_ENV === "development" && { debug: error?.message }),
    });
  }
}

module.exports = { createCheckout };
