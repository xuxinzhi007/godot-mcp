// Verify that every res:// path referenced from project text files exists on disk.
// usage: node check-refs.mjs <project-root>
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, relative, extname } from 'path';

const root = process.argv[2];
const SLASH = String.fromCharCode(92);
const SKIP = new Set(['.godot', '.git', 'node_modules', 'android', 'apk', '_attic', '_sources']);
const TEXT = new Set(['.tscn', '.tres', '.gd', '.gdshader', '.shader', '.cfg', '.import', '.godot', '.json']);

const missing = new Map();

function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.import') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue;
      walk(full);
      continue;
    }
    const ext = extname(e.name).toLowerCase();
    if (!TEXT.has(ext)) continue;
    const text = readFileSync(full, 'utf8');
    const owner = relative(root, full).split(SLASH).join('/');
    for (const m of text.matchAll(/res:\/\/([^"'\s)\]]+)/g)) {
      const target = m[1];
      if (target.startsWith('.godot/') || target.startsWith('user')) continue;
      const absolute = join(root, target.split('/').join(SLASH));
      if (existsSync(absolute)) continue;
      const key = target;
      if (!missing.has(key)) missing.set(key, []);
      missing.get(key).push(owner);
    }
  }
}

walk(root);

const entries = [...missing.entries()];
console.log(JSON.stringify({
  missing_count: entries.length,
  missing: entries.slice(0, 40).map(([target, owners]) => ({
    target,
    referenced_by: [...new Set(owners)].slice(0, 4),
  })),
}, null, 2));
process.exit(entries.length > 0 ? 1 : 0);
