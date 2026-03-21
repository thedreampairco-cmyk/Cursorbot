import express from "express";
import { ENV } from "./config/env.js";

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

// Start server
app.listen(ENV.PORT, () => {
  console.log(`🚀 Server running on port ${ENV.PORT}`);
});
