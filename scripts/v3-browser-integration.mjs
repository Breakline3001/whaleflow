// WhaleFlow 0.3 real Chrome acceptance. Explicit isolated fixture, NOT Native WebMessage/dialogs.
// Run only after the parent has built dist: node scripts/v3-browser-integration.mjs
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {watch} from 'node:fs';
import {mkdir,mkdtemp,readFile,writeFile,rm,readdir,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {WorkflowEngine} from '../lib/workflow.mjs';
import {readProject,writeProject,validateProject} from '../lib/project.mjs';
import {createDefaultModelSettings,validateModelSettings} from '../lib/model-settings-schema.mjs';
import {runSettingsAcceptance,runCanvasAcceptance} from './v3-settings-acceptance.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const artifacts=path.join(root,'artifacts'),dist=path.join(root,'dist');
const screenshotFile=path.join(artifacts,'browser-integration.png');
const reportFile=path.join(artifacts,'browser-integration.report.json');
const chromeExecutable=process.env.WHALEFLOW_CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const createdAt=new Date().toISOString();
const log=message=>console.log(`[V3_BROWSER_TEST] ${message}`);
const clone=value=>structuredClone(value);
const timeout=(promise,milliseconds,label)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timed out after ${milliseconds}ms`)),milliseconds);})]).finally(()=>clearTimeout(timer));};
async function distManifest(directory=dist) {
  const files=[];
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    const absolute=path.join(directory,entry.name);
    if(entry.isDirectory())files.push(...await distManifest(absolute));
    else if(entry.isFile()){const bytes=await readFile(absolute);files.push({path:path.relative(dist,absolute).split(path.sep).join('/'),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
  }
  return files.sort((a,b)=>a.path.localeCompare(b.path));
}
class CDP {
  #socket;#id=0;#pending=new Map();#listeners=new Set();
  constructor(socket) {
    this.#socket=socket;
    socket.addEventListener('message',event=>{const m=JSON.parse(String(event.data));if(m.id){const p=this.#pending.get(m.id);if(!p)return;this.#pending.delete(m.id);m.error?p.reject(new Error(`CDP ${p.method}: ${m.error.message}`)):p.resolve(m.result);}else for(const listener of this.#listeners)listener(m);});
    socket.addEventListener('close',()=>{for(const p of this.#pending.values())p.reject(new Error(`CDP closed during ${p.method}`));this.#pending.clear();});
  }
  static async connect(url) {
    const socket=new WebSocket(url);await timeout(new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',()=>reject(new Error('Cannot connect to freshly launched Chrome CDP')),{once:true});}),10_000,'CDP connection');return new CDP(socket);
  }
  onEvent(listener){this.#listeners.add(listener);return()=>this.#listeners.delete(listener);}
  send(method,params={},sessionId){const id=++this.#id;return timeout(new Promise((resolve,reject)=>{this.#pending.set(id,{method,resolve,reject});try{this.#socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));}catch(error){this.#pending.delete(id);reject(error);}}),20_000,method).finally(()=>this.#pending.delete(id));}
  close(){this.#socket.close();}
}
// Only observe DevToolsActivePort inside the newly-created fixture profile. Never discover user browsers.
function watchDevToolsPort(profile) {
  let watcher,timer,settled=false,rejectPromise;
  const promise=new Promise((resolve,reject)=>{rejectPromise=reject;const inspect=async()=>{if(settled)return;try{const [port,endpoint]=(await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/);if(!/^\d+$/.test(port)||!endpoint?.startsWith('/devtools/browser/'))return;settled=true;watcher.close();clearTimeout(timer);resolve(`ws://127.0.0.1:${port}${endpoint}`);}catch(error){if(error.code!=='ENOENT'&&!settled){settled=true;watcher?.close();clearTimeout(timer);reject(error);}}};watcher=watch(profile,(_event,name)=>{if(!name||String(name)==='DevToolsActivePort')void inspect();});timer=setTimeout(()=>{settled=true;watcher.close();reject(new Error('Fresh Chrome profile did not create DevToolsActivePort'));},20_000);void inspect();});
  promise.catch(()=>{});return {promise,cancel(){watcher?.close();clearTimeout(timer);if(!settled){settled=true;rejectPromise(new Error('Chrome readiness cancelled'));}}};
}
const bridgeSource=`(()=>{
  const pending=new Map(),listeners=new Set();let sequence=0,isolatedClipboard='',eventCount=0;
  // Block native clipboard defaults even if an input accidentally owns focus.
  addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&['c','v','x'].includes(event.key.toLowerCase()))event.preventDefault();},true);
  for(const type of ['copy','cut','paste'])addEventListener(type,event=>event.preventDefault(),true);
  Object.defineProperty(navigator,'clipboard',{configurable:false,value:Object.freeze({writeText:async value=>{isolatedClipboard=String(value);},readText:async()=>isolatedClipboard})});
  Object.defineProperty(window,'__whaleFixtureClipboardReadback',{value:()=>isolatedClipboard});
  Object.defineProperty(window,'__whaleFixtureEventCount',{value:()=>eventCount});
  const call=(method,args=[])=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});window.__whaleHostInvoke(JSON.stringify({id,method,args}));});
  window.__whaleBrowserResolve=({id,result,error})=>{const p=pending.get(id);if(!p)return;pending.delete(id);if(error){const e=new Error(error.message);if(error.code)e.code=error.code;if(error.currentRevision!==undefined)e.currentRevision=error.currentRevision;p.reject(e);}else p.resolve(result);};
  const events=new EventSource('/fixture-events');events.onmessage=message=>{const event=JSON.parse(message.data);eventCount++;for(const callback of [...listeners])callback(event);};
  Object.defineProperty(window,'__whaleFixtureSSEReady',{get:()=>events.readyState===EventSource.OPEN});
  Object.defineProperty(window,'desktop',{value:Object.freeze({
    openProject:()=>call('openProject'),saveProject:(project,saveAs=false)=>call('saveProject',[project,saveAs]),
    autosave:project=>call('autosave',[project]),restoreAutosave:()=>call('restoreAutosave'),
    importMedia:()=>call('importMedia'),runWorkflow:(project,config)=>call('runWorkflow',[project,config]),cancelWorkflow:()=>call('cancelWorkflow'),getAppInfo:()=>call('getAppInfo'),
    onWorkflowEvent:callback=>{if(typeof callback!=='function')throw new TypeError('callback required');listeners.add(callback);return()=>listeners.delete(callback);},
    getModelSettings:()=>call('getModelSettings'),saveModelSettings:request=>call('saveModelSettings',[request]),
    configureModelCredential:(providerId,revision,action)=>call('configureModelCredential',[providerId,revision,action]),
    listProviderModels:request=>call('listProviderModels',[request]),cancelProviderModels:requestId=>call('cancelProviderModels',[requestId])
  }),configurable:false});
})()`;

