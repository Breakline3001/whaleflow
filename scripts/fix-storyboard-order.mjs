// Move generateStoryboard/finishStoryboard above the workflow-event useEffect.
// They were declared after it, so the effect captured them in the temporal dead zone
// and the app failed to boot ("app ready" timeout).
import {readFile, writeFile} from 'node:fs/promises';
const file = 'D:/XYP/whaleflow-v4/src/App.jsx';
let text = await readFile(file, 'utf8');
const startMarker = " const [creativeMode,setCreativeMode]=useState('manual');";
const endMarker = ' },[commit,notify]);\n';
const anchor = ' useEffect(()=>{if(!ready||!window.desktop)return;const handler=event=>{';
const start = text.indexOf(startMarker);
const end = text.indexOf(endMarker, start);
if (start < 0 || end < 0) throw Error('storyboard block not found');
const block = text.slice(start, end + endMarker.length);
text = text.slice(0, start) + text.slice(start + block.length);
const target = text.indexOf(anchor);
if (target < 0) throw Error('useEffect anchor not found');
text = text.slice(0, target) + block + text.slice(target);
await writeFile(file, text);
console.log('moved storyboard block above the event effect; block chars =', block.length);
