// services/inventoryService.js
const { formatImageUrl } = require('../urlHelper'); 

const { fetchSheetData } = require('./googleSheets');
// Removed unused formatImageUrl import

// Hardcoded Sheet reference
const SHEET_RANGE = 'PRODUCTS!A2:I';

// Column Mappings (0-indexed based on A-I)
const COLUMNS = {
  ID: 0,                 // Column A
  NAME: 1,               // Column B
  CATEGORY: 2,           // Column C (Catagory)
  COLOUR: 3,             // Column D
  PRICE: 4,              // Column E
  SIZES: 5,              // Column F
  STOCK: 6,              // Column G
  IMAGE_URL: 7,          // Column H (The high-res media link)
  GENDER_PREFERENCE: 8   // Column I
};

/**
 * Fetches raw sheet data and maps it into structured JSON objects.
 * @param {string} spreadsheetId - The Google Sheet ID.
 * @returns {Promise<Array<Object>>} Array of parsed inventory items.
 */
async function getParsedCatalog(spreadsheetId) {
  try {
    const rawRows = await fetchSheetData(spreadsheetId, SHEET_RANGE);

    if (!rawRows || rawRows.length === 0) {
      console.warn('[Inventory Service] Catalog is empty or no data returned.');
      return [];
    }

    const catalog = rawRows.map((row) => {
      return {
        id: row[COLUMNS.ID] || '',
        name: row[COLUMNS.NAME] || 'Unknown Sneaker',
        category: row[COLUMNS.CATEGORY] || '',
        colour: row[COLUMNS.COLOUR] || '',
        price: row[COLUMNS.PRICE] || '0',
        // Split sizes by comma and trim whitespace, if sizes exist
        sizes: row[COLUMNS.SIZES] ? row[COLUMNS.SIZES].toString().split(',').map(s => s.trim()) : [],
        stock: parseInt(row[COLUMNS.STOCK]) || 0,
        imageUrl: row[COLUMNS.IMAGE_URL] || null,
        genderPreference: row[COLUMNS.GENDER_PREFERENCE] || ''
      };
    });

    return catalog;

  } catch (error) {
    console.error('[Inventory Service Error] Failed to parse catalog:', error.message);
    throw error;
  }
}

/**
 * Finds a specific sneaker to extract its Image URL and details.
 * Expanded to search across Name, Category, and Colour.
 * @param {string} spreadsheetId - The Google Sheet ID.
 * @param {string} itemName - The query Maya uses to find the shoe.
 * @returns {Promise<Object|null>} The item object or null if not found.
 */
async function findItemByName(spreadsheetId, itemName) {
  const catalog = await getParsedCatalog(spreadsheetId);

  // 1. Split the search query into individual words (e.g., ["jordan", "1", "blue"])
  const searchTerms = itemName.toLowerCase().trim().split(/\s+/);

  // 2. Find the first item where ALL search words exist across the combined item data
  return catalog.find(item => {
    // Combine fields so Maya can search by name + colour + category seamlessly
    const searchableString = `${item.name} ${item.category} ${item.colour}`.toLowerCase();
    
    // Returns true only if every word in Maya's search query is found in the combined string
    return searchTerms.every(term => searchableString.includes(term));
  }) || null;
}

module.exports = {
  getParsedCatalog,
  findItemByName
};
