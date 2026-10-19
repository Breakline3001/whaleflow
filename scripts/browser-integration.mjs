// Explicit browser fixture + real local WorkflowEngine. NOT native WebMessage acceptance.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { watch } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowEngine } from '../lib/workflow.mjs';
import { readProject, writeProject, validateProject } from '../lib/project.mjs';
import { runEditorAcceptance, runPersistenceAcceptance } from './v2-browser-acceptance.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(root, 'artifacts'), dist = path.join(root, 'dist');
const chromeExecutable = process.env.WHALEFLOW_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const screenshotFile = path.join(artifacts, 'browser-integration.png');
const savedFile = path.join(artifacts, 'browser-integration.project.json');
const reportFile = path.join(artifacts, 'browser-integration.report.json');
const createdAt = new Date().toISOString();
async function distManifest(directory = dist) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await distManifest(absolute));
    else if (entry.isFile() && /\.(?:m?js|css|html)$/i.test(entry.name)) {
      const bytes = await readFile(absolute);
      files.push({ path: path.relative(dist, absolute).split(path.sep).join('/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
const log = message => console.log(`[BROWSER_TEST] ${message}`);
const timeout = (promise, milliseconds, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds); })]).finally(() => clearTimeout(timer));
};
class CDP {
  #socket; #id = 0; #pending = new Map(); #listeners = new Set();
  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const request = this.#pending.get(message.id); if (!request) return;
        this.#pending.delete(message.id);
        if (message.error) request.reject(new Error(`CDP ${request.method}: ${message.error.message}`));
        else request.resolve(message.result);
      } else for (const listener of this.#listeners) listener(message);
    });
    socket.addEventListener('close', () => { for (const request of this.#pending.values()) request.reject(new Error(`CDP closed during ${request.method}`)); this.#pending.clear(); });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await timeout(new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error(`Cannot connect to isolated Chrome CDP: ${url}`)), { once: true });
    }), 10_000, 'CDP connection');
    return new CDP(socket);
  }
  onEvent(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    return timeout(new Promise((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
      try { this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { this.#pending.delete(id); reject(error); }
    }), 20_000, method).finally(() => this.#pending.delete(id));
  }
  close() { this.#socket.close(); }
}

// Observe only the newly created profile. Never discover or attach to an existing browser.
function watchDevToolsPort(profile) {
  let watcher, timer, settled = false, rejectPromise;
  const promise = new Promise((resolve, reject) => {
    rejectPromise = reject;
    const inspect = async () => {
      if (settled) return;
      try {
        const [port, endpoint] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
        if (!/^\d+$/.test(port) || !endpoint?.startsWith('/devtools/browser/')) return;
        settled = true; watcher.close(); clearTimeout(timer); resolve(`ws://127.0.0.1:${port}${endpoint}`);
      } catch (error) { if (error.code !== 'ENOENT' && !settled) { settled = true; watcher?.close(); clearTimeout(timer); reject(error); } }
    };
    watcher = watch(profile, (_event, name) => { if (!name || String(name) === 'DevToolsActivePort') void inspect(); });
    timer = setTimeout(() => { settled = true; watcher.close(); reject(new Error('Fresh Chrome profile did not create DevToolsActivePort')); }, 20_000);
    void inspect();
  });
  promise.catch(() => {});
  return { promise, cancel() { watcher?.close(); clearTimeout(timer); if (!settled) { settled = true; rejectPromise(new Error('Chrome readiness cancelled')); } } };
}
const bridgeSource = `(() => {
  const pending=new Map(),listeners=new Set();let sequence=0;
  // This per-page in-memory clipboard never reads or changes the user's OS clipboard.
  let isolatedClipboard='';
  // Prevent browser-native editing commands from touching the OS clipboard even if focus is unexpected.
  addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&['c','v','x'].includes(event.key.toLowerCase()))event.preventDefault();},true);
  for(const type of ['copy','cut','paste'])addEventListener(type,event=>event.preventDefault(),true);
  Object.defineProperty(navigator,'clipboard',{configurable:false,value:Object.freeze({
    writeText:async value=>{isolatedClipboard=String(value);},readText:async()=>isolatedClipboard
  })});
  Object.defineProperty(window,'__whaleFixtureClipboardReadback',{value:()=>isolatedClipboard});
  const call=(method,args=[])=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});window.__whaleHostInvoke(JSON.stringify({id,method,args}));});
  window.__whaleBrowserResolve=({id,result,error})=>{const p=pending.get(id);if(!p)return;pending.delete(id);error?p.reject(new Error(error)):p.resolve(result);};
  window.__whaleBrowserEvent=event=>{for(const callback of [...listeners])callback(event);};
  Object.defineProperty(window,'desktop',{value:Object.freeze({
    openProject:()=>call('openProject'),saveProject:(project,saveAs=false)=>call('saveProject',[project,saveAs]),
    autosave:project=>call('autosave',[project]),restoreAutosave:()=>call('restoreAutosave'),
    importMedia:()=>call('importMedia'),runWorkflow:(project,config)=>call('runWorkflow',[project,config]),
    cancelWorkflow:()=>call('cancelWorkflow'),getAppInfo:()=>call('getAppInfo'),
    onWorkflowEvent:callback=>{if(typeof callback!=='function')throw new TypeError('callback required');listeners.add(callback);return()=>listeners.delete(callback);}
  }),configurable:false});
})()`;
await mkdir(artifacts, { recursive: true });
const temporary = await mkdtemp(path.join(artifacts, 'browser-test-'));
const profile = path.join(temporary, 'profile'), autosaveFile = path.join(temporary, 'autosave.json');
await mkdir(profile);
let server, chrome, chromeExit, cdp, targetSession, readiness, engine, executionContextId;
let stopping = false, autosaveQueue = Promise.resolve();
const state = { events: [], saves: 0, opens: 0, autosaves: 0, restores: 0, lastAutosave: null, lastRestoredSettings: null, exceptions: [], bridgeErrors: [], expectedErrors: [], expectOpenFailure: false, evidence: [] };
const autosaveListeners = new Set();
function waitForAutosave(predicate, label) {
  if (state.lastAutosave && predicate(state.lastAutosave)) return Promise.resolve(state.lastAutosave);
  let listener;
  const pending = new Promise(resolve => { listener = snapshot => { if (predicate(snapshot)) resolve(snapshot); }; autosaveListeners.add(listener); });
  return timeout(pending, 20_000, label).finally(() => autosaveListeners.delete(listener));
}
async function evaluate(expression, options = {}) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true, ...options }, targetSession);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
async function waitFor(expression, label, milliseconds = 15_000) {
  return evaluate(`new Promise((resolve,reject)=>{
    let timer;const clean=()=>{observer.disconnect();clearTimeout(timer);document.removeEventListener('load',check,true);document.removeEventListener('error',check,true);};
    const check=()=>{try{const result=Boolean(${expression});if(result){clean();resolve(true);}}catch(error){clean();reject(error);}};
    const observer=new MutationObserver(check);observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
    document.addEventListener('load',check,true);document.addEventListener('error',check,true);
    timer=setTimeout(()=>{clean();reject(new Error(${JSON.stringify(`UI wait failed: ${label}`)}));},${milliseconds});check();
  })`);
}
async function handleBinding(event) {
  let request;
  try {
    request = JSON.parse(event.payload); executionContextId = event.executionContextId;
    const args = request.args || []; let result;
    switch (request.method) {
      case 'getAppInfo': result = { version: 'v2-browser-fixture', platform: process.platform }; break;
      case 'restoreAutosave':
        await autosaveQueue;
        try { result = await readProject(autosaveFile); } catch (error) { if (error.code !== 'ENOENT') throw error; result = null; }
        state.restores++; state.lastRestoredSettings = result?.settings ? structuredClone(result.settings) : null; break;
      case 'autosave': {
        const snapshot = structuredClone(validateProject(args[0]));
        const next = autosaveQueue.then(() => writeProject(autosaveFile, snapshot)); autosaveQueue = next.catch(() => {}); await next;
        state.autosaves++; state.lastAutosave = snapshot; for (const listener of autosaveListeners) listener(snapshot); break;
      }
      case 'saveProject': await writeProject(savedFile, args[0]); state.saves++; result = { filePath: savedFile }; break;
      case 'openProject': result = { project: await readProject(savedFile), filePath: savedFile }; state.opens++; break;
      case 'importMedia': result = null; break;
      case 'runWorkflow':
        assert.equal(args[1]?.provider, 'demo', 'Real provider runs are forbidden');
        assert(args[0].nodes.every(node => !node.data.provider || node.data.provider === 'demo'), 'Real per-node provider runs are forbidden');
        result = engine.run(args[0], args[1]); break;
      case 'cancelWorkflow': await engine.cancel(); break;
      default: throw new Error(`Unknown browser fixture method: ${request.method}`);
    }
    await evaluate(`window.__whaleBrowserResolve(${JSON.stringify({ id: request.id, result })})`, { contextId: event.executionContextId });
  } catch (error) {
    if (state.expectOpenFailure && request?.method === 'openProject') state.expectedErrors.push(error.message);
    else state.bridgeErrors.push(error.message);
    if (request) await evaluate(`window.__whaleBrowserResolve(${JSON.stringify({ id: request.id, error: error.message })})`, { contextId: event.executionContextId }).catch(() => {});
    else throw error;
  }
}
const signalHandler = () => { process.exitCode = 1; void cleanup(); };
process.once('SIGINT', signalHandler); process.once('SIGTERM', signalHandler);
async function cleanup() {
  if (stopping) return; stopping = true;
  process.removeListener('SIGINT', signalHandler); process.removeListener('SIGTERM', signalHandler);
  readiness?.cancel(); await engine?.cancel().catch(() => {}); await autosaveQueue.catch(() => {});
  if (cdp) await timeout(cdp.send('Browser.close'), 1500, 'Browser.close').catch(() => {});
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) chrome.kill();
  if (chromeExit) await timeout(chromeExit, 4000, 'Chrome termination').catch(() => {});
  cdp?.close();
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(temporary, { recursive: true, force: true }).catch(error => log(`temporary-profile-cleanup: ${error.message}`));
}
async function reload() {
  let stop;
  const loaded = new Promise(resolve => { stop = cdp.onEvent(message => { if (message.sessionId === targetSession && message.method === 'Page.loadEventFired') { stop(); resolve(); } }); });
  await cdp.send('Page.reload', { ignoreCache: true }, targetSession);
  await timeout(loaded, 15_000, 'Page reload').finally(() => stop());
  await waitFor(`document.querySelector('[data-testid="app-ready"]')`, 'V2 startup restore complete');
}
try {
  log('V2 BROWSER UI / explicit host fixture / real local WorkflowEngine; NOT native WebMessage; real AI disabled');
  await readFile(path.join(dist, 'index.html'));
  const manifestBefore = await distManifest();
  assert.ok(manifestBefore.some(file => file.path === 'index.html'), 'Dist manifest must include index.html');
  server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      const file = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`), relative = path.relative(dist, file);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Forbidden path');
      const bytes = await readFile(file), mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' }); res.end(bytes);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  readiness = watchDevToolsPort(profile);
  chrome = spawn(chromeExecutable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--window-size=1512,980', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'inherit', windowsHide: false });
  chromeExit = new Promise(resolve => { chrome.once('exit', (code, signal) => resolve({ code, signal })); chrome.once('error', error => resolve({ error })); });
  const debuggerUrl = await Promise.race([readiness.promise, chromeExit.then(result => { throw new Error(`Fresh Chrome exited before readiness: ${result.error?.message || JSON.stringify(result)}`); })]);
  cdp = await CDP.connect(debuggerUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId: targetSession } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  cdp.onEvent(message => {
    if (message.sessionId !== targetSession) return;
    if (message.method === 'Runtime.bindingCalled' && message.params.name === '__whaleHostInvoke') void handleBinding(message.params).catch(error => state.bridgeErrors.push(error.message));
    if (message.method === 'Runtime.exceptionThrown') state.exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  });
  engine = new WorkflowEngine({
    fetchImpl: async () => { throw new Error('BROWSER_TEST forbids all real model network calls'); },
    onEvent(event) { state.events.push(event); if (cdp && executionContextId && !stopping) void evaluate(`window.__whaleBrowserEvent(${JSON.stringify(event)})`, { contextId: executionContextId }).catch(error => state.bridgeErrors.push(error.message)); },
    onError(error) { state.bridgeErrors.push(error.message); },
  });
  await cdp.send('Runtime.enable', {}, targetSession); await cdp.send('Page.enable', {}, targetSession);
  await cdp.send('Runtime.addBinding', { name: '__whaleHostInvoke' }, targetSession);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: bridgeSource }, targetSession);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1512, height: 980, deviceScaleFactor: 1, mobile: false }, targetSession);
  let stopInitialLoad;
  const initialLoaded = new Promise(resolve => {
    stopInitialLoad = cdp.onEvent(message => {
      if (message.sessionId === targetSession && message.method === 'Page.loadEventFired') { stopInitialLoad(); resolve(); }
    });
  });
  try {
    const navigation = await cdp.send('Page.navigate', { url: `${origin}/` }, targetSession);
    if (navigation.errorText) throw new Error(`Initial navigation failed: ${navigation.errorText}`);
    await timeout(initialLoaded, 15_000, 'Initial Page.loadEventFired');
  } finally { stopInitialLoad(); }
  await waitFor(`document.querySelector('[data-testid="app-ready"]')`, 'V2 ready');
  const context = { state, log, evaluate, waitFor, waitForAutosave, reload, engine, send: (method, params) => cdp.send(method, params, targetSession), savedFile, autosaveFile, artifacts, readProject, readFile, writeFile, flushAutosave: () => autosaveQueue };
  const workspaceEvidence = await runEditorAcceptance(context);
  await runPersistenceAcceptance(context, workspaceEvidence);
  assert.equal(state.exceptions.length, 0, `Uncaught renderer errors: ${state.exceptions.join('; ')}`);
  assert.equal(state.bridgeErrors.length, 0, `Unexpected fixture/engine errors: ${state.bridgeErrors.join('; ')}`);
  const image = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true }, targetSession);
  await writeFile(screenshotFile, Buffer.from(image.data, 'base64'));
  const manifestAfter = await distManifest();
  assert.deepEqual(manifestAfter, manifestBefore, 'Dist JS/CSS/HTML changed during browser acceptance; evidence would be stale');
  await writeFile(reportFile, JSON.stringify({ passed: true, createdAt, completedAt: new Date().toISOString(), distManifest: { algorithm: 'sha256', unchangedDuringRun: true, files: manifestAfter }, scope: 'isolated Chrome + explicit fixture bridge + actual local WorkflowEngine; NOT native WebMessage', clipboard: { implementation: 'isolated per-page in-memory browser fixture', nativeOsClipboard: 'NOT TESTED; never read or modified' }, input: 'CDP Input mouse/key/wheel/insertText; Runtime.evaluate only reads DOM/fixture-clipboard state or injects deliberate localStorage corruption', evidence: state.evidence, successfulNodes: state.events.filter(event => event.status === 'success').map(event => event.nodeId), saves: state.saves, opens: state.opens, autosaves: state.autosaves, restores: state.restores, expectedErrors: state.expectedErrors }, null, 2));
  log(`PASS ALL; screenshot: ${screenshotFile}; report: ${reportFile}`);
  log('Real paid APIs, native WebMessage, native dialogs and native packaging are NOT TESTED here');
} catch (error) {
  process.exitCode = 1; console.error('[BROWSER_TEST] FAIL', error.stack || error);
  if (state.bridgeErrors.length) console.error('[BROWSER_TEST] unexpected bridge errors:', state.bridgeErrors);
  if (state.exceptions.length) console.error('[BROWSER_TEST] renderer errors:', state.exceptions);
  if (cdp && targetSession) {
    try {
      const diagnostic = await evaluate(`(() => ({ready:Boolean(document.querySelector('[data-testid="app-ready"]')),title:String(document.title),visibleNodeCount:Number(document.querySelectorAll('.workflow-node').length),documentState:String(document.readyState),url:String(location.href)}))()`);
      log(`failure scalar-only DOM diagnostic: ${JSON.stringify(diagnostic)}`);
    } catch (diagnosticError) { log(`failure DOM diagnostic failed: ${diagnosticError.message}`); }
    try {
      const failureFile = path.join(artifacts, 'browser-integration.failure.png');
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true }, targetSession);
      await writeFile(failureFile, Buffer.from(shot.data, 'base64'));
      log(`failure screenshot: ${failureFile}`);
    } catch (screenshotError) { log(`failure screenshot failed: ${screenshotError.stack || screenshotError.message}`); }
  }
} finally { await cleanup(); }
