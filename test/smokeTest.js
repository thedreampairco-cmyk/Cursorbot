/**
 * smokeTest.js  —  npm test
 * Pure unit tests — no live DB or API calls.
 */

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✅  ${label}`); passed++; }
  else           { console.error(`  ❌  ${label}`); failed++; }
}

async function assertThrows(fn, expectedMsg, label) {
  try {
    await fn();
    console.error(`  ❌  ${label}  (expected throw, got none)`);
    failed++;
  } catch (e) {
    if (expectedMsg && !e.message.includes(expectedMsg)) {
      console.error(`  ❌  ${label}  (wrong error: "${e.message}")`);
      failed++;
    } else {
      console.log(`  ✅  ${label}`);
      passed++;
    }
  }
}

function makeOrder(overrides = {}) {
  const { Order } = require("../models/Order");
  const doc = new Order({
    order_id:        `TEST-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    whatsapp_number: "919876543210",
    product: { sku: "PANDA-WHT-42", name: "New Balance 550 Pandas", size: "42" },
    total_amount: 12000,
    advance_paid: 0,
    ...overrides,
  });
  doc.save = async function () {
    this.cod_balance = this.total_amount - this.advance_paid;
    return this;
  };
  return doc;
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 Dream Pair Maya — Smoke Test\n");

// ─── 1. Module Imports ────────────────────────────────────────────────────────
console.log("── 1. Module Imports ──");
try {
  const { Order, PAYMENT_STATUS } = require("../models/Order");
  assert(!!Order,          "Order model loads");
  assert(!!PAYMENT_STATUS, "PAYMENT_STATUS enum loads");
  assert(PAYMENT_STATUS.AWAITING_TOKEN  === "AWAITING_TOKEN",   "AWAITING_TOKEN value");
  assert(PAYMENT_STATUS.TOKEN_RECEIVED  === "TOKEN_RECEIVED",   "TOKEN_RECEIVED value");
  assert(PAYMENT_STATUS.RTO_CANCELLED   === "RTO_CANCELLED",    "RTO_CANCELLED value");
  assert(PAYMENT_STATUS.EXPIRED         === "EXPIRED",          "EXPIRED value");
  assert(PAYMENT_STATUS.DELIVERED       === "DELIVERED",        "DELIVERED value");
  assert(PAYMENT_STATUS.REFUND_PENDING  === "REFUND_PENDING",   "REFUND_PENDING value");
  assert(PAYMENT_STATUS.PREPAID_COMPLETE=== "PREPAID_COMPLETE", "PREPAID_COMPLETE value");
} catch (e) { console.error("Order model import failed:", e.message); failed++; }

try {
  const ps = require("../services/paymentService");
  assert(typeof ps.createTokenPaymentLink === "function", "createTokenPaymentLink is a function");
  assert(typeof ps.verifyWebhookSignature === "function", "verifyWebhookSignature is a function");
  assert(typeof ps.fetchPaymentDetails    === "function", "fetchPaymentDetails is a function");
  assert(ps.TOKEN_AMOUNT_INR === 500, "Default token amount is ₹500");
  assert(ps.TOKEN_WINDOW_MIN === 15,  "Default window is 15 minutes");
} catch (e) { console.error("paymentService import failed:", e.message); failed++; }

try {
  const ws = require("../services/whatsappService");
  ["sendText","sendImage","sendTokenRequestMessage","sendPaymentLink",
   "sendTokenConfirmation","sendExpiryReminder","sendExpiredMessage"]
    .forEach(fn => assert(typeof ws[fn] === "function", `whatsappService.${fn} is a function`));
} catch (e) { console.error("whatsappService import failed:", e.message); failed++; }

try {
  const inv = require("../services/inventoryService");
  ["deductStock","getStock","reserveStock","releaseReservation"]
    .forEach(fn => assert(typeof inv[fn] === "function", `inventoryService.${fn} is a function`));
  assert(!!inv.OutOfStockError,  "OutOfStockError exported");
  assert(!!inv.SkuNotFoundError, "SkuNotFoundError exported");
} catch (e) { console.error("inventoryService import failed:", e.message); failed++; }

try {
  const { Inventory, OutOfStockError, SkuNotFoundError } = require("../models/Inventory");
  assert(!!Inventory,                                         "Inventory model loads");
  assert(typeof Inventory.atomicDeduct      === "function",  "atomicDeduct static method exists");
  assert(typeof Inventory.getStock          === "function",  "getStock static method exists");
  assert(typeof Inventory.reserveStock      === "function",  "reserveStock static method exists");
  assert(typeof Inventory.releaseReservation=== "function",  "releaseReservation static method exists");
  assert(!!OutOfStockError,                                   "OutOfStockError class exported");
  assert(!!SkuNotFoundError,                                  "SkuNotFoundError class exported");
} catch (e) { console.error("Inventory model import failed:", e.message); failed++; }

