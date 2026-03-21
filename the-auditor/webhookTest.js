const axios = require('axios');

// YE LINE SABSE ZAROORI HAI: module.exports
module.exports = {
    run: async () => {
        try {
            const res = await axios.post(process.env.MAIN_BOT_WEBHOOK_URL, { type: "text", text: "Hi" });
            return { component: "Webhook Core", passed: res.status === 200, status: "Healthy" };
        } catch (err) {
            return { component: "Webhook Core", passed: false, status: "Offline", error: err.message };
        }
    }
};
