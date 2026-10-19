'use strict';
const path = require('node:path');
const os = require('node:os');
const { mkdtempSync } = require('node:fs');
const { mkdir, writeFile } = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');

function configureSmokeUserData(app) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'whaleflow-smoke-'));
  app.setPath('userData', directory);
  app.setPath('sessionData', directory);
  return directory;
}

function requireCondition(value, message) { if (!value) throw new Error(message); }

async function probeUntil(contents, script, predicate, attempts = 100) {
  let result;
  for (let i = 0; i < attempts; i++) {
    result = await contents.executeJavaScript(script);
    if (predicate(result)) return result;
    await delay(50);
  }
  throw new Error(`renderer-probe timeout: ${JSON.stringify(result)}`);
}

async function runSmokeIntegration({ app, window, engine, events, screenshotPath }) {
  const contents = window.webContents;
  await probeUntil(contents,
    `({ready:document.readyState,desktop:typeof window.desktop?.runWorkflow==='function',root:!!document.getElementById('root')?.children.length,button:!!document.querySelector('.top-actions .run-button'),nodes:document.querySelectorAll('.workflow-node').length})`,
    (result) => result.ready === 'complete' && result.desktop && result.root && result.button && result.nodes > 0);
  console.log('[WHALEFLOW_SMOKE] renderer-loaded preload-available root-mounted');

  const started = await contents.executeJavaScript(`(() => {
    const button=document.querySelector('.top-actions .run-button');
    if(!button || !button.textContent.includes('运行工作流')) throw new Error('demo run button unavailable');
    if(!document.querySelector('.mode-badge')?.textContent.includes('演示模式')) throw new Error('smoke must run in explicit demo mode');
    window.__WHALEFLOW_SMOKE_EVENTS__=[];
    window.__WHALEFLOW_SMOKE_UNSUBSCRIBE__=window.desktop.onWorkflowEvent(event=>window.__WHALEFLOW_SMOKE_EVENTS__.push(event));
    const count=document.querySelectorAll('.workflow-node').length;
    button.click();
    return {count};
  })()`);
  const completed = await probeUntil(contents,
    `(() => { const events=window.__WHALEFLOW_SMOKE_EVENTS__||[];const image=document.querySelector('.kind-output img');return {success:[...new Set(events.filter(e=>e.status==='success').map(e=>e.nodeId))].length,errors:events.filter(e=>e.status==='error'||e.status==='cancelled').map(e=>e.error),demo:events.filter(e=>e.status==='success'&&e.output?.image).every(e=>e.output.demo===true),image:!!image&&image.complete&&image.naturalWidth>0,button:document.querySelector('.top-actions .run-button')?.textContent||'',eventCount:events.length}; })()`,
    (result) => result.errors.length > 0 || (result.success === started.count && result.image && result.button.includes('运行工作流')));
  requireCondition(completed.errors.length === 0, `demo run failed: ${completed.errors.join('; ')}`);
  requireCondition(completed.demo, 'generated smoke image must be marked demo');
  const mainSuccess = new Set(events.filter((event) => event.status === 'success').map((event) => event.nodeId));
  requireCondition(mainSuccess.size === started.count, 'main process event count mismatch');
  await engine.waitForIdle();
  console.log(`[WHALEFLOW_SMOKE] demo-workflow-success nodes=${mainSuccess.size} ipc-events=${completed.eventCount} output-image-loaded button-reset`);

  // Let the UI's debounced autosave settle before a deterministic public-bridge roundtrip.
  await delay(1100);
  const bridge = await contents.executeJavaScript(`(async () => {
    const info=await window.desktop.getAppInfo();
    const before=await window.desktop.restoreAutosave();
    const probe={version:1,name:'WhaleFlow smoke autosave',nodes:[],edges:[],viewport:{x:7,y:11,zoom:1}};
    await window.desktop.autosave(probe);
    const restored=await window.desktop.restoreAutosave();
    let invalidRejected=false;
    try {await window.desktop.autosave({...probe,version:999});} catch {invalidRejected=true;}
    if(before) await window.desktop.autosave(before);
    window.__WHALEFLOW_SMOKE_UNSUBSCRIBE__?.();
    delete window.__WHALEFLOW_SMOKE_UNSUBSCRIBE__;delete window.__WHALEFLOW_SMOKE_EVENTS__;
    return {info,roundtrip:JSON.stringify(restored)===JSON.stringify(probe),invalidRejected};
  })()`);
  requireCondition(bridge.info?.version === app.getVersion() && bridge.info?.platform === process.platform, 'preload appInfo mismatch');
  requireCondition(bridge.roundtrip && bridge.invalidRejected, 'autosave bridge roundtrip/validation failed');
  console.log('[WHALEFLOW_SMOKE] preload-appInfo autosave-restore invalid-project-rejected');
  if (screenshotPath) {
    requireCondition(path.isAbsolute(screenshotPath) && path.extname(screenshotPath).toLowerCase() === '.png', '--smoke-screenshot must be an absolute PNG path');
    await mkdir(path.dirname(screenshotPath), { recursive: true });
    const image = await contents.capturePage();
    requireCondition(!image.isEmpty(), 'capturePage returned an empty image');
    await writeFile(screenshotPath, image.toPNG());
    console.log(`[WHALEFLOW_SMOKE] screenshot-saved ${screenshotPath}`);
  }
  console.log('[WHALEFLOW_SMOKE] real-ai-services=NOT-TESTED network-disabled');
}

module.exports = { configureSmokeUserData, runSmokeIntegration };