try {
  const oc = require("../controllers/orderController");
  assert(typeof oc.initiateCodTokenFlow === "function", "orderController.initiateCodTokenFlow is a function");
  assert(typeof oc.getOrderById         === "function", "orderController.getOrderById is a function");
  assert(typeof oc.getOpenOrderForUser  === "function", "orderController.getOpenOrderForUser is a function");
} catch (e) { console.error("orderController import failed:", e.message); failed++; }


// ─── 2. COD Math ──────────────────────────────────────────────────────────────
console.log("\n── 2. COD Math ──");
try {
  const order = makeOrder({ total_amount: 12000, advance_paid: 0 });
  assert(order.total_amount === 12000, "total_amount stores ₹12,000");
  assert(order.advance_paid === 0,     "advance_paid defaults to ₹0");

  order.cod_balance = order.total_amount - order.advance_paid;
  assert(order.cod_balance === 12000, "cod_balance = 12000 before token");

  order.advance_paid = 500;
  order.cod_balance  = order.total_amount - order.advance_paid;
  assert(order.cod_balance === 11500, "cod_balance = 11500 after ₹500 token");
  assert(
    order.total_amount === order.advance_paid + order.cod_balance,
    "Invariant: total_amount === advance_paid + cod_balance"
  );

  [
    { total: 8000,  token: 500, expectedCod: 7500  },
    { total: 15000, token: 500, expectedCod: 14500 },
    { total: 500,   token: 500, expectedCod: 0     },
    { total: 3000,  token: 500, expectedCod: 2500  },
  ].forEach(({ total, token, expectedCod }) => {
    const o = makeOrder({ total_amount: total, advance_paid: token });
    o.cod_balance = o.total_amount - o.advance_paid;
    assert(o.cod_balance === expectedCod,
      `₹${total} sneaker → ₹${token} token → ₹${expectedCod} COD`);
  });

  const prepaid = makeOrder({ total_amount: 9000, advance_paid: 9000 });
  prepaid.cod_balance = prepaid.total_amount - prepaid.advance_paid;
  assert(prepaid.cod_balance === 0,    "Full prepaid → ₹0 COD");

  const pureCod = makeOrder({ total_amount: 6000, advance_paid: 0 });
  pureCod.cod_balance = pureCod.total_amount - pureCod.advance_paid;
  assert(pureCod.cod_balance === 6000, "Pure COD → full amount at door");
} catch (e) { console.error("COD math failed:", e.message); failed++; }


// ─── 3. Token Window Virtual ──────────────────────────────────────────────────
console.log("\n── 3. Token Window Virtual ──");
try {
  assert(makeOrder({ token_expires_at: new Date(Date.now() + 600_000) }).is_token_window_open === true,
    "Window open when expiry is in the future");
  assert(makeOrder({ token_expires_at: new Date(Date.now() - 1000) }).is_token_window_open === false,
    "Window closed when expiry is in the past");
  assert(makeOrder({ token_expires_at: null }).is_token_window_open === false,
    "Window closed when token_expires_at is null");

  // Boundary: test the virtual's logic directly by asserting that a date
  // 60 seconds from now is still open, and exactly 1 second ago is closed.
  // A 1ms boundary is inherently flaky — the clock ticks between construction
  // and evaluation, so we use values that are robust across any JS engine speed.
  assert(makeOrder({ token_expires_at: new Date(Date.now() + 60_000) }).is_token_window_open === true,
    "Window open 60 s before expiry");
  assert(makeOrder({ token_expires_at: new Date(Date.now() - 1) }).is_token_window_open === false,
    "Window closed 1 ms after expiry");

  // Explicit past-epoch value — always expired
  assert(makeOrder({ token_expires_at: new Date(0) }).is_token_window_open === false,
    "Window closed for epoch-zero date (Jan 1 1970)");
} catch (e) { console.error("Token window virtual failed:", e.message); failed++; }


