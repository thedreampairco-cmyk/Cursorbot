const { sendWhatsAppMessage } = require('../integrations/whatsapp/sender');
const logger = require('../utils/logger');

const ADMIN_PHONE = process.env.ADMIN_WA_PHONE; // e.g. +919876543210

/**
 * Sends an alert message to the store owner's WhatsApp.
 *
 * @param {string} message    - alert text (supports WA markdown)
 * @param {string} adminPhone - override recipient (defaults to ADMIN_WA_PHONE env var)
 */
async function notifyAdmin({ message, adminPhone }) {
  const recipient = adminPhone || ADMIN_PHONE;

  if (!recipient) {
    logger.error('notifyAdmin called but ADMIN_WA_PHONE is not set');
    return;
  }

  try {
    await sendWhatsAppMessage({ to: recipient, text: message });
    logger.info('Admin notified', { recipient, preview: message.slice(0, 60) });
  } catch (err) {
    logger.error('Failed to notify admin', { recipient, error: err.message });
  }
}

module.exports = { notifyAdmin };
