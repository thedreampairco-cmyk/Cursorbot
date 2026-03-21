const mongoose = require("mongoose");

const ClientSchema = new mongoose.Schema({
  businessName: { type: String, required: true },
  idInstance: { type: String, required: true, unique: true }, // 7103529867
  apiTokenInstance: { type: String, required: true },
  sheetId: { type: String }, // For Google Sheets Inventory
  status: { type: String, default: "active" }, // Must be "active"
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Client", ClientSchema);