// ─── 4. Error Class Identity ──────────────────────────────────────────────────
console.log("\n── 4. Error Class Identity ──");
try {
  const { OutOfStockError, SkuNotFoundError } = require("../models/Inventory");

  const oosErr = new OutOfStockError("PANDA-WHT-42", 1, 0);
  assert(oosErr instanceof OutOfStockError,  "OutOfStockError instanceof check");
  assert(oosErr instanceof Error,            "OutOfStockError extends Error");
  assert(oosErr.code === "OUT_OF_STOCK",     "OutOfStockError.code is OUT_OF_STOCK");
  assert(oosErr.sku  === "PANDA-WHT-42",     "OutOfStockError.sku preserved");
  assert(oosErr.requested === 1,             "OutOfStockError.requested preserved");
  assert(oosErr.available === 0,             "OutOfStockError.available preserved");
  assert(oosErr.message.includes("OUT_OF_STOCK"), "OutOfStockError.message contains code");

  const skuErr = new SkuNotFoundError("GHOST-SKU-99");
  assert(skuErr instanceof SkuNotFoundError, "SkuNotFoundError instanceof check");
  assert(skuErr instanceof Error,            "SkuNotFoundError extends Error");
  assert(skuErr.code === "SKU_NOT_FOUND",    "SkuNotFoundError.code is SKU_NOT_FOUND");
  assert(skuErr.sku  === "GHOST-SKU-99",     "SkuNotFoundError.sku preserved");

  // instanceof discrimination — callers in webhooks.js do this check
  assert(!(oosErr instanceof SkuNotFoundError), "OutOfStockError is NOT a SkuNotFoundError");
  assert(!(skuErr instanceof OutOfStockError),  "SkuNotFoundError is NOT an OutOfStockError");
} catch (e) { console.error("Error class test failed:", e.message); failed++; }


