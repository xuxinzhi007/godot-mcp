// Find scenes whose node scripts were replaced by `script = null`.
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

const root = process.argv[2];
const SLASH = String.fromCharCode(92);
const hits = [];

function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) { walk(full); continue; }
    if (!e.name.endsWith('.tscn') && !e.name.endsWith('.tres')) continue;
    const text = readFileSync(full, 'utf8');
    const nulls = text.split(/\r?\n/).filter((l) => /^script = null$/.test(l.trim())).length;
    if (nulls === 0) continue;
    hits.push({ file: relative(root, full).split(SLASH).join('/'), null_scripts: nulls });
  }
}
walk(root);
console.log(JSON.stringify({ damaged: hits.length, files: hits }, null, 2));
