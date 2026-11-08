// Read the [RESULT] payload out of a probe/Godot log dump and print layout rows.
import { readFileSync } from 'fs';

const file = process.argv[2];
const raw = readFileSync(file, 'utf8');
const start = raw.indexOf('[RESULT]');
if (start === -1) {
  console.log('no [RESULT] in', file);
  process.exit(1);
}
let text = raw.slice(start + '[RESULT]'.length);
// The payload is embedded in a JSON string, so unescape it first.
text = text.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
// Take the balanced {...} payload (the log tail after it holds real newlines).
let depth = 0;
let inString = false;
let escaped = false;
let endIndex = -1;
for (let i = 0; i < text.length; i += 1) {
  const ch = text[i];
  if (escaped) {
    escaped = false;
    continue;
  }
  if (ch === '\\') {
    escaped = true;
    continue;
  }
  if (ch === '"') {
    inString = !inString;
    continue;
  }
  if (inString) continue;
  if (ch === '{') depth += 1;
  else if (ch === '}') {
    depth -= 1;
    if (depth === 0) {
      endIndex = i;
      break;
    }
  }
}
const json = text.slice(0, endIndex + 1);
const data = JSON.parse(json);

console.log('viewport', data.viewport, '| tab_rows', data.tab_rows);
for (const row of data.nodes) {
  if (row.error) {
    console.log('  MISSING', row.node);
    continue;
  }
  console.log('  ' + String(row.node).padEnd(22), 'pos=' + JSON.stringify(row.pos).padEnd(14), 'size=' + JSON.stringify(row.size), row.visible ? '' : '(HIDDEN)');
}
const footer = data.nodes.find((n) => n.node === 'FooterLabel');
if (footer) {
  const bottom = footer.pos[1] + footer.size[1];
  console.log('footer bottom =', bottom, '/ viewport height =', data.viewport[1], bottom <= data.viewport[1] ? 'OK (fits)' : 'OVERFLOW');
}
