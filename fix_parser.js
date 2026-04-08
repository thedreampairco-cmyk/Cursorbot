const fs = require('fs');
const file = 'services/data/googleSheetsFetch.js';
let code = fs.readFileSync(file, 'utf8');

// 1. Add gender to COLUMN_MAP
code = code.replace(
  "  imageUrl:    ['imageurl', 'image_url', 'image', 'img', 'photo', 'picture'],",
  "  imageUrl:    ['imageurl', 'image_url', 'image', 'img', 'photo', 'picture'],\n  gender:      ['gender', 'gender preference', 'gender_preference'],"
);

// 2. Add brand extractor + size expander + gender to parseRow return
const oldReturn = "  return {\n    sku:         get('id'),\n    id:          get('id'),\n    name:        get('name'),\n    brand:       get('brand')    || '',";
const newReturn = "  // Extract brand from first word of name e.g. 'Vans Classic Slip-On' -> 'Vans'\n  const fullName = get('name') || '';\n  const brand = get('brand') || fullName.split(' ')[0] || '';\n\n  return {\n    sku:         get('id'),\n    id:          get('id'),\n    name:        fullName,\n    brand:       brand,";

code = code.replace(oldReturn, newReturn);

// 3. Fix sizes - expand range "5-13" into ["5","6",...,"13"]
const oldSizes = "    sizes:       String(get('sizes') || '').split(',').map((s) => s.trim()).filter(Boolean),";
const newSizes = `    sizes:       expandSizes(get('sizes')),`;

code = code.replace(oldSizes, newSizes);

// 4. Add gender field to return object
const oldDesc = "    description: get('description') || '',";
const newDesc = "    description: get('description') || '',\n    gender:      get('gender') || 'Unisex',";

code = code.replace(oldDesc, newDesc);

// 5. Add expandSizes helper before parseRow
const helperFn = `
function expandSizes(raw) {
  if (!raw) return [];
  const str = String(raw).trim();
  // Range format: "5-13" or "6-12"
  const rangeMatch = str.match(/^([0-9.]+)-([0-9.]+)$/);
  if (rangeMatch) {
    const start = parseFloat(rangeMatch[1]);
    const end   = parseFloat(rangeMatch[2]);
    const sizes = [];
    for (let s = start; s <= end; s += 0.5) {
      sizes.push(Number.isInteger(s) ? String(s) : s.toFixed(1));
    }
    return sizes;
  }
  // Comma format: "6,7,8,9"
  return str.split(',').map((s) => s.trim()).filter(Boolean);
}

`;

code = code.replace('function parseRow(row, colIndex) {', helperFn + 'function parseRow(row, colIndex) {');

fs.writeFileSync(file, code);
console.log('Done');
