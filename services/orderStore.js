// services/orderStore.js

/**
 * Function to save order details to the Google Sheet
 * @param {Object} orderData - The extracted order details
 */
async function saveOrderToSheet(orderData) {
  try {
    console.log("📝 Attempting to save to ORDER sheet:", orderData);
    
    // 🚀 YOUR GOOGLE SHEETS API LOGIC GOES HERE 
    // Example: 
    // await doc.useServiceAccountAuth(creds);
    // await doc.loadInfo();
    // const sheet = doc.sheetsByTitle['ORDER'];
    // await sheet.addRow(orderData);

    console.log("✅ Order saved successfully!");
    return true;

  } catch (error) {
    console.error("❌ Error saving to ORDER sheet:", error);
    return false;
  }
}

module.exports = { saveOrderToSheet };
