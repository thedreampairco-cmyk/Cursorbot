// services/memoryStore.js
"use strict";

const cron   = require("node-cron");
const { logger } = require("../errorHandler");

// ─── Constants ─────────────────────────────────────────────────────────────────
const SESSION_TTL_MS    = 30 * 60 * 1000;   // 30 minutes of inactivity
const CART_TTL_MS       = 60 * 60 * 1000;   // 1 hour
const LOCK_TTL_MS       =  2 * 60 * 1000;   // 2-minute processing lock
const CLEANUP_CRON      = "*/10 * * * *";   // every 10 minutes

// ─── Stores ────────────────────────────────────────────────────────────────────
/** @type {Map<string, { data: object, expiresAt: number }>} */
const sessionStore = new Map();

/** @type {Map<string, { items: object[], metadata: object, expiresAt: number }>} */
const cartStore = new Map();

/** @type {Map<string, { step: string, payload: object, updatedAt: number }>} */
const conversationStore = new Map();

/** @type {Map<string, { lockedAt: number, reason: string }>} */
const lockStore = new Map();

/** @type {Map<string, { prefs: object, updatedAt: number }>} */
const userPrefsStore = new Map();

// ─── Helpers ───────────────────────────────────────────────────────────────────
function now() {
  return Date.now();
}

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the full session object for a phone number.
 * Returns null if not found or expired.
 * @param {string} phone
 * @returns {object|null}
 */
function getSession(phone) {
  const entry = sessionStore.get(phone);
  if (!entry) return null;
  if (entry.expiresAt < now()) {
    sessionStore.delete(phone);
    return null;
  }
  // Sliding window — refresh TTL on access
  entry.expiresAt = now() + SESSION_TTL_MS;
  return entry.data;
}

/**
 * Set or overwrite a session for a phone number.
 * @param {string} phone
 * @param {object} data
 */
function setSession(phone, data) {
  sessionStore.set(phone, {
    data: { ...data },
    expiresAt: now() + SESSION_TTL_MS,
  });
}

/**
 * Merge partial data into an existing session (or create a new one).
 * @param {string} phone
 * @param {object} partial
 */
function updateSession(phone, partial) {
  const existing = getSession(phone) || {};
  setSession(phone, { ...existing, ...partial });
}

/**
 * Delete a session immediately.
 * @param {string} phone
 */
