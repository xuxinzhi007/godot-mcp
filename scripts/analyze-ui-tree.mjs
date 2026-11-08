// UI tree analysis: depth, container usage, hand-made spacers, style overrides,
// and icon sizing (which is what makes icons "look pasted on").
// usage: node scripts/analyze-ui-tree.mjs <project-root> [scenes/**/*.tscn]
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, relative, basename } from 'path';

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

function pngSize(file) {
  try {
    const b = readFileSync(file);
    if (b[0] !== 0x89) return null;
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  } catch {
    return null;
  }
}

function svgSize(file) {
  try {
    const text = readFileSync(file, 'utf8').slice(0, 400);
    const w = text.match(/width="([\d.]+)"/);
    const h = text.match(/height="([\d.]+)"/);
    if (w && h) return [parseFloat(w[1]), parseFloat(h[1])];
    const vb = text.match(/viewBox="[\d.\-]+ [\d.\-]+ ([\d.]+) ([\d.]+)"/);
    if (vb) return [parseFloat(vb[1]), parseFloat(vb[2])];
    return null;
  } catch {
    return null;
  }
}

const scenes = walk(join(root, 'Scenes'));
const report = [];

for (const file of scenes) {
  const text = readFileSync(file, 'utf8');
  if (!/^\[node /m.test(text)) continue;
  const nodes = [];
  for (const block of text.split('[node ').slice(1)) {
    const head = block.split('\n')[0];
    const name = (head.match(/name="([^"]+)"/) || [])[1] ?? '?';
    const type = (head.match(/type="([^"]+)"/) || [])[1] ?? '';
    const parent = (head.match(/parent="([^"]+)"/) || [])[1] ?? '.';
    const body = block.split(/\n(?=\[)/)[0];
    nodes.push({ name, type, parent, body, head });
  }

  const uiTypes = /^(Control|Panel|PanelContainer|MarginContainer|VBoxContainer|HBoxContainer|GridContainer|BoxContainer|CenterContainer|ScrollContainer|Button|Label|TextureRect|LineEdit|ProgressBar|ColorRect|TextureButton|TabContainer|HSeparator|VSeparator|RichTextLabel|CheckBox|OptionButton)$/;
  const uiNodes = nodes.filter((n) => uiTypes.test(n.type));
  if (uiNodes.length === 0) continue;

  const byPath = new Map();
  byPath.set('.', { depth: 0, path: '.' });
  for (const n of uiNodes) {
    const parentPath = n.parent === '.' ? '.' : n.parent;
    const depth = (byPath.get(parentPath)?.depth ?? 0) + 1;
    const path = parentPath === '.' ? n.name : `${parentPath}/${n.name}`;
    byPath.set(path, { depth, path });
  }

  const depth = Math.max(...[...byPath.values()].map((v) => v.depth));
  const containers = uiNodes.filter((n) => /Container$|Container/.test(n.type)).length;
  const spacers = uiNodes.filter((n) => /^Spacer/i.test(n.name) || (n.type === 'Control' && !/texture|size_flags|anchors_preset = 15/.test(n.body))).length;
  const themeOverrides = (text.match(/theme_override_/g) || []).length;
  const styleboxes = (text.match(/sub_resource type="StyleBox/g) || []).length;

  // icons: TextureRect texture / Button icon, with declared min size
  const icons = [];
  for (const n of uiNodes) {
    const isTexture = n.type === 'TextureRect' || n.type === 'TextureButton';
    const iconRef = isTexture ? n.body.match(/texture = ExtResource\("([^"]+)"\)/) : n.head.includes('type="Button"') ? null : null;
    const ref = iconRef ?? n.body.match(/^icon = ExtResource\("([^"]+)"\)/m);
    if (!ref) continue;
    const id = ref[1];
    const ext = [...text.matchAll(/\[ext_resource[^\]]*path="res:\/\/([^"]+)"[^\]]*id="([^"]+)"\]/g)].find((m) => m[2] === id);
    if (!ext) continue;
    const assetRel = ext[1];
    const assetAbs = join(root, assetRel.split('/').join(SLASH));
    const srcSize = assetRel.endsWith('.png') ? pngSize(assetAbs) : svgSize(assetAbs);
    const minW = n.body.match(/custom_minimum_size = Vector2\(([\d.]+), ([\d.]+)\)/);
    icons.push({
      node: n.name,
      asset: basename(assetRel),
      src: srcSize,
      min: minW ? [parseFloat(minW[1]), parseFloat(minW[2])] : null,
      stretch: (n.body.match(/stretch_mode = (\d+)/) || [])[1] ?? null,
      expand: (n.body.match(/expand_mode = (\d+)/) || [])[1] ?? null,
    });
  }

  report.push({
    scene: relative(root, file).split(SLASH).join('/'),
    nodes: nodes.length,
    ui_nodes: uiNodes.length,
    depth,
    containers,
    spacers,
    theme_overrides: themeOverrides,
    styleboxes,
    icons,
  });
}

report.sort((a, b) => b.nodes - a.nodes);
console.log(JSON.stringify({ scenes: report.length, report }, null, 2));
