// Numeric self-audit: load the built app in headless Chrome and compare rendered
// geometry against the measured LibTV reference values at 1280x665.
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import os from 'node:os';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.env.AUDIT_URL || 'http://127.0.0.1:4173/';
const profile = await mkdtemp(path.join(tmpdir(), 'wf-audit-'));
const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--remote-debugging-port=0', '--user-data-dir=' + profile,
  '--window-size=1280,665', URL,
], {stdio: 'ignore'});

const deadline = Date.now() + 20000;
let portFile = null;
while (Date.now() < deadline) {
  try { portFile = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8'); break; } catch { await new Promise(r => setTimeout(r, 150)); }
}
if (!portFile) { child.kill(); throw Error('Chrome did not expose a debugging port'); }
const [port, endpoint] = portFile.trim().split(/\r?\n/);
const socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, {once: true}); socket.addEventListener('error', reject, {once: true}); });
let seq = 0;
const pending = new Map();
socket.addEventListener('message', event => {
  const message = JSON.parse(String(event.data));
  if (!message.id) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  message.error ? request.reject(Error(message.error.message)) : request.resolve(message.result);
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, {resolve, reject});
  socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
  setTimeout(() => { if (pending.delete(id)) reject(Error('timeout: ' + method)); }, 15000);
});

try {
  const {targetInfos} = await send('Target.getTargets');
  const page = targetInfos.find(t => t.type === 'page' && t.url.startsWith(URL.slice(0, 22)));
  if (!page) throw Error('page target not found');
  const {sessionId} = await send('Target.attachToTarget', {targetId: page.targetId, flatten: true});
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}, sessionId);
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  await evaluate('new Promise(r=>setTimeout(r,1800))');
  const data = await evaluate(`(()=>{
    const box=sel=>{const el=document.querySelector(sel);if(!el)return null;const r=el.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};};
    const all=sel=>[...document.querySelectorAll(sel)].map(el=>{const r=el.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};});
    return {viewport:{w:innerWidth,h:innerHeight},pill:box('.top-left-cluster'),dock:box('.dock-main'),orb:box('.director-orb'),cards:all('.starter-buttons > button'),bottomLeft:box('.bottom-left-controls'),zoom:box('.zoom-value'),ready:Boolean(document.querySelector('[data-testid="app-ready"]'))};
  })()`);

  const expect = {
    pill: {w: 224, h: 32, y: 8},
    dock: {w: 299, h: 44}, orb: {w: 48, h: 48},
    card: {w: 200, h: 56, y: 337}, pitch: 208,
    zoom: {w: 42, h: 28},
  };
  const rows = [];
  const cmp = (label, actual, target) => {
    if (!actual) { rows.push(`${label}: MISSING (expected ${JSON.stringify(target)})`); return; }
    const parts = Object.entries(target).map(([key, want]) => {
      const got = actual[key];
      const ok = Math.abs(got - want) <= 2;
      return `${key}=${got}${ok ? '✓' : `≠${want}`}`;
    });
    rows.push(`${label}: ${parts.join(' ')}`);
  };
  cmp('顶部胶囊', data.pill, expect.pill);
  cmp('底栏', data.dock, expect.dock);
  cmp('导演球', data.orb, expect.orb);
  cmp('缩放钮', data.zoom, expect.zoom);
  if (data.cards.length) {
    cmp('创建卡 #1', data.cards[0], expect.card);
    const pitches = data.cards.slice(1).map((c, i) => c.x - data.cards[i].x);
    rows.push(`创建卡节距: ${pitches.join(', ')}${pitches.every(p => p === expect.pitch) ? '✓' : `≠${expect.pitch}`}`);
    rows.push(`创建卡数量: ${data.cards.length}`);
  } else rows.push('创建卡: MISSING');
  rows.push(`viewport: ${data.viewport.w}x${data.viewport.h} | app-ready: ${data.ready}`);
  console.log(rows.join('\n'));
} finally {
  socket.close();
  child.kill();
  await new Promise(r => setTimeout(r, 300));
  await rm(profile, {recursive: true, force: true, maxRetries: 5}).catch(() => {});
}
