// urlHelper.js
"use strict";

const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
const BASE_URL     = (process.env.BASE_URL     || "").replace(/\/$/, "");

/**
 * Build an absolute URL under APP_BASE_URL.
 * @param {string} path  - e.g. "/api/payment/callback"
 * @param {Record<string,string|number>} [params] - optional query params
 * @returns {string}
 */
function buildAppUrl(path, params = {}) {
  if (!APP_BASE_URL) throw new Error("APP_BASE_URL is not set in environment.");
  const url = new URL(`${APP_BASE_URL}${path.startsWith("/") ? path : "/" + path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  return url.toString();
}

/**
 * Build an absolute URL under BASE_URL (public-facing / CDN base).
 * @param {string} path
 * @param {Record<string,string|number>} [params]
 * @returns {string}
 */
function buildBaseUrl(path, params = {}) {
  if (!BASE_URL) throw new Error("BASE_URL is not set in environment.");
  const url = new URL(`${BASE_URL}${path.startsWith("/") ? path : "/" + path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  return url.toString();
}

/**
 * Build a Razorpay payment callback URL for a given order token.
 * @param {string} token
 * @returns {string}
 */
function buildPaymentCallbackUrl(token) {
  return buildAppUrl("/api/payment/callback", { token });
}

/**
 * Build a Razorpay webhook endpoint URL.
 * @returns {string}
 */
function buildRazorpayWebhookUrl() {
  return buildAppUrl("/api/webhooks/razorpay");
}

/**
 * Build an order webhook URL (for internal/admin events).
 * @returns {string}
 */
function buildOrderWebhookUrl() {
  return buildAppUrl("/api/webhooks/order");
}

/**
 * Build an unboxing video upload URL for a given order ID.
 * @param {string} orderId
 * @returns {string}
 */
function buildUnboxingUploadUrl(orderId) {
  return buildAppUrl("/api/unboxing/upload", { orderId });
}

/**
 * Safely join two URL segments, avoiding double slashes.
 * @param {string} base
 * @param {string} segment
 * @returns {string}
 */
function joinUrl(base, segment) {
  return `${base.replace(/\/$/, "")}/${segment.replace(/^\//, "")}`;
}

module.exports = {
  buildAppUrl,
  buildBaseUrl,
  buildPaymentCallbackUrl,
  buildRazorpayWebhookUrl,
  buildOrderWebhookUrl,
  buildUnboxingUploadUrl,
  joinUrl,
};
