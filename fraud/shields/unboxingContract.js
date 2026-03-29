const FraudState = require('../../models/FraudState');
const { sendWhatsAppMessage } = require('../../integrations/whatsapp/sender');
const logger = require('../../utils/logger');

/**
 * Called when Shiprocket fires an "out_for_delivery" status webhook.
 * Sends the unboxing contract message to the customer.
 *
 * @param {object} shiprocketEvent - normalized Shiprocket webhook payload
 */
async function handleOutForDelivery({ orderId, phone, courierName, awb }) {
  const state = await FraudState.findOne({ orderId });

  // Only send for COD orders — prepaid orders don't need an unboxing contract
  if (!state || state.paymentMethod !== 'cod') {
    logger.info('Skipping unboxing contract (prepaid or state not found)', { orderId });
    return null;
  }

  if (state.unboxing?.contractSentAt) {
    logger.warn('Unboxing contract already sent', { orderId });
    return state;
  }

  await sendUnboxingContract({ phone, courierName, awb });

  state.unboxing = state.unboxing || {};
  state.unboxing.contractSentAt = new Date();
  await state.save();

  logger.info('Unboxing contract sent', { orderId, phone, courierName });
  return state;
}

/**
 * Fires the unboxing contract WhatsApp message.
 * Matches the exact script from the master system prompt.
 */
async function sendUnboxingContract({ phone, courierName, awb }) {
  const openBoxNote =
    courierName?.toLowerCase().includes('delhivery') || courierName?.toLowerCase().includes('ekart')
      ? `\n\nPro tip: You can also request *Open Box Delivery* from the courier agent — ask them to open it in front of you before signing. 📦`
      : '';

  const message =
    `Your sneakers are arriving today! 🚚🔥\n\n` +
    `*IMPORTANT — Read this before accepting:*\n\n` +
    `To protect both you and us, please record a *continuous, uncut 360° unboxing video* ` +
    `the moment the delivery agent hands you the package. Start recording before you open anything.\n\n` +
    `This video is required to process any claims about:\n` +
    `• Wrong item or size\n` +
    `• Damaged product\n` +
    `• Missing contents\n\n` +
    `*We cannot process any claims without this video.* 🙏${openBoxNote}\n\n` +
    `Can't wait for you to see them in hand! 🔥👟`;

  await sendWhatsAppMessage({ to: phone, text: message });
}

/**
 * Records that the customer has sent their unboxing video.
 * Called from the webhook handler when an incoming video message arrives post-delivery.
 */
async function receiveUnboxingVideo({ orderId, phone, mediaId }) {
  const state = await FraudState.findOne({
    $or: [{ orderId }, { phone }],
    'unboxing.contractSentAt': { $exists: true },
    'unboxing.videoReceivedAt': { $exists: false },
  }).sort({ createdAt: -1 });

  if (!state) {
    logger.info('Unboxing video received but no matching state found', { phone, mediaId });
    return null;
  }

  state.unboxing.videoReceivedAt = new Date();
  state.unboxing.videoMediaId = mediaId;
  await state.save();

  await sendWhatsAppMessage({
    to: phone,
    text:
      `Got your unboxing video ✅ You're all set!\n\n` +
      `If there's anything wrong with your order, reply here and we'll sort it out immediately. 🤝`,
  });

  logger.info('Unboxing video received and logged', { orderId: state.orderId, phone, mediaId });
  return state;
}

/**
 * Normalizes a raw Shiprocket webhook body into the shape handleOutForDelivery expects.
 * Shiprocket sends inconsistent field names across event types — this irons it out.
 */
function parseShiprocketWebhook(body) {
  const awb = body.awb || body.awb_code || body.shipment?.awb;
  const orderId =
    body.order_id?.toString() ||
    body.channel_order_id?.toString() ||
    body.shipment?.order_id?.toString();
  const phone =
    body.customer_phone ||
    body.consignee?.phone ||
    body.shipment?.customer_details?.phone;
  const status = (body.current_status || body.status || '').toLowerCase();
  const courierName = body.courier_name || body.courier?.name || '';

  return { awb, orderId, phone, status, courierName };
}

module.exports = {
  handleOutForDelivery,
  receiveUnboxingVideo,
  parseShiprocketWebhook,
};
