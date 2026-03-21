import express from "express";
import { ENV } from "./config/env.js";
import webhookRoute from "./routes/webhook.js";

const app = express();

// Middleware
app.use(express.json());

// Health check route
app.get("/", (req, res) => {
  res.status(200).json({
    status: "OK",
    message: "Maya AI Server is running 🚀",
  });
});

// Webhook route
app.use("/webhook", webhookRoute);

// Start server
app.listen(ENV.PORT, () => {
  console.log(`🚀 Server running on port ${ENV.PORT}`);
});
