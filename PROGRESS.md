# 👟 Dream Pair Bot - Master Progress Tracker

## 📊 Project Status: Entering Phase 3
**Current Stack:** Node.js, Groq API, MongoDB, Google Sheets, Green API

---

### Phase 1: The Communicator (Foundation) - [In Progress]
- [x] **WhatsApp Messaging Automation:** Green API + Node.js core plumbing.
- [x] **Conversational AI:** Groq LLM Integration for lightning-fast processing.
- [x] **Session Context & Memory:** MongoDB wired up for short-term conversation memory.
- [ ] **Sneakerhead Persona Injection:** System instructions for natural, hyped vibe.
- [ ] **Natural Language Processing:** Intent extraction (size, color, models).
- [ ] **Error Handling & Fallbacks:** Graceful recovery loops for confused states.
- [ ] **Voice-to-Text Processing:** Whisper AI for voice notes.

### Phase 2: The Visuals & Inventory - [In Progress]
- [x] **Read-Only Google Sheet Integration:** Fetching catalog, sizes, and stock.
- [ ] **Automated Image Rendering:** Pushing high-res image URLs as WhatsApp media.
- [ ] **Image Recognition:** Instagram screenshot processing.
- [ ] **Two-Way Inventory Sync:** Auto-subtracting stock upon order confirmation.
- [ ] **Real-time Webhook Updates:** Instant sheet-to-bot sync without restarts.
- [ ] **WhatsApp Catalog API Integration:** Pushing to the official WA Business Catalog.

### Phase 3: The Closer & Anti-RTO Shield - [Pending]
- [ ] **Native Payment Gateway:** Razorpay/UPI instant checkout links.
- [ ] **The "Skin in the Game" Filter:** ₹500 token advance via UPI for COD.
- [ ] **Location Ping Verification:** Forcing Live Location for COD drops.
- [ ] **The Unboxing Video Contract:** Automated pre-delivery policy warning.
- [ ] **API-Level Open Box Delivery:** Integration with shipping API.

### Phase 4: Zero-Touch Logistics - [Pending]
- [ ] **Shiprocket / NimbusPost API Integration:** Pan-India delivery handler.
- [ ] **Silent Label Generation:** Auto-pushing customer details to shipping API.
- [ ] **Automated PDF Label Drop:** Sending label to admin WhatsApp.
- [ ] **Live Order Tracking Loop:** Auto-texting AWB tracking links.

### Phase 5: The Hunter & Retargeter - [Pending]
- [ ] **Instagram DM Hijack:** Intercepting comments to WA DMs.
- [ ] **Abandoned Cart Recovery:** 45-minute trigger for unpaid carts.
- [ ] **Dead-Lead Resurrection:** Restock blasts to past buyers.
- [ ] **The Sneaker Bounty Viral Loop:** Referral links and store credit tracking.
- [ ] **Lead Scoring & Smart Segmentation:** Tagging VIPs and Window Shoppers.

### Phase 6: Human Control & Analytics - [Pending]
- [ ] **Smart Escalation (HITL Handoff):** Bot-to-Human transfer for high-ticket/frustrated users.
- [ ] **WhatsApp Admin Chat:** Managing the bot via owner's WhatsApp.
- [ ] **Shared Team Inbox:** Backend live-view of conversations.
- [ ] **Click-to-WhatsApp Ad Attribution:** Tracking Meta ad sources.
- [ ] **Analytics Dashboard:** Visual breakdown of sales and conversion rates.

---
*Note: Run `node scripts/update-tracker.js` locally to auto-append new functions here.*


