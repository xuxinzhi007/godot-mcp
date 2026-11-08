// Scene graph analysis for a Godot project: who references what, which scenes
// are orphans, and which files are byte/структура-level duplicates.
// usage: node scripts/analyze-scenes.mjs <project-root>
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, basename, extname } from 'path';
import { createHash } from 'crypto';

const root = process.argv[2];
const SLASH = String.fromCharCode(92);
const SKIP = new Set(['.godot', '.git', 'node_modules', 'android', 'apk', '_attic', '_sources']);

const files = [];
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue;
      walk(full);
      continue;
    }
    const ext = extname(e.name).toLowerCase();
    if (!['.tscn', '.tres', '.gd', '.godot', '.cfg'].includes(ext)) continue;
    files.push({ rel: relative(root, full).split(SLASH).join('/'), full, ext });
  }
}
walk(root);

const scenes = files.filter((f) => f.ext === '.tscn');

// ---- who references what -------------------------------------------------
const refs = new Map(); // targetRel -> [{ from, kind }]
const note = (target, from, kind) => {
  if (!refs.has(target)) refs.set(target, []);
  refs.get(target).push({ from, kind });
};

for (const f of files) {
  const text = readFileSync(f.full, 'utf8');
  for (const m of text.matchAll(/res:\/\/([^"'\s)\]]+\.tscn)/g)) {
    const target = m[1];
    if (target === f.rel) continue;
    let kind = 'path';
    if (f.ext === '.tscn') {
      const header = text.slice(Math.max(0, m.index - 200), m.index);
      kind = header.includes('type="PackedScene"') ? 'instance' : 'texture/other';
    } else if (f.ext === '.gd') {
      kind = /preload\(|load\(|change_scene_to_file/.test(text) ? 'gd-load' : 'gd-path';
    }
    note(target, f.rel, kind);
  }
}

// ---- duplicate detection -------------------------------------------------
const normalise = (text) =>
  text
    .replace(/uid="uid:\/\/[^"]*"/g, '')
    .replace(/ unique_id=[0-9]+/g, '')
    .replace(/id="[^"]*"/g, '')
    .replace(/\r/g, '');

const byHash = new Map();
for (const s of scenes) {
  const text = readFileSync(s.full, 'utf8');
  const hash = createHash('md5').update(normalise(text)).digest('hex');
  if (!byHash.has(hash)) byHash.set(hash, []);
  byHash.get(hash).push(s.rel);
}
const exactDupes = [...byHash.values()].filter((g) => g.length > 1);

const byName = new Map();
for (const s of scenes) {
  const name = basename(s.rel);
  if (!byName.has(name)) byName.set(name, []);
  byName.get(name).push(s.rel);
}
const nameCollisions = [...byName.entries()].filter(([, g]) => g.length > 1);

// ---- report --------------------------------------------------------------
const rows = scenes.map((s) => {
  const text = readFileSync(s.full, 'utf8');
  return {
    rel: s.rel,
    lines: text.split('\n').length,
    nodes: (text.match(/^\[node /gm) || []).length,
    instances: (text.match(/instance=ExtResource/g) || []).length,
    refs: (refs.get(s.rel) || []).length,
    refKinds: [...new Set((refs.get(s.rel) || []).map((r) => r.kind))],
  };
});

const orphans = rows.filter((r) => r.refs === 0).map((r) => r.rel);
const hubs = [...rows].sort((a, b) => b.refs - a.refs).slice(0, 12);

const dirStats = new Map();
for (const r of rows) {
  const dir = r.rel.split('/').slice(0, -1).join('/') || '.';
  const cur = dirStats.get(dir) ?? { files: 0, lines: 0 };
  cur.files += 1;
  cur.lines += r.lines;
  dirStats.set(dir, cur);
}

console.log(
  JSON.stringify(
    {
      totals: { scenes: scenes.length, lines: rows.reduce((s, r) => s + r.lines, 0) },
      exactDuplicates: exactDupes,
      nameCollisions: nameCollisions.map(([name, list]) => ({ name, list })),
      orphans,
      hubs: hubs.map((h) => `${h.rel}  refs=${h.refs} [${h.refKinds}]`),
      dirs: [...dirStats.entries()]
        .map(([dir, v]) => ({ dir, ...v }))
        .sort((a, b) => b.lines - a.lines),
      rows: rows.sort((a, b) => a.rel.localeCompare(b.rel)),
    },
    null,
    2
  )
);
