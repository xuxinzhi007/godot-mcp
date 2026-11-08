// Read-only asset audit for a Godot project.
// usage: node audit.mjs <project-root>
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, extname } from 'path';
import { createHash } from 'crypto';

const root = process.argv[2];
const SLASH = String.fromCharCode(92);
const SKIP = new Set(['.godot', '.git', 'node_modules', 'android', 'apk']);
const ASSET_EXT = new Set(['.png', '.jpg', '.jpeg', '.svg', '.webp', '.wav', '.ogg', '.mp3', '.ttf', '.otf', '.glb', '.gltf']);
const TEXT_EXT = new Set(['.tscn', '.tres', '.gd', '.gdshader', '.shader', '.cfg', '.godot', '.import', '.json', '.md', '.uid']);

const assets = [];
const texts = [];
const junk = [];
const allFiles = [];

function walk(dir, depth = 0) {
  if (depth > 14) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.import') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue;
      walk(full, depth + 1);
    } else if (e.isFile()) {
      const rel = relative(root, full).split(SLASH).join('/');
      const ext = extname(e.name).toLowerCase();
      const size = statSync(full).size;
      allFiles.push({ rel, ext, size });
      if (ASSET_EXT.has(ext)) assets.push({ rel, ext, size });
      else if (TEXT_EXT.has(ext)) texts.push({ rel, ext, size });
      else junk.push({ rel, ext, size });
    }
  }
}
walk(root);

const referenced = new Set();
const referencedBare = new Set();
for (const t of texts) {
  if (t.ext === '.import') continue; // .import files reference their own source
  const content = readFileSync(join(root, t.rel), 'utf8');
  for (const m of content.matchAll(/res:\/\/([^"'\s)\]]+)/g)) referenced.add(m[1]);
  for (const m of content.matchAll(/["']((?:Assets|Scenes|Scripts|Shaders|Audio)\/[^"'\s]+)["']/g)) referencedBare.add(m[1]);
}

const isUsed = (a) => referenced.has(a.rel) || referencedBare.has(a.rel);
const unused = assets.filter((a) => !isUsed(a));

const byHash = new Map();
for (const a of assets) {
  const buf = readFileSync(join(root, a.rel));
  const h = createHash('md5').update(buf).digest('hex');
  if (!byHash.has(h)) byHash.set(h, []);
  byHash.get(h).push(a);
}
const dupes = [...byHash.values()].filter((g) => g.length > 1);

const junkByExt = {};
for (const j of junk) junkByExt[j.ext || '(noext)'] = (junkByExt[j.ext || '(noext)'] ?? 0) + 1;

const dirCount = new Map();
for (const a of assets) {
  const dir = a.rel.split('/').slice(0, -1).join('/') || '.';
  const cur = dirCount.get(dir) ?? { files: 0, bytes: 0, used: 0 };
  cur.files += 1;
  cur.bytes += a.size;
  if (isUsed(a)) cur.used += 1;
  dirCount.set(dir, cur);
}
const dirs = [...dirCount.entries()]
  .map(([dir, v]) => ({ dir, files: v.files, used: v.used, mb: +(v.bytes / 1048576).toFixed(1) }))
  .sort((a, b) => b.mb - a.mb);

console.log(JSON.stringify({
  totals: { assets: assets.length, texts: texts.length, junk: junk.length, all: allFiles.length },
  assetMB: +(assets.reduce((s, a) => s + a.size, 0) / 1048576).toFixed(1),
  usedCount: assets.filter(isUsed).length,
  unusedCount: unused.length,
  unusedMB: +(unused.reduce((s, a) => s + a.size, 0) / 1048576).toFixed(1),
  unusedSample: unused.slice(0, 50).map((a) => `${a.rel} (${(a.size / 1024).toFixed(0)}K)`),
  junkByExt,
  junkSample: junk.map((j) => `${j.rel} (${(j.size / 1024).toFixed(0)}K)`),
  biggest: [...assets].sort((a, b) => b.size - a.size).slice(0, 10).map((a) => `${a.rel} (${(a.size / 1048576).toFixed(1)}M)`),
  duplicateGroups: dupes.length,
  duplicateWasteMB: +(dupes.reduce((s, g) => s + g.slice(1).reduce((x, a) => x + a.size, 0), 0) / 1048576).toFixed(1),
  duplicateSample: dupes.slice(0, 10).map((g) => g.map((a) => a.rel)),
  dirs,
}, null, 2));
