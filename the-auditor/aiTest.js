const axios = require('axios');

module.exports = {
    run: async () => {
        try {
            const res = await axios.post(process.env.MAIN_BOT_WEBHOOK_URL, { 
                type: "text", 
                text: "Who are you?" 
            });
            
            // Check if AI responds with your brand name
            const isPassing = JSON.stringify(res.data).toLowerCase().includes("dream pair");
            
            return { 
                component: "AI & System Prompt", 
                passed: isPassing, 
                status: isPassing ? "Healthy" : "Logic Error (Wrong Personality)" 
            };
        } catch (err) {
            return { 
                component: "AI & System Prompt", 
                passed: false, 
                status: "Offline", 
                error: err.message 
            };
        }
    }
};
