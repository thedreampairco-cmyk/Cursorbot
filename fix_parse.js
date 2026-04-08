const fs = require('fs');
const path = 'services/features/visionRecognition.js';
let code = fs.readFileSync(path, 'utf8');

const oldFn = `function _safeParseJson(raw) {
  const match = raw.match(/(\\{[\\s\\S]*?\\}|\\[[\\s\\S]*?\\])/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}`;

const newFn = `function _safeParseJson(raw) {
  try { return JSON.parse(raw); } catch (_) {}
  const stripped = raw.replace(/\`\`\`json|\`\`\`/gi, '').trim();
  try { return JSON.parse(stripped); } catch (_) {}
  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch (_) {}
  }
  const aStart = raw.indexOf('[');
  const aEnd   = raw.lastIndexOf(']');
  if (aStart !== -1 && aEnd > aStart) {
    try { return JSON.parse(raw.slice(aStart, aEnd + 1)); } catch (_) {}
  }
  return null;
}`;

if (!code.includes('const match = raw.match')) {
  console.log('ERROR: old function not found');
  process.exit(1);
}

fs.writeFileSync(path, code.replace(oldFn, newFn));
console.log('Done');
