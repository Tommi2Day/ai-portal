// Lists t('…') keys used in the components that have no English translation.
import fs from 'node:fs';
const src = fs.readdirSync('src').filter((f) => /\.(tsx|ts)$/.test(f) && !f.startsWith('i18n.en')).map((f) => fs.readFileSync(`src/${f}`, 'utf8')).join('\n');
const en = fs.readFileSync('src/i18n.en.ts', 'utf8');
const keys = new Set([...src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'")));
const have = new Set([...en.matchAll(/^\s*'((?:[^'\\]|\\.)*)':/gm)].map((m) => m[1].replace(/\\'/g, "'")));
const missing = [...keys].filter((k) => !have.has(k));
if (missing.length) { console.error('Missing English texts:\n' + missing.map((k) => '  ' + k).join('\n')); process.exit(1); }
console.log(`i18n ok: ${keys.size} keys translated`);
