// services/googleSheets.js
const { google } = require('googleapis');
const path = require('path');

// 1. Initialize the Google Auth Client using the local JSON key file
const auth = new google.auth.GoogleAuth({
  // Adjust this path depending on where you placed the file (e.g., root directory)
  keyFile: path.join(__dirname, '../service-account.json'), 
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

// 2. Instantiate the Sheets API v4
const sheets = google.sheets({ version: 'v4', auth });

/**
 * Fetches raw data from a specified Google Sheet and range.
 * @param {string} spreadsheetId - The ID of the Google Sheet (from the URL).
 * @param {string} range - The A1 notation of the range to retrieve (e.g., 'Catalog!A2:F').
 * @returns {Promise<Array>} An array of rows from the sheet, or an empty array if blank.
 */
async function fetchSheetData(spreadsheetId, range) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: range,
    });
    
    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      console.warn(`[Google Sheets] No data found in range: ${range}`);
      return [];
    }
    
    return rows;
  } catch (error) {
    console.error('[Google Sheets Error] Failed to fetch data:', error.message);
    throw error;
  }
}

module.exports = {
  fetchSheetData
};
