const { getAIResponse } = require("./services/aiResponse");

async function testAI() {
  const input = "Suggest me stylish sneakers under 2000";
  console.log("👤 User:", input);

  const reply = await getAIResponse(input);

  console.log("🤖 Maya:", reply);
}

testAI();
