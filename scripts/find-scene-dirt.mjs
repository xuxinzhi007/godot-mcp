// Find scene "dirty data": non-uniform scale on non-sprite nodes, and
// asymmetric offsets on centred full cards.
// usage: node scripts/find-scene-dirt.mjs <project-root>
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

const root = process.argv[2];
const SLASH = String.fromCharCode(92);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.tscn')) out.push(full);
  }
  return out;
}

const report = [];
for (const file of walk(join(root, 'Scenes'))) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(root, file).split(SLASH).join('/');
  const issues = [];

  for (const block of text.split('[node ').slice(1)) {
    const name = (block.match(/^name="([^"]+)"/) || [])[1] ?? '?';
    const type = (block.match(/type="([^"]+)"/) || [])[1] ?? '?';
    const body = block.split(/\n(?=\[)/)[0];
    const scale = body.match(/scale = Vector2\(([-\d.]+), ([-\d.]+)\)/);
    if (scale) {
      const x = parseFloat(scale[1]);
      const y = parseFloat(scale[2]);
      // Sprites/tiles are legitimately non-uniform; containers/cards are not.
      const spriteLike = /Sprite|Texture|Tile|Progress|Panel|Label/.test(type);
      if (!spriteLike && Math.abs(x - y) > 0.002) {
        issues.push(`${name}(${type}) 非等比 scale ${x}/${y}`);
      }
    }
    const left = body.match(/offset_left = ([-\d.]+)/);
    const right = body.match(/offset_right = ([-\d.]+)/);
    const top = body.match(/offset_top = ([-\d.]+)/);
    const bottom = body.match(/offset_bottom = ([-\d.]+)/);
    if (left && right && top && bottom && body.includes('anchor_left = 0.5') && body.includes('anchor_top = 0.5')) {
      const l = parseFloat(left[1]);
      const r = parseFloat(right[1]);
      const t = parseFloat(top[1]);
      const b = parseFloat(bottom[1]);
      if (Math.abs(Math.abs(l) - Math.abs(r)) > 1.0 || Math.abs(Math.abs(t) - Math.abs(b)) > 1.0) {
        issues.push(`${name} 居中偏移不对称 L${l} R${r} T${t} B${b}`);
      }
    }
  }
  if (issues.length > 0) report.push({ file: rel, issues });
}

console.log(JSON.stringify({ files: report.length, report }, null, 2));
