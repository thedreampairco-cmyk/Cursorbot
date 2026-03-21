// Example for inventoryTest.js
const axios = require('axios');

module.exports.run = async () => {
    try {
        const res = await axios.post(process.env.MAIN_BOT_WEBHOOK_URL, { type: "text", text: "Jordan 4" });
        const isPassing = JSON.stringify(res.data).includes("₹"); // Or whatever logic you want
        return { 
            component: "Inventory Service", 
            passed: isPassing, 
            status: isPassing ? "Healthy" : "Logic Error" 
        };
    } catch (err) {
        return { component: "Inventory Service", passed: false, status: "Offline", error: err.message };
    }
};