## 🛠️ Auto-Detected Codebase Functions
- `notifyAdmin` *(found in admin/notifier.js)*
- `getAIResponse` *(found in aiService.js)*
- `createCheckout` *(found in controllers/checkoutController.js)*
- `initiateCodTokenFlow` *(found in controllers/orderController.js)*
- `getOrderById` *(found in controllers/orderController.js)*
- `getOpenOrderForUser` *(found in controllers/orderController.js)*
- `handleRazorpayWebhook` *(found in controllers/webhookController.js)*
- `extractIdsFromPayload` *(found in controllers/webhookController.js)*
- `errorMiddleware` *(found in errorHandler.js)*
- `asyncHandler` *(found in errorHandler.js)*
- `onCODSelected` *(found in fraud/index.js)*
- `onDepositWebhook` *(found in fraud/index.js)*
- `onIncomingWhatsAppMessage` *(found in fraud/index.js)*
- `onShiprocketWebhook` *(found in fraud/index.js)*
- `adminWaiveDeposit` *(found in fraud/index.js)*
- `adminGetFraudState` *(found in fraud/index.js)*
- `retryPendingDeposits` *(found in fraud/index.js)*
- `interceptCOD` *(found in fraud/shields/codInterceptor.js)*
- `sendDepositPrompt` *(found in fraud/shields/codInterceptor.js)*
- `handleDepositPaid` *(found in fraud/shields/codInterceptor.js)*
- `requestLiveLocation` *(found in fraud/shields/codInterceptor.js)*
- `waiveDeposit` *(found in fraud/shields/codInterceptor.js)*
- `retryDepositPrompt` *(found in fraud/shields/codInterceptor.js)*
- `handleIncomingLocation` *(found in fraud/shields/locationVerifier.js)*
- `reversGeocodePincode` *(found in fraud/shields/locationVerifier.js)*
- `reverseGeocodeGoogle` *(found in fraud/shields/locationVerifier.js)*
- `reverseGeocodeNominatim` *(found in fraud/shields/locationVerifier.js)*
- `sendClearedMessage` *(found in fraud/shields/locationVerifier.js)*
- `sendPincodeMismatchMessage` *(found in fraud/shields/locationVerifier.js)*
- `setOrderPincode` *(found in fraud/shields/locationVerifier.js)*
- `handleLocationRefusal` *(found in fraud/shields/locationVerifier.js)*
- `handleOutForDelivery` *(found in fraud/shields/unboxingContract.js)*
- `sendUnboxingContract` *(found in fraud/shields/unboxingContract.js)*
- `receiveUnboxingVideo` *(found in fraud/shields/unboxingContract.js)*
- `parseShiprocketWebhook` *(found in fraud/shields/unboxingContract.js)*
- `onCODSelected` *(found in index.js)*
- `onDepositWebhook` *(found in index.js)*
- `onIncomingWhatsAppMessage` *(found in index.js)*
- `onShiprocketWebhook` *(found in index.js)*
- `adminWaiveDeposit` *(found in index.js)*
- `adminGetFraudState` *(found in index.js)*
- `retryPendingDeposits` *(found in index.js)*
- `createDepositLink` *(found in integrations/razorpay/depositHandler.js)*
- `verifyWebhookSignature` *(found in integrations/razorpay/depositHandler.js)*
- `parseDepositWebhook` *(found in integrations/razorpay/depositHandler.js)*
- `sendWhatsAppMessage` *(found in integrations/whatsapp/sender.js)*
- `sendWhatsAppTemplate` *(found in integrations/whatsapp/sender.js)*
- `runExpiryCheck` *(found in jobs/tokenExpiryJob.js)*
- `verifyRazorpayWebhook` *(found in middleware/webhookVerify.js)*
- `requireAdmin` *(found in routes/catalogSync.js)*
- `startCatalogCron` *(found in routes/catalogSync.js)*
- `requireAdmin` *(found in routes/masterAdmin.js)*
- `runAbandonedCartFollowUp` *(found in routes/masterAdmin.js)*
- `startMarketingCrons` *(found in routes/masterAdmin.js)*
- `validateSecret` *(found in routes/orderNotifications.js)*
- `extractAndValidate` *(found in routes/orderNotifications.js)*
- `notifyAll` *(found in routes/orderNotifications.js)*
- `needsHandoff` *(found in routes/webhook.js)*
- `isAddToCart` *(found in routes/webhook.js)*
- `isCheckout` *(found in routes/webhook.js)*
- `isViewCart` *(found in routes/webhook.js)*
- `formatCart` *(found in routes/webhook.js)*
- `addToCart` *(found in routes/webhook.js)*
- `updatePreferences` *(found in routes/webhook.js)*
- `scoreActivity` *(found in routes/webhook.js)*
- `updateSegment` *(found in routes/webhook.js)*
- `handleCheckoutFlow` *(found in routes/webhook.js)*
- `processPayment` *(found in routes/webhooks.js)*
- `handlePostPaymentOOS` *(found in routes/webhooks.js)*
- `startServer` *(found in server.js)*
- `formatINR` *(found in services/adminAlertService.js)*
- `now` *(found in services/adminAlertService.js)*
- `postToSlack` *(found in services/adminAlertService.js)*
- `sendSms` *(found in services/adminAlertService.js)*
- `alertNewOrder` *(found in services/adminAlertService.js)*
- `alertOOS` *(found in services/adminAlertService.js)*
- `alertLowStock` *(found in services/adminAlertService.js)*
- `extractIntents` *(found in services/ai/aiIntegration.js)*
- `stripIntentTags` *(found in services/ai/aiIntegration.js)*
- `resolveProducts` *(found in services/ai/aiIntegration.js)*
- `processMessage` *(found in services/ai/aiIntegration.js)*
- `analyseImageForSneakers` *(found in services/ai/aiIntegration.js)*
- `buildSystemPrompt` *(found in services/ai/buildSystemPrompt.js)*
- `getAIResponse` *(found in services/aiResponse.js)*
- `getClientByInstance` *(found in services/databaseService.js)*
- `getHeaders` *(found in services/emailService.js)*
- `buildConfirmationHtml` *(found in services/emailService.js)*
- `buildConfirmationText` *(found in services/emailService.js)*
- `sendOrderConfirmation` *(found in services/emailService.js)*
- `sendRefundNotification` *(found in services/emailService.js)*
- `reduceStock` *(found in services/features/inventoryService.js)*
- `checkAvailability` *(found in services/features/inventoryService.js)*
- `getLowStockProducts` *(found in services/features/inventoryService.js)*
- `getOutOfStockProducts` *(found in services/features/inventoryService.js)*
- `detectMimeType` *(found in services/features/visionRecognition.js)*
- `downloadImageBuffer` *(found in services/features/visionRecognition.js)*
- `fetchImageUrlFromGreenApi` *(found in services/features/visionRecognition.js)*
- `bufferToDataUrl` *(found in services/features/visionRecognition.js)*
- `analyseWithGroqVision` *(found in services/features/visionRecognition.js)*
- `matchToCatalog` *(found in services/features/visionRecognition.js)*
- `matchSneakerFromImage` *(found in services/features/visionRecognition.js)*
- `findMatchesByDescription` *(found in services/features/visionRecognition.js)*
- `fetchSheetData` *(found in services/googleSheets.js)*
- `sendMessage` *(found in services/greenApi.js)*
- `sendMediaByUrl` *(found in services/greenApi.js)*
- `getSheetsToken` *(found in services/inventoryService.js)*
- `findSkuRow` *(found in services/inventoryService.js)*
- `syncStockToSheets` *(found in services/inventoryService.js)*
- `deductStock` *(found in services/inventoryService.js)*
- `getStock` *(found in services/inventoryService.js)*
- `reserveStock` *(found in services/inventoryService.js)*
- `releaseReservation` *(found in services/inventoryService.js)*
- `getUserProfile` *(found in services/memoryStore.js)*
- `addMessage` *(found in services/memoryStore.js)*
- `updateCustomerInfo` *(found in services/memoryStore.js)*
- `addToCart` *(found in services/memoryStore.js)*
- `saveOrderToSheet` *(found in services/orderStore.js)*
- `getRazorpay` *(found in services/paymentService.js)*
- `createTokenPaymentLink` *(found in services/paymentService.js)*
- `verifyWebhookSignature` *(found in services/paymentService.js)*
- `fetchPaymentDetails` *(found in services/paymentService.js)*
- `createPaymentLink` *(found in services/razorpayService.js)*
- `getVisionAnalysis` *(found in services/visionService.js)*
- `sendProductImage` *(found in services/whatsapp/greenApiMedia.js)*
- `sendProductImages` *(found in services/whatsapp/greenApiMedia.js)*
- `sendImageByUrl` *(found in services/whatsapp/greenApiMedia.js)*
- `sendText` *(found in services/whatsapp/greenApiText.js)*
- `sendListMessage` *(found in services/whatsapp/greenApiText.js)*
- `sendButtons` *(found in services/whatsapp/greenApiText.js)*
- `endpoint` *(found in services/whatsappService.js)*
- `sendText` *(found in services/whatsappService.js)*
- `sendImage` *(found in services/whatsappService.js)*
- `sendTokenRequestMessage` *(found in services/whatsappService.js)*
- `sendPaymentLink` *(found in services/whatsappService.js)*
- `sendTokenConfirmation` *(found in services/whatsappService.js)*
- `sendExpiryReminder` *(found in services/whatsappService.js)*
- `sendExpiredMessage` *(found in services/whatsappService.js)*
- `assert` *(found in test/smokeTest.js)*
- `assertThrows` *(found in test/smokeTest.js)*
- `makeOrder` *(found in test/smokeTest.js)*
- `mockTask` *(found in test/smokeTest.js)*
- `isValidUrl` *(found in urlHelper.js)*
- `convertDriveUrl` *(found in urlHelper.js)*
- `extractImageUrl` *(found in urlHelper.js)*
- `buildUrl` *(found in urlHelper.js)*
