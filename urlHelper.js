// urlHelper.js

/**
 * Converts a standard Google Drive share link into a direct download link
 * that can be rendered by WhatsApp/Green API.
 */
function formatImageUrl(url) {
    if (!url) return null;

    if (url.includes('drive.google.com')) {
        // Safely extract the 25-33 character Google Drive ID, ignoring query parameters
        const match = url.match(/[-\w]{25,33}/);
        if (match && match[0]) {
            return `https://drive.google.com/uc?export=download&id=${match[0]}`;
        }
    }

    return url; 
}

/**
 * Extracts the first valid image URL found in a text string or product object.
 */
function isImageUrl(url) {
    if (!url) return false;
    // 'i' flag makes it case-insensitive. (?:\?.*)? allows trailing query strings like ?v=123
    return (url.match(/\.(jpeg|jpg|gif|png)(?:\?.*)?$/i) != null) || url.includes('drive.google.com');
}

module.exports = {
    formatImageUrl,
    isImageUrl
};

