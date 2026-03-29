const axios = require('axios');
const FraudState = require('../../models/FraudState');
const { sendWhatsAppMessage } = require('../../integrations/whatsapp/sender');
const { notifyAdmin } = require('../../admin/notifier');
const logger = require('../../utils/logger');

const PINCODE_MISMATCH_TOLERANCE_KM = 30; // allow up to 30km (covers suburbs sharing a pincode)

/**
 * Processes an incoming WhatsApp live_location message.
 * Called from the webhook handler when message.type === 'location'.
 *
 * @param {string} phone - sender's phone number
 * @param {object} location - { latitude, longitude } from WhatsApp payload
 */
async function handleIncomingLocation({ phone, location }) {
  const state = await FraudState.findOne({
    phone,
    overallStatus: 'awaiting_location',
  }).sort({ createdAt: -1 });

  if (!state) {
    // Not in the location-awaiting flow — ignore silently
    return null;
  }

  const { latitude, longitude } = location;

  // Reverse-geocode to get pin code
  const resolvedPincode = await reversGeocodePincode(latitude, longitude);

  const pincodeMatch =
    state.location.orderPincode
      ? resolvedPincode === state.location.orderPincode
      : true; // if pincode not yet set, accept (edge case — address not yet captured)

  // Update state
  state.location.status = pincodeMatch ? 'verified' : 'failed';
  state.location.receivedAt = new Date();
  state.location.latitude = latitude;
  state.location.longitude = longitude;
  state.location.resolvedPincode = resolvedPincode;
  state.location.pincodeMatch = pincodeMatch;

  if (pincodeMatch) {
    state.overallStatus = 'cleared';
    await state.save();
    await sendClearedMessage(state);
    logger.info('Location verified — order cleared', {
      orderId: state.orderId,
      resolvedPincode,
      orderPincode: state.location.orderPincode,
    });
  } else {
    state.overallStatus = 'blocked';
    state.blockedReason = `Pincode mismatch: GPS=${resolvedPincode}, order=${state.location.orderPincode}`;
    await state.save();
    await sendPincodeMismatchMessage(state, resolvedPincode);
    await notifyAdmin({
      message:
        `🚨 FRAUD ALERT — Pincode mismatch on order ${state.orderId}.\n` +
        `GPS resolved: ${resolvedPincode} | Order pincode: ${state.location.orderPincode}\n` +
        `Phone: ${phone}`,
    });
    logger.warn('Location mismatch — order blocked', {
      orderId: state.orderId,
      resolvedPincode,
      orderPincode: state.location.orderPincode,
    });
  }

  return state;
}

/**
 * Reverse-geocodes lat/lng to an Indian PIN code using Google Maps Geocoding API.
 * Falls back to OpenStreetMap Nominatim if Google key not configured.
 */
async function reversGeocodePincode(latitude, longitude) {
  if (process.env.GOOGLE_MAPS_API_KEY) {
    return reverseGeocodeGoogle(latitude, longitude);
  }
  return reverseGeocodeNominatim(latitude, longitude);
}

async function reverseGeocodeGoogle(latitude, longitude) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json`;
  const { data } = await axios.get(url, {
    params: {
      latlng: `${latitude},${longitude}`,
      key: process.env.GOOGLE_MAPS_API_KEY,
      result_type: 'postal_code',
    },
    timeout: 5000,
  });

  const postalComponent = data.results?.[0]?.address_components?.find((c) =>
    c.types.includes('postal_code')
  );

  if (!postalComponent) throw new Error('Could not resolve pincode from GPS');
  return postalComponent.long_name;
}

async function reverseGeocodeNominatim(latitude, longitude) {
  const { data } = await axios.get('https://nominatim.openstreetmap.org/reverse', {
    params: { lat: latitude, lon: longitude, format: 'json' },
    headers: { 'User-Agent': 'the-dream-pair-maya/1.0' },
    timeout: 5000,
  });

  const pincode = data.address?.postcode;
  if (!pincode) throw new Error('Could not resolve pincode from GPS (Nominatim)');
  return pincode;
}

/**
 * Sends confirmation + shipping ETA once location clears.
 */
async function sendClearedMessage(state) {
  await sendWhatsAppMessage({
    to: state.phone,
    text:
      `📍 Location verified! ✅\n\n` +
      `Your order is confirmed and we're generating your shipping label now. ` +
      `Expect a tracking link within the next few hours. 🚚🔥`,
  });
}

/**
 * Notifies customer of a mismatch and gives them a chance to clarify.
 * (We don't reveal the exact detected pincode — prevents gaming.)
 */
async function sendPincodeMismatchMessage(state) {
  await sendWhatsAppMessage({
    to: state.phone,
    text:
      `Hmm, there seems to be a mismatch between your location and the delivery address you gave us. 🤔\n\n` +
      `Make sure you're sharing your live location from the delivery address, then try again — ` +
      `or reply to update your address and we'll re-verify.`,
  });
}

/**
 * Attach the order's delivery pincode to the fraud state.
 * Call this after the customer confirms their delivery address.
 */
async function setOrderPincode({ orderId, pincode }) {
  const state = await FraudState.findOne({ orderId });
  if (!state) return;
  state.location.orderPincode = pincode;
  await state.save();
}

/**
 * Handle the case where a customer refuses to share location.
 * Drop the order, refund deposit, notify admin.
 */
async function handleLocationRefusal({ phone, orderId }) {
  const state = await FraudState.findOne({ orderId: orderId || undefined, phone });
  if (!state || state.overallStatus !== 'awaiting_location') return;

  state.overallStatus = 'blocked';
  state.location.status = 'failed';
  state.blockedReason = 'Customer refused to share live location';
  await state.save();

  await sendWhatsAppMessage({
    to: phone,
    text:
      `We're sorry — for limited COD drops, location verification is required to protect both sides. ` +
      `Your ₹${state.deposit.amount} deposit will be refunded within 3–5 business days.\n\n` +
      `If you'd prefer prepaid, we can process the full payment and ship right away! 🤝`,
  });

  await notifyAdmin({
    message:
      `🚫 COD order blocked — location refused.\n` +
      `Order: ${state.orderId} | Phone: ${phone}\n` +
      `Initiate deposit refund manually.`,
  });

  logger.info('Order blocked — location refused', { orderId: state.orderId, phone });
  return state;
}

module.exports = { handleIncomingLocation, setOrderPincode, handleLocationRefusal };
