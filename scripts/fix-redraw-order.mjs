// redrawShot was declared before `run`, so its useCallback dependency array hit the
// temporal dead zone and the app failed to boot. Move it below run as a plain function.
import {readFile, writeFile} from 'node:fs/promises';
const file = 'D:/XYP/whaleflow-v4/src/App.jsx';
let text = await readFile(file, 'utf8');
const start = text.indexOf(' const redrawShot=useCallback(');
const endMarker = ' },[run,notify]);\n';
const end = text.indexOf(endMarker, start);
if (start < 0 || end < 0) throw Error('redrawShot block not found');
text = text.slice(0, start) + text.slice(end + endMarker.length);
const runAt = text.indexOf(' const run=useCallback(');
if (runAt < 0) throw Error('run block not found');
const runEnd = text.indexOf(']);\n', runAt);
if (runEnd < 0) throw Error('run block end not found');
const insertAt = runEnd + ']);\n'.length;
const block = ` const redrawShot=async taskId=>{
  if(runningRef.current)throw Error('已有任务执行中');
  const task=projectRef.current.nodes.find(n=>n.id===taskId);
  if(!task){notify('找不到该镜头的任务节点',true);return;}
  await run([taskId]);
 };
`;
text = text.slice(0, insertAt) + block + text.slice(insertAt);
await writeFile(file, text);
console.log('redrawShot moved below run');
