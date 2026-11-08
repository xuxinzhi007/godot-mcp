// check stale references left after the rename pass
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

const root = process.argv[2];
const SLASH = String.fromCharCode(92);
const olds = [
  'Assets/characters/floor_decorations/',
  'Assets/characters/素材图.png',
  'Assets/characters/传送门旋涡.png',
  'Assets/characters/传送门门框.png',
  'Assets/characters/拿刀武夫.png',
  'Assets/characters/攻击序列帧.png',
  'Assets/characters/魔法序列帧.png',
  'Assets/characters/武器战斧.png',
  'Assets/characters/法杖.png',
  'Assets/characters/轻剑.png',
  'Assets/characters/npc房屋.png',
  'Assets/characters/弓箭的箭.png',
  'Assets/npc/学生头男性npc.png',
  'Assets/npc/橘色女性npc.png',
  'Assets/npc/治安官男性npc.png',
  'Assets/npc/红发女性npc.png',
  'Assets/npc/红色男性npc.png',
  'Assets/npc/蓝色男性npc.png',
  'Assets/npc/褐色男性npc.png',
  'Assets/npc/黄色男性npc.png',
];
const hits = [];
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    if (['android', 'apk', '_attic', '_sources'].includes(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) { walk(full); continue; }
    if (!/\.(tscn|tres|gd|import|cfg)$/.test(e.name)) continue;
    const text = readFileSync(full, 'utf8');
    const bad = olds.filter((o) => text.includes(o));
    if (bad.length === 0) continue;
    const lines = text.split(/\r?\n/);
    const detail = [];
    for (let i = 0; i < lines.length; i += 1) {
      for (const o of bad) {
        if (lines[i].includes(o)) detail.push(`${i + 1}: ${lines[i].trim().slice(0, 160)}`);
      }
    }
    hits.push({ file: relative(root, full).split(SLASH).join('/'), bad, detail: detail.slice(0, 4) });
  }
}
walk(root);
console.log('stale files:', hits.length);
for (const h of hits.slice(0, 25)) {
  console.log(`- ${h.file}`);
  h.detail.forEach((d) => console.log(`    ${d}`));
}