await mkdir(artifacts,{recursive:true});
// Observe old report before any replacement. Never import or merge old 0.2 PASS evidence.
try {await readFile(reportFile,'utf8');log('Observed existing report; it will be replaced, never reused.');}catch(error){if(error.code!=='ENOENT')throw error;}
const temporary=await mkdtemp(path.join(artifacts,'v3-browser-test-'));
const profile=path.join(temporary,'profile'),autosaveFile=path.join(temporary,'autosave.json'),settingsFile=path.join(temporary,'fixture-model-settings.json'),savedFile=path.join(temporary,'v3-export.project.json');
await mkdir(profile);
let server,chrome,chromeExit,cdp,targetSession,readiness,engine;
let stopping=false,autosaveQueue=Promise.resolve(),settingsQueue=Promise.resolve(),manifestBefore=[],manifestAfter=[];
let modelSnapshot={revision:0,document:createDefaultModelSettings(),credentials:{}};
const fixture={metadataDeferred:false,credentialCancel:false};
const metadataRequests=new Map(),sseClients=new Set(),autosaveListeners=new Set();
const state={events:[],saves:0,opens:0,autosaves:0,restores:0,runs:0,settingsReads:0,settingsSaves:0,metadataCancels:0,lastAutosave:null,exceptions:[],bridgeErrors:[],expectedErrors:[],evidence:[]};
async function persistSettings(){const next=settingsFile+'.tmp';await writeFile(next,JSON.stringify(modelSnapshot,null,2));await rename(next,settingsFile);}
await persistSettings();
function cas(expected){if(expected!==modelSnapshot.revision){const error=new Error('REVISION_CONFLICT');error.code='REVISION_CONFLICT';error.currentRevision=modelSnapshot.revision;throw error;}}
function settingsTransaction(action){const result=settingsQueue.then(action);settingsQueue=result.catch(()=>{});return result;}
function waitForAutosave(predicate,label){if(state.lastAutosave&&predicate(state.lastAutosave))return Promise.resolve(state.lastAutosave);let listener;const pending=new Promise(resolve=>{listener=snapshot=>{if(predicate(snapshot))resolve(snapshot);};autosaveListeners.add(listener);});return timeout(pending,20_000,label).finally(()=>autosaveListeners.delete(listener));}
async function evaluate(expression,options={}){const r=await cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true,...options},targetSession);if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;}
async function waitFor(expression,label,milliseconds=15_000){return evaluate(`new Promise((resolve,reject)=>{let timer,frame;const clean=()=>{observer.disconnect();clearTimeout(timer);cancelAnimationFrame(frame);document.removeEventListener('load',check,true);document.removeEventListener('error',check,true);};const check=()=>{try{if(Boolean(${expression})){clean();resolve(true);return;}}catch(error){clean();reject(error);return;}frame=requestAnimationFrame(check);};const observer=new MutationObserver(()=>{});observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});document.addEventListener('load',check,true);document.addEventListener('error',check,true);timer=setTimeout(()=>{clean();reject(new Error(${JSON.stringify(`UI wait failed: ${label}`)}));},${milliseconds});check();})`);}
async function screenshot(file){const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true},targetSession);await writeFile(file,Buffer.from(shot.data,'base64'));}
async function releaseMetadata(){for(const [id,request] of metadataRequests){request.resolve({requestId:id,providerId:request.providerId,settingsRevision:request.revision,source:'metadata',models:[{id:'v3-fixture-candidate',name:'V3 Fixture Candidate'}]});metadataRequests.delete(id);}await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');}
async function handleBinding(event) {
  let request;
  try {
    request=JSON.parse(event.payload);const args=request.args||[];let result;
    switch(request.method) {
      case 'getAppInfo':result={version:'0.3.0-browser-fixture',platform:process.platform};break;
      case 'getModelSettings':await settingsQueue;state.settingsReads++;result=clone(modelSnapshot);break;
      case 'saveModelSettings':result=await settingsTransaction(async()=>{
        cas(args[0]?.expectedRevision);const document=validateModelSettings(args[0]?.document);const credentials={};
        for(const provider of document.providers){const old=modelSnapshot.document.providers.find(p=>p.id===provider.id);credentials[provider.id]={configured:Boolean(modelSnapshot.credentials[provider.id]?.configured&&old?.baseUrl===provider.baseUrl&&old?.protocol===provider.protocol&&old?.auth===provider.auth),source:'none'};credentials[provider.id].source=credentials[provider.id].configured?'saved':'none';}
        modelSnapshot={revision:modelSnapshot.revision+1,document,credentials};await persistSettings();state.settingsSaves++;return clone(modelSnapshot);
      });break;
      case 'configureModelCredential':result=await settingsTransaction(async()=>{
        cas(args[1]);const provider=modelSnapshot.document.providers.find(p=>p.id===args[0]);assert.ok(provider,'Unknown credential provider');assert.ok(['set','clear'].includes(args[2]));
        if(fixture.credentialCancel)return {...clone(modelSnapshot),cancelled:true};
        // Deliberate status-only fake: no password window, no secret, no DPAPI, no provider request.
        modelSnapshot={...modelSnapshot,revision:modelSnapshot.revision+1,credentials:{...modelSnapshot.credentials,[provider.id]:{configured:args[2]==='set',source:args[2]==='set'?'saved':'none'}}};await persistSettings();return clone(modelSnapshot);
      });break;
      case 'listProviderModels':{
        const value=args[0];cas(value.expectedRevision);assert.ok(modelSnapshot.document.providers.some(p=>p.id===value.providerId));
        if(fixture.metadataDeferred)result=await new Promise(resolve=>metadataRequests.set(value.requestId,{resolve,providerId:value.providerId,revision:modelSnapshot.revision}));
        else result={requestId:value.requestId,providerId:value.providerId,settingsRevision:modelSnapshot.revision,source:'metadata',models:[{id:'v3-fixture-candidate',name:'V3 Fixture Candidate'}]};break;
      }
      case 'cancelProviderModels':state.metadataCancels++;result={cancelled:true};break; // Retain deferred answer to exercise stale-result guard.
      case 'restoreAutosave':await autosaveQueue;try{result=await readProject(autosaveFile);}catch(error){if(error.code!=='ENOENT')throw error;result=null;}state.restores++;break;
      case 'autosave':{
        const snapshot=clone(validateProject(args[0]));assert.equal(Object.hasOwn(snapshot,'settings'),false,'V3 autosave must not contain application settings');
        const next=autosaveQueue.then(()=>writeProject(autosaveFile,snapshot));autosaveQueue=next.catch(()=>{});await next;state.autosaves++;state.lastAutosave=snapshot;for(const listener of autosaveListeners)listener(snapshot);break;
      }
      case 'saveProject':await writeProject(savedFile,args[0]);state.saves++;result={filePath:savedFile};break;
      case 'openProject':result={project:await readProject(savedFile),filePath:savedFile};state.opens++;break;
      case 'importMedia':result=null;break;
      case 'runWorkflow':
        assert.deepEqual(Object.keys(args[1]||{}),['settingsRevision']);cas(args[1].settingsRevision);
        assert.ok(args[0].nodes.every(n=>['prompt','note','output','group','asset'].includes(n.data.kind)||n.data.provider==='demo'||n.data.manual===true||n.data.textMode==='manual'),'Only explicit offline Demo/manual/pass-through nodes may run in browser fixture');
        state.runs++;result=engine.runConfigured(args[0],{revision:modelSnapshot.revision,document:clone(modelSnapshot.document),credentials:{}});break;
      case 'cancelWorkflow':await engine.cancel();break;
      default:throw new Error(`Unknown browser fixture method ${request.method}`);
    }
    await evaluate(`window.__whaleBrowserResolve(${JSON.stringify({id:request.id,result})})`,{contextId:event.executionContextId});
  }catch(error){
    if(error.code==='REVISION_CONFLICT'&&request?.method==='saveModelSettings')state.expectedErrors.push({method:request.method,code:error.code,currentRevision:error.currentRevision});
    else state.bridgeErrors.push(error.message);
    if(request)await evaluate(`window.__whaleBrowserResolve(${JSON.stringify({id:request.id,error:{message:error.message,code:error.code,currentRevision:error.currentRevision}})})`,{contextId:event.executionContextId}).catch(()=>{});else throw error;
  }
}
async function reload(){let stop;const loaded=new Promise(resolve=>{stop=cdp.onEvent(message=>{if(message.sessionId===targetSession&&message.method==='Page.loadEventFired'){stop();resolve();}});});try{await cdp.send('Page.reload',{ignoreCache:true},targetSession);await timeout(loaded,15_000,'Page reload');}finally{stop();}await waitFor(`document.querySelector('[data-testid="app-ready"]')`,'V3 ready after disk restore');await waitFor('window.__whaleFixtureSSEReady','fixture SSE connected');}
const signalHandler=()=>{process.exitCode=1;void cleanup();};process.once('SIGINT',signalHandler);process.once('SIGTERM',signalHandler);
async function cleanup(){
  if(stopping)return;stopping=true;process.removeListener('SIGINT',signalHandler);process.removeListener('SIGTERM',signalHandler);readiness?.cancel();
  for(const [id,request] of metadataRequests)request.resolve({requestId:id,providerId:request.providerId,settingsRevision:request.revision,source:'metadata',models:[]});metadataRequests.clear();
  await engine?.cancel().catch(()=>{});await autosaveQueue.catch(()=>{});await settingsQueue.catch(()=>{});
  if(cdp)await timeout(cdp.send('Browser.close'),1500,'Browser.close').catch(()=>{});if(chrome&&chrome.exitCode===null&&chrome.signalCode===null)chrome.kill();if(chromeExit)await timeout(chromeExit,4000,'Chrome termination').catch(()=>{});cdp?.close();
  for(const client of sseClients)client.end();sseClients.clear();if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await rm(temporary,{recursive:true,force:true}).catch(error=>log(`fixture-cleanup: ${error.message}`));
}
const report={version:'0.3.0',ok:false,passed:false,errors:[],createdAt,evidence:state.evidence,distManifest:[],scope:'isolated fresh Chrome + exact14 explicit fixture + real WorkflowEngine.runConfigured + real localhost SSE + real project files; NOT Native WebMessage',fixtureScope:{settings:'controlled in-memory CAS, atomically persisted in fixture-specific temporary directory; NOT Native DPAPI',credential:'status-only fake set/clear/cancel; NOT Native password dialog, no secret, no provider authentication',metadata:'synthetic candidates/deferred cancellation; NOT live supplier metadata',cas:'test-only Node fixture revision bump; no additional public desktop methods'},clipboard:{implementation:'isolated per-page in-memory fixture',osClipboard:'never read or modified; NOT TESTED'},input:'trusted CDP Input mouse/wheel/key/insertText; Runtime.evaluate only DOM/fixture observations and frame synchronization'};
try {
  log('0.3 fresh-profile browser acceptance; fixture credential/metadata only, no real supplier calls');
  await readFile(path.join(dist,'index.html'));manifestBefore=await distManifest();assert.ok(manifestBefore.some(f=>f.path==='index.html'));
  server=createServer(async(req,res)=>{try{
    const pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
    if(pathname==='/fixture-events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});res.write(': fixture ready\n\n');sseClients.add(res);req.on('close',()=>sseClients.delete(res));return;}
    const file=path.resolve(dist,`.${pathname==='/'?'/index.html':pathname}`),relative=path.relative(dist,file);if(relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw new Error('Forbidden path');const bytes=await readFile(file);const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'}[path.extname(file)]||'application/octet-stream';res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-store'});res.end(bytes);
  }catch{res.writeHead(404);res.end('Not found');}});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const origin=`http://127.0.0.1:${server.address().port}`;
  readiness=watchDevToolsPort(profile);
  // Windows sandbox prohibits captured child pipes. Preserve inherited stdio, never retry via pipe tricks.
  chrome=spawn(chromeExecutable,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--hide-scrollbars','--window-size=1512,980','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',`--user-data-dir=${profile}`,'about:blank'],{stdio:'inherit',windowsHide:false});
  chromeExit=new Promise(resolve=>{chrome.once('exit',(code,signal)=>resolve({code,signal}));chrome.once('error',error=>resolve({error}));});
  const debuggerUrl=await Promise.race([readiness.promise,chromeExit.then(result=>{throw new Error(`Fresh Chrome exited before readiness: ${result.error?.message||JSON.stringify(result)}`);})]);
  cdp=await CDP.connect(debuggerUrl);const {targetId}=await cdp.send('Target.createTarget',{url:'about:blank'});({sessionId:targetSession}=await cdp.send('Target.attachToTarget',{targetId,flatten:true}));
  cdp.onEvent(message=>{if(message.sessionId!==targetSession)return;if(message.method==='Runtime.bindingCalled'&&message.params.name==='__whaleHostInvoke')void handleBinding(message.params).catch(error=>state.bridgeErrors.push(error.message));if(message.method==='Runtime.exceptionThrown')state.exceptions.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);});
  engine=new WorkflowEngine({fetchImpl:async()=>{throw new Error('V3_BROWSER_TEST forbids all real model network calls');},onEvent(event){state.events.push(event);for(const client of sseClients)client.write(`data: ${JSON.stringify(event)}\n\n`);},onError(error){state.bridgeErrors.push(error.message);}});
  await cdp.send('Runtime.enable',{},targetSession);await cdp.send('Page.enable',{},targetSession);await cdp.send('Runtime.addBinding',{name:'__whaleHostInvoke'},targetSession);await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:bridgeSource},targetSession);await cdp.send('Emulation.setDeviceMetricsOverride',{width:1512,height:980,deviceScaleFactor:1,mobile:false},targetSession);
  let stop;const loaded=new Promise(resolve=>{stop=cdp.onEvent(message=>{if(message.sessionId===targetSession&&message.method==='Page.loadEventFired'){stop();resolve();}});});try{const navigation=await cdp.send('Page.navigate',{url:`${origin}/`},targetSession);if(navigation.errorText)throw new Error(navigation.errorText);await timeout(loaded,15_000,'initial Page.loadEventFired');}finally{stop();}
  await waitFor(`document.querySelector('[data-testid="app-ready"]')`,'V3 initial ready');await waitFor('window.__whaleFixtureSSEReady','fixture SSE initial connection');
  const context={state,fixture,log,evaluate,waitFor,waitForAutosave,reload,engine,send:(method,params)=>cdp.send(method,params,targetSession),savedFile,autosaveFile,artifacts,screenshotFile,screenshot,readProject,readFile,writeFile,flushAutosave:()=>autosaveQueue,settingsDisk:async()=>{await settingsQueue;return JSON.parse(await readFile(settingsFile,'utf8'));},settingsSnapshot:()=>clone(modelSnapshot),releaseMetadata,bumpRevision:()=>settingsTransaction(async()=>{modelSnapshot={...modelSnapshot,revision:modelSnapshot.revision+1};await persistSettings();})};
  const settings=await runSettingsAcceptance(context);await runCanvasAcceptance(context,settings);
  assert.ok(state.evidence.length>=28,'V3 requires at least 28 newly executed evidence assertions');assert.equal(new Set(state.evidence.map(e=>e.name)).size,state.evidence.length,'Duplicate PASS names');assert.equal(state.exceptions.length,0,`Renderer errors: ${state.exceptions.join('; ')}`);assert.equal(state.bridgeErrors.length,0,`Unexpected fixture errors: ${state.bridgeErrors.join('; ')}`);
  manifestAfter=await distManifest();assert.deepEqual(manifestAfter,manifestBefore,'dist changed during browser acceptance; evidence would be stale');report.ok=true;report.distManifest=manifestAfter;report.distUnchangedDuringRun=true;
  log(`PASS ${state.evidence.length} new evidence assertions; settings screenshot: ${screenshotFile}`);
}catch(error){process.exitCode=1;report.errors.push(error.stack||String(error));console.error('[V3_BROWSER_TEST] FAIL',error.stack||error);if(cdp&&targetSession){try{report.failureDOM=await evaluate(`(()=>({ready:Boolean(document.querySelector('[data-testid="app-ready"]')),title:String(document.title),visibleNodeCount:document.querySelectorAll('.workflow-node').length,settingsStatus:document.querySelector('[data-testid="settings-save-status"]')?.textContent,settingsError:document.querySelector('[data-testid="settings-error"]')?.textContent}))()`);}catch(diagnostic){report.errors.push(`Diagnostic: ${diagnostic.message}`);}try{await screenshot(path.join(artifacts,'v3-browser-integration.failure.png'));}catch(shotError){report.errors.push(`Screenshot: ${shotError.message}`);}}try{report.distManifest=await distManifest();}catch(manifestError){report.errors.push(`Dist manifest: ${manifestError.message}`);}
}finally{
  report.completedAt=new Date().toISOString();report.errors.push(...state.bridgeErrors,...state.exceptions);if(report.errors.length)report.ok=false;report.passed=report.ok;
  report.counts={evidence:state.evidence.length,runs:state.runs,successfulNodes:state.events.filter(e=>e.status==='success').map(e=>e.nodeId),saves:state.saves,opens:state.opens,autosaves:state.autosaves,restores:state.restores,settingsReads:state.settingsReads,settingsSaves:state.settingsSaves,metadataCancels:state.metadataCancels};report.expectedErrors=state.expectedErrors;
  // Existing report was read at startup; this report contains only assertions from this run.
  await writeFile(reportFile,JSON.stringify(report,null,2));await cleanup();log(`Report: ${reportFile}; ok=${report.ok}`);
}
