// Replace the "list every node" storyboard with a shot-ordered contact sheet:
// one card per storyboard shot, current revision only, with per-shot redraw.
import {readFile, writeFile} from 'node:fs/promises';
const file = 'D:/XYP/whaleflow-v4/src/App.jsx';
const lines = (await readFile(file, 'utf8')).split('\n');
const index = lines.findIndex(line => line.includes('storyboard-view'));
if (index < 0) throw Error('storyboard line not found');
const block = ` {story&&<Storyboard story={project.nodes.find(n=>n.data.creative)} nodes={project.nodes} running={running} onClose={()=>setStory(false)} onRedraw={redrawShot} onCreateShot={()=>addNode('image')}/>}`;
lines[index] = block;
await writeFile(file, lines.join('\n'));
console.log('storyboard replaced at line', index + 1);
