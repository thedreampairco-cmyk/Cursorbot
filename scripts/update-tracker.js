const fs = require('fs');
const path = require('path');

// Directories to scan (ignoring node_modules and heavy folders)
const TARGET_DIRS = ['./']; 
const IGNORE_DIRS = ['node_modules', '.git', 'scripts', 'data'];

// Regex to catch standard functions and arrow functions
const functionRegex = /(?:function\s+([a-zA-Z0-9_]+)\s*\()|(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_]+)\s*=>/g;

let foundFunctions = [];

// Recursive function to scan directories
function scanDirectory(directory) {
    const files = fs.readdirSync(directory);

    files.forEach(file => {
        const fullPath = path.join(directory, file);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            if (!IGNORE_DIRS.includes(file)) {
                scanDirectory(fullPath);
            }
        } else if (file.endsWith('.js')) {
            const content = fs.readFileSync(fullPath, 'utf8');
            let match;
            while ((match = functionRegex.exec(content)) !== null) {
                // match[1] is standard function, match[2] is arrow function
                const funcName = match[1] || match[2];
                if (funcName) {
                    foundFunctions.push(`- \`${funcName}\` *(found in ${fullPath})*`);
                }
            }
        }
    });
}

// Start scanning
console.log('Scanning repository for functions...');
TARGET_DIRS.forEach(dir => scanDirectory(dir));

// Read the existing PROGRESS.md
const progressFilePath = path.join(__dirname, '../PROGRESS.md');
if (!fs.existsSync(progressFilePath)) {
    console.error('❌ PROGRESS.md not found in the root directory. Create it first.');
    process.exit(1);
}

let progressContent = fs.readFileSync(progressFilePath, 'utf8');

// The marker where we will inject the functions
const marker = '## 🛠️ Auto-Detected Codebase Functions\n';
const markerIndex = progressContent.indexOf('## 🛠️ Auto-Detected Codebase Functions');

const functionListStr = foundFunctions.length > 0 
    ? foundFunctions.join('\n') 
    : '- No functions detected yet.';

if (markerIndex !== -1) {
    // Replace everything after the marker
    progressContent = progressContent.substring(0, markerIndex) + marker + functionListStr + '\n';
} else {
    // Append the marker and functions to the bottom of the file
    progressContent += '\n\n' + marker + functionListStr + '\n';
}

fs.writeFileSync(progressFilePath, progressContent, 'utf8');
console.log(`✅ Success! Added ${foundFunctions.length} functions to PROGRESS.md`);
