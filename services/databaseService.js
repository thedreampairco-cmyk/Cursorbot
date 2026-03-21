const Client = require("../models/Client");

/**
 * Finds a client's configuration based on their Green API Instance ID.
 * This is the "Server Trick" that makes the Master Bot multi-tenant.
 */
async function getClientByInstance(idInstance) {
  try {
    // We look for the client in MongoDB where the instance ID matches
    const client = await Client.findOne({ idInstance: idInstance, status: "active" });
    
    if (!client) {
      console.log(`🔍 Lookup: No active client found for Instance ${idInstance}`);
      return null;
    }
    
    return client;
  } catch (error) {
    console.error("❌ Database Lookup Error:", error);
    return null;
  }
}

module.exports = { getClientByInstance };
