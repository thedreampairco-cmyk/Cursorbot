const axios = require('axios');
const logger = require('../../utils/logger');

const WA_READY = !!process.env.WA_PHONE_NUMBER_ID && !!process.env.WA_ACCESS_TOKEN;
const WA_API_URL = WA_READY
  ? `https://graph.facebook.com/v19.0/${process.env.WA_PHONE_NUMBER_ID}/messages`
  : null;

/**
 * Sends a plain text WhatsApp message via the Meta Cloud API.
 *
 * @param {string} to   - recipient phone in E.164 format (e.g. +919876543210)
 * @param {string} text - message body (supports *bold* and _italic_ WA markdown)
 */
async function sendWhatsAppMessage({ to, text }) {
  if (!WA_READY) {
    logger.info('[WA STUB] Message not sent — credentials not configured', { to, preview: text.slice(0, 60) });
    return { stubbed: true };
  }
  const phone = to.replace(/\s+/g, '').startsWith('+') ? to.replace(/\s+/g, '') : `+91${to}`;

  try {
    const { data } = await axios.post(
      WA_API_URL,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone,
        type: 'text',
        text: { body: text, preview_url: false },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 8000,
      }
    );

    logger.info('WhatsApp message sent', { to: phone, messageId: data.messages?.[0]?.id });
    return data;
  } catch (err) {
    const detail = err.response?.data || err.message;
    logger.error('Failed to send WhatsApp message', { to: phone, error: detail });
    throw err;
  }
}

/**
 * Sends a WhatsApp template message (for transactional HSM flows).
 *
 * @param {string} to           - recipient phone in E.164
 * @param {string} templateName - approved template name
 * @param {string} languageCode - e.g. 'en_US'
 * @param {Array}  components   - template header/body/button components
 */
async function sendWhatsAppTemplate({ to, templateName, languageCode = 'en_US', components = [] }) {
  if (!WA_READY) {
    logger.info('[WA STUB] Template not sent — credentials not configured', { to, templateName });
    return { stubbed: true };
  }
  const phone = to.replace(/\s+/g, '').startsWith('+') ? to.replace(/\s+/g, '') : `+91${to}`;

  try {
    const { data } = await axios.post(
      WA_API_URL,
      {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'template',
        template: { name: templateName, language: { code: languageCode }, components },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 8000,
      }
    );

    logger.info('WhatsApp template sent', { to: phone, templateName, messageId: data.messages?.[0]?.id });
    return data;
  } catch (err) {
    logger.error('Failed to send WhatsApp template', { to: phone, templateName, error: err.message });
    throw err;
  }
}

module.exports = { sendWhatsAppMessage, sendWhatsAppTemplate };