function clearSession(phone) {
  sessionStore.delete(phone);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CART
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the cart for a phone number.
 * Returns null if missing or expired.
 * @param {string} phone
 * @returns {{ items: object[], metadata: object }|null}
 */
function getCart(phone) {
  const entry = cartStore.get(phone);
  if (!entry) return null;
  if (entry.expiresAt < now()) {
    cartStore.delete(phone);
    return null;
  }
  entry.expiresAt = now() + CART_TTL_MS;
  return { items: entry.items, metadata: entry.metadata };
}

/**
 * Replace the entire cart for a phone number.
 * @param {string} phone
 * @param {object[]} items
 * @param {object}  [metadata]
 */
function setCart(phone, items, metadata = {}) {
  cartStore.set(phone, {
    items: [...items],
    metadata: { ...metadata },
    expiresAt: now() + CART_TTL_MS,
  });
}

/**
 * Add a single item to the cart (upserts by sku + size).
 * @param {string} phone
 * @param {{ sku: string, size: string, qty: number, price: number, name: string }} item
 */
function addToCart(phone, item) {
  const cart = getCart(phone) || { items: [], metadata: {} };
  const idx  = cart.items.findIndex(
    (i) => i.sku === item.sku && i.size === item.size
  );
  if (idx >= 0) {
    cart.items[idx].qty += item.qty ?? 1;
  } else {
    cart.items.push({ ...item, qty: item.qty ?? 1 });
  }
  setCart(phone, cart.items, cart.metadata);
}

/**
 * Remove an item from the cart by sku + size.
 * @param {string} phone
 * @param {string} sku
 * @param {string} size
 */
function removeFromCart(phone, sku, size) {
  const cart = getCart(phone);
  if (!cart) return;
  cart.items = cart.items.filter((i) => !(i.sku === sku && i.size === size));
  setCart(phone, cart.items, cart.metadata);
}

/**
 * Calculate the cart total.
 * @param {string} phone
 * @returns {number}
 */
function getCartTotal(phone) {
  const cart = getCart(phone);
  if (!cart || cart.items.length === 0) return 0;
  return cart.items.reduce((sum, i) => sum + i.price * (i.qty ?? 1), 0);
}

/**
 * Format cart as a human-readable WhatsApp message string.
 * @param {string} phone
 * @returns {string}
 */
function formatCartMessage(phone) {
  const cart = getCart(phone);
  if (!cart || cart.items.length === 0) return "🛒 Your cart is empty.";

  const lines = cart.items.map(
    (i, idx) =>
      `${idx + 1}. *${i.name}* | Size: ${i.size} | Qty: ${i.qty} | ₹${(
        i.price * i.qty
      ).toLocaleString("en-IN")}`
  );

  const total = getCartTotal(phone);
  lines.push(`\n💰 *Total: ₹${total.toLocaleString("en-IN")}*`);
  return lines.join("\n");
}

/**
 * Clear the cart for a phone number.
 * @param {string} phone
 */
function clearCart(phone) {
  cartStore.delete(phone);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONVERSATION STATE (wizard / multi-step flows)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {'idle'|'browsing'|'size_selection'|'address_input'|
 *           'payment_pending'|'cod_deposit_pending'|'awaiting_location'|
 *           'awaiting_unboxing'|'human_handoff'} ConversationStep
 */

/**
 * Get the current conversation step and payload for a phone.
 * @param {string} phone
 * @returns {{ step: ConversationStep, payload: object }|null}
 */
function getConversationState(phone) {
  const entry = conversationStore.get(phone);
  if (!entry) return null;
  return { step: entry.step, payload: entry.payload };
}

/**
 * Set the conversation step and optional payload.
 * @param {string} phone
 * @param {ConversationStep} step
 * @param {object} [payload]
 */
function setConversationState(phone, step, payload = {}) {
  conversationStore.set(phone, {
    step,
    payload: { ...payload },
    updatedAt: now(),
  });
}

/**
 * Merge additional payload into the current conversation state.
 * @param {string} phone
 * @param {object} partial
 */
function updateConversationPayload(phone, partial) {
  const existing = getConversationState(phone) || { step: "idle", payload: {} };
  setConversationState(phone, existing.step, {
    ...existing.payload,
    ...partial,
  });
}

/**
 * Reset conversation back to idle state.
 * @param {string} phone
 */
function resetConversation(phone) {
  setConversationState(phone, "idle", {});
}

// ═══════════════════════════════════════════════════════════════════════════════
// USER PREFERENCES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get stored preferences for a user.
 * @param {string} phone
 * @returns {object}
 */
function getUserPrefs(phone) {
  return userPrefsStore.get(phone)?.prefs ?? {};
}

/**
 * Merge partial preferences into a user's preference record.
 * @param {string} phone
 * @param {object} partial  - e.g. { language: 'hi', preferredSize: '10' }
 */
function setUserPrefs(phone, partial) {
  const existing = getUserPrefs(phone);
  userPrefsStore.set(phone, {
    prefs: { ...existing, ...partial },
    updatedAt: now(),
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROCESSING LOCKS (prevent duplicate webhook / message races)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Acquire a named lock.
 * @param {string} key    - e.g. "payment:<orderId>" or "msg:<phone>"
 * @param {string} reason
 * @returns {boolean}  true if lock acquired, false if already locked
 */
function acquireLock(key, reason = "processing") {
  const existing = lockStore.get(key);
  if (existing && existing.lockedAt + LOCK_TTL_MS > now()) {
    return false; // still locked
  }
  lockStore.set(key, { lockedAt: now(), reason });
  return true;
}

/**
 * Release a named lock.
 * @param {string} key
 */
function releaseLock(key) {
  lockStore.delete(key);
}

/**
 * Check whether a lock is currently held (without acquiring).
 * @param {string} key
 * @returns {boolean}
 */
function isLocked(key) {
  const existing = lockStore.get(key);
  if (!existing) return false;
  if (existing.lockedAt + LOCK_TTL_MS <= now()) {
    lockStore.delete(key);
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIAGNOSTICS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Return a snapshot of current store sizes — useful for health endpoints.
 * @returns {{ sessions: number, carts: number, conversations: number, locks: number, userPrefs: number }}
 */
function getStoreSizes() {
  return {
    sessions:      sessionStore.size,
    carts:         cartStore.size,
    conversations: conversationStore.size,
    locks:         lockStore.size,
    userPrefs:     userPrefsStore.size,
  };
}

/**
 * Wipe all in-memory data (test / admin use only).
 */
function flushAll() {
  sessionStore.clear();
  cartStore.clear();
  conversationStore.clear();
  lockStore.clear();
  userPrefsStore.clear();
  logger.warn("memoryStore: all stores flushed.");
}

// ═══════════════════════════════════════════════════════════════════════════════
// GARBAGE COLLECTION
// ═══════════════════════════════════════════════════════════════════════════════

function _runGarbageCollection() {
  const t = now();
  let removed = 0;

  for (const [k, v] of sessionStore) {
    if (v.expiresAt < t) { sessionStore.delete(k); removed++; }
  }
  for (const [k, v] of cartStore) {
    if (v.expiresAt < t) { cartStore.delete(k); removed++; }
  }
  for (const [k, v] of lockStore) {
    if (v.lockedAt + LOCK_TTL_MS < t) { lockStore.delete(k); removed++; }
  }
  // Conversations older than 2 hours with no update are pruned
  const CONV_TTL = 2 * 60 * 60 * 1000;
  for (const [k, v] of conversationStore) {
    if (v.updatedAt + CONV_TTL < t) { conversationStore.delete(k); removed++; }
  }

  if (removed > 0) {
    logger.info(`memoryStore GC: removed ${removed} expired entries.`);
  }
}

// Register the cron job once on module load
cron.schedule(CLEANUP_CRON, _runGarbageCollection);
logger.info(`memoryStore: GC scheduled at "${CLEANUP_CRON}".`);

// ─── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  // Session
  getSession,
  setSession,
  updateSession,
  clearSession,

  // Cart
  getCart,
  setCart,
  addToCart,
  removeFromCart,
  getCartTotal,
  formatCartMessage,
  clearCart,

  // Conversation state
  getConversationState,
  setConversationState,
  updateConversationPayload,
  resetConversation,

  // User preferences
  getUserPrefs,
  setUserPrefs,

  // Locks
  acquireLock,
  releaseLock,
  isLocked,

  // Diagnostics
  getStoreSizes,
  flushAll,
};
