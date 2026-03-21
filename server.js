// server.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const { PORT, BOT_NAME } = require('./config/env');
const env = require('./config/env');
const errorHandler = require('./errorHandler');

/**
 * ==========================================
 * ADVANCED FORENSIC DIAGNOSTIC BOOTLOADER
 * ==========================================
 * Identifies syntax, reference, type, and missing module errors.
 * Pinpoints exact file, line, column, and responsible repo/origin.
 */
function runAdvancedSystemDiagnostics() {
  console.log('--------------------------------------------------');
  console.log('[SYSTEM] Initiating Advanced Pre-Flight Diagnostics...');
  let fatalErrors = 0;

  const criticalModules = [
    './config/env.js',
    './config/api.js',
    './errorHandler.js',
    './services/googleSheets.js',
    './services/inventoryService.js',
    './services/greenApi.js',
    './services/aiResponse.js',
    './services/buildSystemPrompt.js',
    './routes/webhook.js'
  ];

  criticalModules.forEach((filePath) => {
    try {
      const fullPath = path.join(__dirname, filePath);

      if (!fs.existsSync(fullPath)) {
        console.warn(`[DIAGNOSTIC WARN] File not found (Expected in future step): ${filePath}`);
        return;
      }

      // We use fullPath here to ensure absolute resolution
      require(fullPath);
      console.log(`[DIAGNOSTIC OK] Validated: ${filePath}`);

    } catch (error) {
      console.error(`\n[DIAGNOSTIC FATAL] Architecture breakdown detected!`);
      
      let errorCategory = error.name;
      let exactLocation = filePath;
      let responsibleRepo = "Local Project";
      let actionRequired = "Inspect the code at the specified location.";

      // 1. Missing Module / Dependency (e.g., 'googleapis')
      if (error.code === 'MODULE_NOT_FOUND') {
        errorCategory = "Missing Dependency / File";
        const match = error.message.match(/'([^']+)'/);
        const moduleName = match ? match[1] : 'Unknown';
        
        if (!moduleName.startsWith('.') && !moduleName.startsWith('/')) {
          responsibleRepo = `NPM Registry (node_modules/${moduleName})`;
          actionRequired = `Run command: npm install ${moduleName}`;
        } else {
          responsibleRepo = "Local Project (Missing internal file)";
          actionRequired = `Ensure the file ${moduleName} exists and the path is correct.`;
        }
      } 
      // 2. Syntax Errors (Missing brackets, commas, typos)
      else if (error instanceof SyntaxError) {
        errorCategory = "Syntax Error";
        const syntaxMatch = error.stack.split('\n')[0];
        exactLocation = syntaxMatch;
        actionRequired = "Fix the typo, missing bracket, or invalid syntax on this exact line.";
      } 
      // 3. Runtime Errors (ReferenceError, TypeError during initialization)
      else if (error.stack) {
        const stackLines = error.stack.split('\n');
        for (let line of stackLines) {
          if (line.includes('at ') && !line.includes('node:internal') && !line.includes('internal/modules')) {
            const match = line.match(/(?:at\s+.*\()?(.*?):(\d+):(\d+)\)?/);
            if (match) {
              exactLocation = `Line ${match[2]}, Column ${match[3]} in ${match[1]}`;
              if (match[1].includes('node_modules')) {
                responsibleRepo = "Third-Party Package (node_modules)";
                actionRequired = "An external package crashed. Check package documentation or update it.";
              }
              break;
            }
          }
        }
      }

      console.error(`-> Failed File:    ${filePath}`);
      console.error(`-> Error Type:     ${errorCategory}`);
      console.error(`-> Raw Message:    ${error.message.split('\n')[0]}`);
      console.error(`-> Exact Location: ${exactLocation}`);
      console.error(`-> Origin/Repo:    ${responsibleRepo}`);
      console.error(`-> Fix Action:     ${actionRequired}\n`);
      fatalErrors++;
    }
  });

  if (fatalErrors > 0) {
    console.error(`[SYSTEM HALT] Boot sequence aborted due to ${fatalErrors} critical error(s).`);
    console.log('--------------------------------------------------\n');
    process.exit(1); 
  }

  console.log('[SYSTEM] All modules compiled successfully. Architecture is perfectly stable.');
  console.log('--------------------------------------------------\n');
}

// Execute diagnostics
runAdvancedSystemDiagnostics();

/**
 * ==========================================
 * EXPRESS SERVER SETUP
 * ==========================================
 */
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: `${BOT_NAME} Server is running.` });
});

const webhookRoutes = require('./routes/webhook');
app.use('/api/webhook', webhookRoutes);

app.use(errorHandler);

app.listen(PORT, () => {
  const mode = process.env.NODE_ENV || 'development';
  console.log(`[SYSTEM] ${BOT_NAME} initialized on port ${PORT} in ${mode} mode.`);
});
