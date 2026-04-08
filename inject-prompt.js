const fs = require('fs');
const file = './services/features/intentService.js';
let text = fs.readFileSync(file, 'utf8');

// Ensure buildSystemPrompt is required
if (!text.includes('buildSystemPrompt')) {
  text = "const { buildSystemPrompt } = require('../ai/buildSystemPrompt');\n" + text;
}

// Ensure the prompt is generated before the AI call
if (text.includes('await _generate(phone, userContent, language)')) {
  text = text.replace(
    'await _generate(phone, userContent, language)',
    'await _generate(phone, userContent, language, buildSystemPrompt(client))'
  );
}

fs.writeFileSync(file, text);
console.log("✅ System Prompt link verified/injected!");
