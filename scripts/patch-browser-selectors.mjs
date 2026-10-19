// Point the browser acceptance script at the new director shell class names.
import {readFile,writeFile} from 'node:fs/promises';
const file = 'D:/XYP/whaleflow-v4/scripts/v4-browser-creative-acceptance.mjs';
let text = await readFile(file, 'utf8');
const before = text;
const swaps = [
  [".ds-footer .ds-primary", ".ds-capsule .ds-primary"],
  ["textButton('截图并保存到画布','.ds-footer')", "textButton('截图并保存到画布','.ds-capsule')"],
  ["'.ds-footer span'", "'.ds-capsule span'"],
  ["closest('.creative-side,.creative-main,.ds-controls')", "closest('.creative-side,.creative-main,.ds-list')"],
  ["textButton('＋方盒','.ds-controls')", "textButton('＋方盒','.ds-left')"],
  ["textButton('侧面','.ds-controls')", "textButton('侧面','.ds-right')"],
];
const applied = [];
for (const [from, to] of swaps) {
  if (!text.includes(from)) { applied.push(`MISS ${from}`); continue; }
  const count = text.split(from).length - 1;
  text = text.split(from).join(to);
  applied.push(`ok x${count} ${from}`);
}
if (text === before) throw new Error('no selector was updated');
await writeFile(file, text);
console.log(applied.join('\n'));
