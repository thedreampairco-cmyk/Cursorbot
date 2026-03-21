const axios = require('axios');

module.exports = {
    run: async () => {
        try {
            // Testing if the Green API / WhatsApp Bridge is responding
            const res = await axios.post(process.env.MAIN_BOT_WEBHOOK_URL, { 
                type: "text", 
                text: "Status Check" 
            });
            
            return { 
                component: "WhatsApp Bridge", 
                passed: res.status === 200, 
                status: res.status === 200 ? "Healthy" : "Bridge Error" 
            };
        } catch (err) {
            return { 
                component: "WhatsApp Bridge", 
                passed: false, 
                status: "Offline", 
                error: err.message 
            };
        }
    }
};
