// Align canvas node default sizes with the live LibTV measurements.
// Evidence: node-layout.json (text 350x200, image 622x350), probe.mjs ratios at zoom 0.42055
// (script-v2 147x147 -> 350x350, video 262x147 -> 622x350, director-console 147x196 -> 350x466).
import {readFile, writeFile} from 'node:fs/promises';
const file = 'D:/XYP/whaleflow-v4/src/catalog.jsx';
let text = await readFile(file, 'utf8');
const targets = {
  text: [350, 200],
  image: [622, 350],
  video: [622, 350],
  script: [350, 350],
  shots: [350, 350],
  director: [350, 466],
};
const changes = [];
for (const [kind, [width, height]] of Object.entries(targets)) {
  const pattern = new RegExp(`(\\b${kind}:\\{[^{}]*?width:)(\\d+)(,height:)(\\d+)`, '');
  if (!pattern.test(text)) { changes.push(`MISS ${kind}`); continue; }
  text = text.replace(pattern, (_, a, oldW, b, oldH) => {
    changes.push(`${kind}: ${oldW}x${oldH} -> ${width}x${height}`);
    return `${a}${width}${b}${height}`;
  });
}
await writeFile(file, text);
console.log(changes.join('\n'));