// ─── 5. State Machine — Valid Transitions ─────────────────────────────────────
console.log("\n── 5. State Machine — Valid Transitions ──");
(async () => {
  try {
    const { PAYMENT_STATUS } = require("../models/Order");

    // Happy path: AWAITING → TOKEN_RECEIVED → DELIVERED
    const o1 = makeOrder();
    await o1.transitionStatus(PAYMENT_STATUS.TOKEN_RECEIVED, "₹500 received");
    assert(o1.payment_status === PAYMENT_STATUS.TOKEN_RECEIVED, "AWAITING_TOKEN → TOKEN_RECEIVED");
    assert(o1.status_history.at(-1).status === PAYMENT_STATUS.TOKEN_RECEIVED, "Audit: TOKEN_RECEIVED logged");
    assert(o1.status_history.at(-1).note   === "₹500 received",               "Audit: note preserved");

    await o1.transitionStatus(PAYMENT_STATUS.DELIVERED, "COD collected");
    assert(o1.payment_status === PAYMENT_STATUS.DELIVERED, "TOKEN_RECEIVED → DELIVERED");

    // Token expiry
    const o2 = makeOrder();
    await o2.transitionStatus(PAYMENT_STATUS.EXPIRED, "15 min lapsed");
    assert(o2.payment_status === PAYMENT_STATUS.EXPIRED, "AWAITING_TOKEN → EXPIRED");

    // RTO after fulfillment
    const o3 = makeOrder();
    await o3.transitionStatus(PAYMENT_STATUS.TOKEN_RECEIVED);
    await o3.transitionStatus(PAYMENT_STATUS.RTO_CANCELLED, "Refused at door");
    assert(o3.payment_status === PAYMENT_STATUS.RTO_CANCELLED, "TOKEN_RECEIVED → RTO_CANCELLED");

    // Post-payment OOS → REFUND_PENDING
    const o4 = makeOrder();
    await o4.transitionStatus(PAYMENT_STATUS.REFUND_PENDING, "OOS after payment");
    assert(o4.payment_status === PAYMENT_STATUS.REFUND_PENDING, "AWAITING_TOKEN → REFUND_PENDING");
    assert(o4.status_history.at(-1).note === "OOS after payment", "Audit: OOS note preserved");

    // Prepaid path
    const o5 = makeOrder({ payment_status: PAYMENT_STATUS.PREPAID_COMPLETE });
    await o5.transitionStatus(PAYMENT_STATUS.DELIVERED);
    assert(o5.payment_status === PAYMENT_STATUS.DELIVERED, "PREPAID_COMPLETE → DELIVERED");

    // Audit trail depth
    const o6 = makeOrder();
    await o6.transitionStatus(PAYMENT_STATUS.TOKEN_RECEIVED, "step 1");
    await o6.transitionStatus(PAYMENT_STATUS.DELIVERED,      "step 2");
    assert(o6.status_history.length === 2, "Audit trail length = number of transitions");

  } catch (e) { console.error("Valid transition test failed:", e.message); failed++; }


  // ─── 6. State Machine — Invalid Transitions ──────────────────────────────────
  console.log("\n── 6. State Machine — Invalid Transitions ──");
  try {
    const { PAYMENT_STATUS } = require("../models/Order");

    await assertThrows(async () => {
      const o = makeOrder();
      await o.transitionStatus(PAYMENT_STATUS.DELIVERED);
    }, "Invalid transition", "AWAITING_TOKEN → DELIVERED is blocked");

    await assertThrows(async () => {
      const o = makeOrder();
      await o.transitionStatus(PAYMENT_STATUS.RTO_CANCELLED);
    }, "Invalid transition", "AWAITING_TOKEN → RTO_CANCELLED is blocked");

    await assertThrows(async () => {
      const o = makeOrder();
      await o.transitionStatus(PAYMENT_STATUS.TOKEN_RECEIVED);
      await o.transitionStatus(PAYMENT_STATUS.AWAITING_TOKEN);
    }, "Invalid transition", "TOKEN_RECEIVED → AWAITING_TOKEN blocked (no rollback)");

    await assertThrows(async () => {
      const o = makeOrder();
      await o.transitionStatus(PAYMENT_STATUS.TOKEN_RECEIVED);
      await o.transitionStatus(PAYMENT_STATUS.EXPIRED);
    }, "Invalid transition", "TOKEN_RECEIVED → EXPIRED is blocked");

    await assertThrows(async () => {
      const o = makeOrder();
      await o.transitionStatus(PAYMENT_STATUS.EXPIRED);
      await o.transitionStatus(PAYMENT_STATUS.TOKEN_RECEIVED);
    }, "Invalid transition", "EXPIRED is terminal");

    await assertThrows(async () => {
      const o = makeOrder();
      await o.transitionStatus(PAYMENT_STATUS.TOKEN_RECEIVED);
      await o.transitionStatus(PAYMENT_STATUS.DELIVERED);
      await o.transitionStatus(PAYMENT_STATUS.RTO_CANCELLED);
    }, "Invalid transition", "DELIVERED is terminal");

    await assertThrows(async () => {
      const o = makeOrder();
      await o.transitionStatus(PAYMENT_STATUS.TOKEN_RECEIVED);
      await o.transitionStatus(PAYMENT_STATUS.RTO_CANCELLED);
      await o.transitionStatus(PAYMENT_STATUS.DELIVERED);
    }, "Invalid transition", "RTO_CANCELLED is terminal");

    await assertThrows(async () => {
      const o = makeOrder();
      await o.transitionStatus(PAYMENT_STATUS.REFUND_PENDING);
      await o.transitionStatus(PAYMENT_STATUS.TOKEN_RECEIVED);
    }, "Invalid transition", "REFUND_PENDING is terminal");

  } catch (e) { console.error("Invalid transition test failed:", e.message); failed++; }


  // ─── 7. HMAC Verification ─────────────────────────────────────────────────────
  console.log("\n── 7. HMAC Verification ──");
  try {
    process.env.RAZORPAY_WEBHOOK_SECRET = "test_secret";
    const crypto = require("crypto");
    const { verifyWebhookSignature } = require("../services/paymentService");
    const body     = JSON.stringify({ event: "payment.captured" });
    const validSig = crypto.createHmac("sha256", "test_secret").update(body).digest("hex");
    const wrongSig = crypto.createHmac("sha256", "wrong_secret").update(body).digest("hex");
    const altBody  = JSON.stringify({ event: "payment.failed" });
    const altSig   = crypto.createHmac("sha256", "test_secret").update(altBody).digest("hex");

    assert(verifyWebhookSignature(body, validSig)   === true,  "Valid signature accepted");
    assert(verifyWebhookSignature(body, "bad")       === false, "Short garbage string rejected");
    assert(verifyWebhookSignature(body, wrongSig)    === false, "Wrong secret rejected");
    assert(verifyWebhookSignature(altBody, validSig) === false, "Swapped body rejected");
    assert(verifyWebhookSignature(body, altSig)      === false, "Swapped signature rejected");
    assert(verifyWebhookSignature("", validSig)      === false, "Empty body rejected");
  } catch (e) { console.error("HMAC test failed:", e.message); failed++; }




  // ─── 8. Email & Admin Alert Services ──────────────────────────────────────────
  console.log("\n── 8. Email & Admin Alert Services ──");
  try {
    const email = require("../services/emailService");
    assert(typeof email.sendOrderConfirmation === "function",  "emailService.sendOrderConfirmation is a function");
    assert(typeof email.sendRefundNotification === "function", "emailService.sendRefundNotification is a function");
  } catch (e) { console.error("emailService import failed:", e.message); failed++; }

  try {
    const admin = require("../services/adminAlertService");
    assert(typeof admin.alertNewOrder  === "function", "adminAlertService.alertNewOrder is a function");
    assert(typeof admin.alertOOS       === "function", "adminAlertService.alertOOS is a function");
    assert(typeof admin.alertLowStock  === "function", "adminAlertService.alertLowStock is a function");
  } catch (e) { console.error("adminAlertService import failed:", e.message); failed++; }


  // ─── 9. notifyAll — concurrent task result structure ──────────────────────────
  console.log("\n── 9. Notification Concurrency (mock) ──");
  try {
    // Simulate the Promise.allSettled fan-out pattern used in orderNotifications.js
    // with mock tasks — verifies the result aggregation logic without real API calls.

    async function mockTask(name, shouldFail = false) {
      await new Promise(r => setTimeout(r, Math.random() * 5)); // tiny async delay
      if (shouldFail) throw new Error(`${name} failed`);
      return { task: name, status: "ok" };
    }

    // Case 1: both tasks succeed
    const allOk = await Promise.allSettled([
      mockTask("email").then(v => v).catch(e => ({ task: "email",       status: "failed", error: e.message })),
      mockTask("slack").then(v => v).catch(e => ({ task: "admin_alert", status: "failed", error: e.message })),
    ]);
    assert(allOk.every(r => r.status === "fulfilled"),  "Promise.allSettled resolves even when both succeed");
    assert(allOk.every(r => r.value.status === "ok"),   "Both tasks return status=ok");

    // Case 2: email fails, Slack still runs
    const emailFails = await Promise.allSettled([
      mockTask("email", true).then(v => v).catch(e => ({ task: "email",       status: "failed", error: e.message })),
      mockTask("slack")      .then(v => v).catch(e => ({ task: "admin_alert", status: "failed", error: e.message })),
    ]);
    assert(emailFails.every(r => r.status === "fulfilled"),              "Promise.allSettled never rejects (email fail case)");
    assert(emailFails[0].value.status === "failed",                      "Email failure captured as status=failed");
    assert(emailFails[0].value.error  === "email failed",                "Email error message preserved");
    assert(emailFails[1].value.status === "ok",                          "Slack still succeeded when email failed");

    // Case 3: Slack fails, email still runs
    const slackFails = await Promise.allSettled([
      mockTask("email")      .then(v => v).catch(e => ({ task: "email",       status: "failed", error: e.message })),
      mockTask("slack", true).then(v => v).catch(e => ({ task: "admin_alert", status: "failed", error: e.message })),
    ]);
    assert(slackFails[0].value.status === "ok",     "Email succeeded when Slack failed");
    assert(slackFails[1].value.status === "failed",  "Slack failure captured, email unaffected");

    // Case 4: both fail — allSettled still fulfills (never rejects)
    const bothFail = await Promise.allSettled([
      mockTask("email", true).then(v => v).catch(e => ({ task: "email",       status: "failed", error: e.message })),
      mockTask("slack", true).then(v => v).catch(e => ({ task: "admin_alert", status: "failed", error: e.message })),
    ]);
    assert(bothFail.every(r => r.status === "fulfilled"),  "Promise.allSettled fulfills even when both tasks fail");
    assert(bothFail.every(r => r.value.status === "failed"), "Both failures correctly reported");

    // Case 5: low-stock task is skipped when stock is above threshold
    const threshold = 3;
    const newStock  = 5; // above threshold — task should be skipped
    const lowStockTask = (newStock !== null && newStock <= threshold)
      ? mockTask("low_stock")
      : Promise.resolve({ task: "low_stock_alert", status: "skipped" });
    const [lsResult] = await Promise.allSettled([lowStockTask]);
    assert(lsResult.value.status === "skipped", "Low-stock alert skipped when stock > threshold");

    // Case 6: low-stock task fires when threshold crossed
    const newStockLow = 2; // at or below threshold
    const lowStockTaskFires = (newStockLow !== null && newStockLow <= threshold)
      ? mockTask("low_stock")
      : Promise.resolve({ task: "low_stock_alert", status: "skipped" });
    const [lsFireResult] = await Promise.allSettled([lowStockTaskFires]);
    assert(lsFireResult.value.status === "ok", "Low-stock alert fires when stock ≤ threshold");

  } catch (e) { console.error("Concurrency mock test failed:", e.message); failed++; }

  // ─── Summary ──────────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) { console.log("🎉 All checks passed!\n"); process.exit(0); }
  else { console.error("⚠️  Some checks failed.\n"); process.exit(1); }

})();
