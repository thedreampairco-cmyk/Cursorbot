const axios = require('axios');

module.exports = {
    run: async () => {
        try {
            const res = await axios.post(process.env.MAIN_BOT_WEBHOOK_URL, { 
                type: "image", 
                url: "https://images.unsplash.com/photo-1542291026-7eec264c27ff" 
            });
            
            const dataStr = JSON.stringify(res.data).toLowerCase();
            const isPassing = dataStr.match(/(shoe|sneaker|identified|nike|jordan)/);
            
            return { 
                component: "Vision AI Pipeline", 
                passed: !!isPassing, 
                status: isPassing ? "Healthy" : "Logic Error (Vision Failed)" 
            };
        } catch (err) {
            return { 
                component: "Vision AI Pipeline", 
                passed: false, 
                status: "Offline", 
                error: err.message 
            };
        }
    }
};
