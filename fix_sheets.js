const fs = require('fs');
const path = 'services/data/googleSheetsFetch.js';
let code = fs.readFileSync(path, 'utf8');

const oldColumnMap = `const COLUMN_MAP = {
  id: ['id', 'product_id', 'sku'],
  name: ['name', 'product_name', 'title'],
  brand: ['brand'],
  category: ['category', 'type'],
  price: ['price', 'mrp', 'selling_price'],
  sizes: ['sizes', 'size', 'available_sizes'],
  color: ['color', 'colour'],
  stock: ['stock', 'inventory', 'qty', 'quantity'],
  description: ['description', 'desc'],
  imageUrl: ['imageurl', 'image_url', 'image', 'img', 'photo', 'picture'],
};`;

const newColumnMap = `const COLUMN_MAP = {
  id:          ['id', 'product_id', 'sku'],
  name:        ['name', 'product_name', 'title'],
  brand:       ['brand'],
  category:    ['category', 'catagory', 'type'],
  price:       ['price', 'mrp', 'selling_price'],
  sizes:       ['sizes', 'size', 'available_sizes'],
  color:       ['color', 'colour'],
  stock:       ['stock', 'inventory', 'qty', 'quantity'],
  description: ['description', 'desc'],
  imageUrl:    ['imageurl', 'image_url', 'image', 'img', 'photo', 'picture'],
};`;

const oldParseRow = `function parseRow(row, headers) {
  const getVal = (names) => {
    const idx = headers.findIndex(h => names.includes(h.toLowerCase().trim()));
    return idx !== -1 ? row[idx] : null;
  };
  return {
    sku: getVal(['sku', 'id', 'article']),
    brand: getVal(['brand', 'company', 'make']),
    name: getVal(['name', 'title', 'product', 'model']),
    category: getVal(['category', 'type']),
    price: parseFloat(String(getVal(['price', 'mrp', 'cost'])).replace(/[^0-9.]/g, '')) || 0,
    stock: parseInt(getVal(['stock', 'inventory', 'qty'])) || 0,
    description: getVal(['description', 'details', 'about']) || ""
  };
}`;

const newParseRow = `function parseRow(row, colIndex) {
  // colIndex is { field: "OriginalColumnName" } built by buildColumnIndex
  const get = (field) => {
    const col = colIndex[field];
    return col ? (row[col] || null) : null;
  };

  const rawImage = get('imageUrl') || '';
  // Convert Google Drive viewer URLs to direct download URLs
  const imageUrl = rawImage.replace(
    /https:\/\/drive\.google\.com\/file\/d\/([^/]+)\/view[^"]*/,
    'https://drive.google.com/uc?export=download&id=$1'
  );

  return {
    sku:         get('id'),
    id:          get('id'),
    name:        get('name'),
    brand:       get('brand')   || '',
    category:    get('category') || '',
    color:       get('color')   || '',
    price:       parseFloat(String(get('price')).replace(/[^0-9.]/g, '')) || 0,
    stock:       parseInt(get('stock'))  || 0,
    sizes:       String(get('sizes') || '').split(',').map(s => s.trim()).filter(Boolean),
    description: get('description') || '',
    imageUrl,
  };
}`;

const oldFilter = `.filter((p) => p.id && p.name); // require at minimum id + name`;
const newFilter = `.filter((p) => p.sku && p.name); // require at minimum sku + name`;

if (!code.includes('const COLUMN_MAP')) {
  console.log('ERROR: COLUMN_MAP not found'); process.exit(1);
}

code = code.replace(oldColumnMap, newColumnMap);
code = code.replace(oldParseRow,  newParseRow);
code = code.replace(oldFilter,    newFilter);

fs.writeFileSync(path, code);
console.log('Done');
