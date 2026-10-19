// Capture UI screenshots for the repository README using the built app.
// Drives a headless Chrome over CDP with real mouse clicks, writes PNGs to docs/screenshots.
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, readdir, rm, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.env.SHOT_URL || 'http://127.0.0.1:4173/';
const OUT = 'D:/XYP/whaleflow-v4/docs/screenshots';
await mkdir(OUT, {recursive: true});
for (const name of await readdir(OUT)) await rm(path.join(OUT, name), {force: true});

const profile = await mkdtemp(path.join(tmpdir(), 'wf-shot-'));
const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--force-device-scale-factor=2',
  '--remote-debugging-port=0', '--user-data-dir=' + profile, '--window-size=1440,900', URL,
], {stdio: 'ignore'});

let portText = null;
for (let i = 0; i < 120 && !portText; i++) {
  try { portText = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8'); } catch { await sleep(150); }
}
if (!portText) { child.kill(); throw Error('no debug port'); }
const [port, endpoint] = portText.trim().split(/\r?\n/);
const socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
await new Promise((res, rej) => { socket.addEventListener('open', res, {once: true}); socket.addEventListener('error', rej, {once: true}); });
let seq = 0;
const pending = new Map();
socket.addEventListener('message', e => {
  const m = JSON.parse(String(e.data));
  if (!m.id) return;
  const p = pending.get(m.id); if (!p) return;
  pending.delete(m.id);
  m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, {resolve, reject});
  socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
  setTimeout(() => { if (pending.delete(id)) reject(Error('timeout ' + method)); }, 20000);
});
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let sessionId;
try {
  const {targetInfos} = await send('Target.getTargets');
  const page = targetInfos.find(t => t.type === 'page' && t.url.startsWith(URL.slice(0, 20)));
  ({sessionId} = await send('Target.attachToTarget', {targetId: page.targetId, flatten: true}));
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}, sessionId);
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const click = async selector => {
    const point = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('missing ${selector}');const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {type, x: point.x, y: point.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1}, sessionId);
    }
    await sleep(600);
  };
  const shot = async name => {
    const r = await send('Page.captureScreenshot', {format: 'png', fromSurface: true, captureBeyondViewport: false}, sessionId);
    await writeFile(path.join(OUT, name), Buffer.from(r.data, 'base64'));
    console.log('shot', name);
  };

  await evaluate('new Promise(r=>setTimeout(r,2200))');
  await send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 2, mobile: false}, sessionId);
  await sleep(800);
  await shot('01-canvas.png');

  await click('.dock-main .icon-button:first-child');
  await shot('02-add-menu.png');

  await evaluate(`(()=>{const b=[...document.querySelectorAll('.palette-row')].find(x=>x.textContent.includes('图片'));if(b)b.click();return true;})()`);
  await sleep(900);
  await shot('03-image-node.png');

  await click('.dock-main .icon-button:first-child');
  await evaluate(`(()=>{const b=[...document.querySelectorAll('.palette-row')].find(x=>x.textContent.includes('导演台'));if(b)b.click();return true;})()`);
  await sleep(900);
  await click('[data-testid="open-director"]');
  await sleep(1600);
  await shot('04-director.png');

  await click('[aria-label="关闭导演舞台"]');
  await sleep(700);
  await click('.view-toggle .icon-button:nth-child(2)');
  await sleep(900);
  await shot('05-storyboard.png');
} finally {
  socket.close(); child.kill();
  await sleep(400);
  await rm(profile, {recursive: true, force: true, maxRetries: 5}).catch(() => {});
}
