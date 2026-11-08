// Find instanced decor scenes and whether the instance overrides `scale`.
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

const root = process.argv[2];
const SLASH = String.fromCharCode(92);
const DECOR = /res:\/\/Scenes\/decor\/([^"]+\.tscn)/;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.tscn')) out.push(full);
  }
  return out;
}

const rows = [];
for (const file of walk(join(root, 'Scenes'))) {
  const text = readFileSync(file, 'utf8');
  if (!text.includes('instance=ExtResource')) continue;
  const ids = {};
  for (const m of text.matchAll(/\[ext_resource[^\]]*?path="res:\/\/Scenes\/decor\/([^"]+)"[^\]]*?id="([^"]+)"\]/g)) {
    ids[m[2]] = m[1];
  }
  if (Object.keys(ids).length === 0) continue;
  for (const block of text.split('[node ').slice(1)) {
    const inst = block.match(/instance=ExtResource\("([^"]+)"\)/);
    if (!inst || !ids[inst[1]]) continue;
    const scale = block.match(/scale = Vector2\(([^)]+)\)/);
    rows.push({
      scene: relative(root, file).split(SLASH).join('/'),
      decor: ids[inst[1]],
      scaleOverride: scale ? scale[1] : null,
    });
  }
}
const direct = [];
for (const file of walk(join(root, 'Scenes'))) {
  const text = readFileSync(file, 'utf8');
  if (text.includes('instance=ExtResource')) continue;
  if (!DECOR.test(text) && !text.includes('res://Assets/decorations/')) continue;
  for (const m of text.matchAll(/\[node name="([^"]+)"[^\]]*\]\n([^\n]*(?:\n(?![\[n])[^\n]*)*)/g)) {
    const scale = m[2].match(/scale = Vector2\(([^)]+)\)/);
    if (scale) direct.push({ scene: relative(root, file).split(SLASH).join('/'), node: m[1], scale: scale[1] });
  }
}
console.log(JSON.stringify({ instanced: rows, directScaleNodes: direct }, null, 2));
