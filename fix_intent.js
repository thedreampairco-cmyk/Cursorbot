const fs = require('fs');
const file = 'services/features/intentService.js';
let code = fs.readFileSync(file, 'utf8');

// Add heuristic after the duplicate Image analysis fast-path block
const anchor = `  if (/^(hi|hello|hey|hii+|namaste|namaskar|jai hind)[\\s!]*$/i.test(trimmed)) {`;

const newHeuristic = `  // "show me X image" / "X ka photo dikhao" → search_product, not image_search
  const showImageMatch = lower.match(
    /(?:show|send|dikhao|dikh|bhejo)\\s+(?:me\\s+)?(?:the\\s+)?(.+?)\\s+(?:image|photo|pic|picture|tasveer|photo dikhao)$/i
  );
  if (showImageMatch) {
    const productQuery = showImageMatch[1].trim();
    return {
      intent:     "search_product",
      confidence: 0.95,
      entities:   { ..._emptyEntities(), query: productQuery },
      language:   _guessLang(lower),
    };
  }

  // Generic "show me X" / "dikhao X" → search_product
  const showProductMatch = lower.match(
    /^(?:show|dikhao|dikh|show me|mujhe dikhao)\\s+(?:me\\s+)?(?:the\\s+)?(.+)$/i
  );
  if (showProductMatch) {
    const productQuery = showProductMatch[1].trim();
    if (productQuery.length > 2) {
      return {
        intent:     "search_product",
        confidence: 0.9,
        entities:   { ..._emptyEntities(), query: productQuery },
        language:   _guessLang(lower),
      };
    }
  }

  `;

code = code.replace(anchor, newHeuristic + anchor);
fs.writeFileSync(file, code);
console.log('Done');
