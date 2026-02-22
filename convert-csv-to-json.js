#!/usr/bin/env node
/**
 * Конвертирует CSV-файлы скилла ui-ux-pro-max в JSON для фронтенда.
 * Запустить один раз: node convert-csv-to-json.js
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.env.HOME, '.claude/skills/ui-ux-pro-max/data');
const OUT_DIR = path.join(__dirname, 'public/design-data');

const FILES = [
  'styles.csv',
  'colors.csv',
  'typography.csv',
  'products.csv',
  'landing.csv',
  'ux-guidelines.csv',
  'ui-reasoning.csv',
];

/** Parse CSV with proper handling of quoted fields and newlines */
function parseCSV(text) {
  const rows = [];
  let headers = null;
  let currentRow = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          // Escaped quote
          currentField += '"';
          i += 2;
        } else {
          // End of quoted field
          inQuotes = false;
          i++;
        }
      } else {
        currentField += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ',') {
        currentRow.push(currentField.trim());
        currentField = '';
        i++;
      } else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
        currentRow.push(currentField.trim());
        currentField = '';

        if (!headers) {
          headers = currentRow;
        } else if (currentRow.length === headers.length) {
          const obj = {};
          headers.forEach((h, idx) => { obj[h] = currentRow[idx] || ''; });
          rows.push(obj);
        } else if (currentRow.length > 1 || currentRow[0] !== '') {
          // Row with different column count — try to pad/trim
          const obj = {};
          headers.forEach((h, idx) => { obj[h] = (currentRow[idx] || '').trim(); });
          rows.push(obj);
        }

        currentRow = [];
        i += (ch === '\r') ? 2 : 1;
      } else {
        currentField += ch;
        i++;
      }
    }
  }

  // Handle last field/row
  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (headers && currentRow.length >= headers.length) {
      const obj = {};
      headers.forEach((h, idx) => { obj[h] = (currentRow[idx] || '').trim(); });
      rows.push(obj);
    }
  }

  return rows;
}

// Ensure output directory exists
if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

let converted = 0;

for (const file of FILES) {
  const csvPath = path.join(DATA_DIR, file);
  if (!fs.existsSync(csvPath)) {
    console.warn(`⚠ Skipped (not found): ${csvPath}`);
    continue;
  }

  const text = fs.readFileSync(csvPath, 'utf-8');
  const rows = parseCSV(text);
  const jsonName = file.replace('.csv', '.json');
  const outPath = path.join(OUT_DIR, jsonName);

  fs.writeFileSync(outPath, JSON.stringify(rows, null, 2), 'utf-8');
  console.log(`✅ ${file} → ${jsonName} (${rows.length} rows)`);
  converted++;
}

console.log(`\nDone: ${converted}/${FILES.length} files converted to ${OUT_DIR}`);
