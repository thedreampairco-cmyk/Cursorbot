const axios = require('axios');

// Ensure you have your Groq API key in your .env file
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const getVisionAnalysis = async (imageUrl) => {
    try {
        console.log("📥 Downloading image from Green API...");
        
        // 1. Download the image directly into memory (arraybuffer)
        const response = await axios({
            url: imageUrl,
            method: 'GET',
            responseType: 'arraybuffer'
        });
        
        // 2. Convert directly to Base64 for the Groq API
        const base64Image = Buffer.from(response.data, 'binary').toString('base64');
        const dataUrl = `data:image/jpeg;base64,${base64Image}`;

        console.log("🧠 Sending to Groq Vision API (Llama 4 Scout)...");

        // 3. Call Groq's fast Vision Model 
        const groqResponse = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: "meta-llama/llama-4-scout-17b-16e-instruct", 
                messages: [
                    {
                        role: "user",
                        content: [
                            { 
                                type: "text", 
                                text: `Analyze this shoe image. You must reply ONLY with a valid JSON object. Do not include markdown formatting or explanation.
                                Format: {"detected_text": "brand and model name", "labels": ["tag1", "tag2", "tag3"]}.
                                Try to match exactly with these brands if possible: Adidas Samba, Adidas Taekwondo, Adidas Tokyo, Vans Classic Slip-On, Onitsuka Tiger Mexico 66, Golden Goose Ball Star, Puma Speedcat.`
                            },
                            { 
                                type: "image_url", 
                                image_url: { url: dataUrl } 
                            }
                        ]
                    }
                ],
                temperature: 0.1, // Keep it highly factual so it doesn't hallucinate shoe names
                response_format: { type: "json_object" } // Force JSON output for our webhook
            },
            {
                headers: {
                    'Authorization': `Bearer ${GROQ_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        // 4. Parse the AI response
        const aiResultText = groqResponse.data.choices[0].message.content;
        const result = JSON.parse(aiResultText);
        
        console.log(`🎯 Vision Result:`, result);
        return result;

    } catch (error) {
        console.error("❌ Groq Vision Error:", error.response?.data || error.message);
        
        // Safe fallback so the bot keeps chatting even if the vision API glitches
        return { 
            detected_text: "", 
            labels: ["shoe", "sneaker"] 
        };
    }
};

module.exports = { getVisionAnalysis };
