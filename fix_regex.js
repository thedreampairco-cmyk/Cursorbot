const fs = require('fs');
const file = 'services/data/googleSheetsFetch.js';
let code = fs.readFileSync(file, 'utf8');

// Find and replace just the imageUrl block - string indexOf approach, no regex
const badStart = 'const imageUrl = rawImage.replace(';
const badEnd   = ': rawImage;';

const si = code.indexOf(badStart);
const ei = code.indexOf(badEnd, si) + badEnd.length;

if (si === -1) { console.log('ERROR: block not found'); process.exit(1); }

const goodBlock = `const driveMatch = rawImage.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  const imageUrl = driveMatch
    ? 'https://drive.google.com/uc?export=download&id=' + driveMatch[1]
    : rawImage;`;

code = code.slice(0, si) + goodBlock + code.slice(ei);
fs.writeFileSync(file, code);
console.log('Done');
