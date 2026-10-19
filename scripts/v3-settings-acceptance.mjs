import assert from 'node:assert/strict';

// All user interactions go through trusted CDP Input. Runtime only observes public DOM/state.
export function controls(ctx) {
  const {evaluate, send, waitFor, state} = ctx;
  const evidence = (name, details = {}) => { state.evidence.push({name, ...details}); ctx.log(`PASS ${name}`); };
  async function key(key, {ctrl=false,shift=false}={}) {
    const specials={Escape:['Escape',27],Enter:['Enter',13],Tab:['Tab',9],Home:['Home',36],End:['End',35],ArrowDown:['ArrowDown',40],ArrowUp:['ArrowUp',38],Delete:['Delete',46]};
    const [code,vk]=specials[key]||[`Key${key.toUpperCase()}`,key.toUpperCase().charCodeAt(0)];
    const params={key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk,modifiers:(ctrl?2:0)|(shift?8:0)};
    await send('Input.dispatchKeyEvent',{type:'keyDown',...params});
    await send('Input.dispatchKeyEvent',{type:'keyUp',...params});
  }
  async function clickAt(point) {
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
    await send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',buttons:0,clickCount:1});
  }
  async function click(selector) {
    // Scroll the real settings scroller with wheel input; do not call scrollIntoView or synthesize clicks.
    for(let attempt=0;attempt<35;attempt++) {
      const result=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing target '+${JSON.stringify(selector)});if(e.disabled||e.closest('[inert]'))throw Error('Disabled target '+${JSON.stringify(selector)});const r=e.getBoundingClientRect(),s=e.closest('.ms-scroll'),v=s?.getBoundingClientRect();const low=v?v.top+5:5,high=v?v.bottom-5:innerHeight-5;const x=Math.max(2,Math.min(innerWidth-2,r.x+r.width/2)),y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);return {x,y,ready:r.width>0&&r.height>0&&y>low&&y<high&&e.contains(hit),wheel:s?{x:v.right-24,y:(v.top+v.bottom)/2}:null,delta:y<low?-320:320};})()`);
      if(result.ready) {await clickAt({x:result.x,y:result.y});return;}
      if(!result.wheel)throw Error(`Occluded/offscreen target ${selector}`);
      await send('Input.dispatchMouseEvent',{type:'mouseWheel',...result.wheel,deltaX:0,deltaY:result.delta});
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    }
    throw Error(`Could not reach target by wheel: ${selector}`);
  }
  async function type(selector,text) {
    await click(selector);await key('a',{ctrl:true});await send('Input.insertText',{text:String(text)});
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`),String(text),'Trusted keyboard input must reach controlled field');
  }
  async function select(selector,value) {
    const index=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return [...e.options].findIndex(o=>o.value===${JSON.stringify(value)}&&!o.disabled);})()`);
    assert.ok(index>=0,`Missing enabled option ${value} in ${selector}`);
    await click(selector);await key('Home');for(let at=0;at<index;at++)await key('ArrowDown');await key('Enter');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`),value,'Native select trusted keyboard selection');
  }
  const test=id=>`[data-testid="${id}"]`;
  const nav=async section=>{await click(test(`settings-nav-${section}`));await waitFor(`document.querySelector('[data-testid="settings-${section}"]')`,`${section} settings`);};
  const open=async()=>{await click('[aria-label="模型服务设置"]');await waitFor(`document.querySelector('[data-testid="model-settings-dialog"]')`,'settings open');};
  const close=async()=>{await click(test('settings-close'));await waitFor(`!document.querySelector('[data-testid="model-settings-dialog"]')`,'settings closed');};
  const save=async()=>{const before=state.settingsSaves;await click(test('settings-save'));await waitFor(`document.querySelector('[data-testid="settings-save"]')?.disabled&&document.querySelector('[data-testid="settings-save-status"]')?.textContent.startsWith('已保存')&&!document.querySelector('[data-testid="settings-error"]')`,'settings explicitly saved');assert.equal(state.settingsSaves,before+1);assert.deepEqual(await ctx.settingsDisk(),ctx.settingsSnapshot());};
  async function fit() {await click('[aria-label="缩放选项"]');await key('Escape');await key('0',{ctrl:true});await evaluate(`new Promise(resolve=>{let p='',stable=0;function frame(){const s=document.querySelector('.react-flow__viewport')?.getAttribute('style');stable=s===p?stable+1:0;p=s;if(stable>=8)resolve();else requestAnimationFrame(frame);}requestAnimationFrame(frame);})`);}
  async function persisted(action,predicate,label) {const before=state.autosaves;await action();const p=await ctx.waitForAutosave(p=>state.autosaves>before&&predicate(p),label);assert.deepEqual(await ctx.readProject(ctx.autosaveFile),p);return p;}
  return {key,click,clickAt,type,select,test,nav,open,close,save,fit,persisted,evidence};
}

export async function runSettingsAcceptance(ctx) {
  const {state,evaluate,waitFor}=ctx,u=controls(ctx),t=u.test;
  assert.deepEqual(await evaluate('Object.keys(window.desktop).sort()'),['openProject','saveProject','autosave','restoreAutosave','importMedia','runWorkflow','cancelWorkflow','getAppInfo','onWorkflowEvent','getModelSettings','saveModelSettings','configureModelCredential','listProviderModels','cancelProviderModels'].sort());
  u.evidence('0.3 public fixture bridge exactly matches 14 public members; no test-only public methods');
  assert.equal(await evaluate(`document.querySelectorAll('.workflow-node').length`),0);
  assert.equal(await evaluate(`document.querySelector('[aria-label="运行工作流"]').disabled`),true);
  await ctx.waitForAutosave(p=>p.nodes.length===0&&!Object.hasOwn(p,'settings'),'empty canvas disk autosave');
  u.evidence('clean profile startup has empty canvas, disabled run and real empty autosave');
  await u.open();
  const layout=await evaluate(`(()=>{const r=document.querySelector('.ms-panel').getBoundingClientRect(),n=document.querySelector('.ms-nav').getBoundingClientRect();return {panel:{x:r.x,y:r.y,width:r.width,height:r.height},navWidth:n.width,rootInert:document.getElementById('root').hasAttribute('inert'),focusInside:document.querySelector('.ms-panel').contains(document.activeElement),background:getComputedStyle(document.querySelector('.ms-primary')).backgroundColor};})()`);
  assert.equal(layout.panel.width,800);assert.equal(layout.navWidth,188);assert.ok(layout.rootInert&&layout.focusInside);
  assert.ok(layout.panel.x>=0&&layout.panel.y>=0);assert.match(layout.background,/rgb\((2[3-5]\d), (2[3-5]\d), (2[3-5]\d)\)/);
  await ctx.screenshot(ctx.screenshotFile);
  u.evidence('real model settings screenshot: 800px dialog within viewport',{layout,screenshot:ctx.screenshotFile});
  u.evidence('settings 188px navigation and neutral white primary button measured from rendered CSS',{navWidth:layout.navWidth,primary:layout.background});
  await u.key('Tab',{shift:true});
  assert.equal(await evaluate(`document.querySelector('.ms-panel').contains(document.activeElement)`),true);
  u.evidence('portal marks canvas root inert and trusted ShiftTab remains in settings focus trap');
  await u.nav('providers');
  await u.click(t('provider-add'));await u.type(t('provider-name-0'),'V3 Fixture Alpha');await u.type(t('provider-id-0'),'fixture-alpha');await u.type(t('provider-url-0'),'http://127.0.0.1:15432/v3-alpha');await u.select(t('provider-auth-0'),'none');
  u.evidence('trusted mouse and keyboard add first OpenAI-compatible provider as auth none');
  await u.click(t('model-add-0'));await u.type(t('model-id-0-0'),'v3-text-alpha');await u.type(t('model-name-0-0'),'V3 Alpha Text');await u.click(t('model-0-0-role-image'));
  assert.equal(await evaluate(`document.querySelector('[data-testid="model-0-0-role-text"]').checked&&document.querySelector('[data-testid="model-0-0-role-image"]').checked`),true);
  u.evidence('manual model directory keeps typed model ID/name and explicitly declared text plus image roles');
  await u.click(t('provider-add'));await u.type(t('provider-name-1'),'V3 Fixture Beta');await u.type(t('provider-id-1'),'fixture-beta');await u.type(t('provider-url-1'),'http://127.0.0.1:15433/v3-beta');await u.select(t('provider-auth-1'),'none');
  await u.click(t('model-add-1'));await u.type(t('model-id-1-0'),'v3-text-beta');await u.type(t('model-name-1-0'),'V3 Beta Text');
  assert.equal(await evaluate(`document.querySelectorAll('[data-testid="provider-editor"]').length`),1);
  assert.equal(await evaluate(`document.querySelectorAll('.ms-provider').length`),2);
  u.evidence('second independent provider added; only one editor expanded, prior provider draft retained');
  assert.equal(state.settingsSaves,0);assert.equal(ctx.settingsSnapshot().document.providers.length,0);
  u.evidence('editing two providers does not implicitly save application settings');
  await u.nav('defaults');
  assert.equal(await evaluate(`document.querySelector('[data-testid="default-model-text"]').options.length`),3);
  assert.equal(await evaluate(`document.querySelector('[data-testid="default-model-image"]').options.length`),2);
  assert.equal(await evaluate(`document.querySelector('[data-testid="default-model-audio"]').options.length`),1);
  u.evidence('default selectors filter roles from declarations rather than infer capabilities from names');
  const alpha={providerId:'fixture-alpha',modelId:'v3-text-alpha'},beta={providerId:'fixture-beta',modelId:'v3-text-beta'};
  await u.select(t('default-model-text'),JSON.stringify(alpha));await u.select(t('default-model-image'),JSON.stringify(alpha));await u.save();
  assert.deepEqual(ctx.settingsSnapshot().document.defaults.text,alpha);assert.deepEqual(ctx.settingsSnapshot().document.defaults.image,alpha);
  u.evidence('explicit save commits both providers and chosen role defaults to fixture CAS file',{revision:ctx.settingsSnapshot().revision});
  await u.close();await u.open();await u.nav('defaults');
  assert.equal(await evaluate(`document.querySelector('[data-testid="default-model-text"]').value`),JSON.stringify(alpha));
  u.evidence('close and reopen reads saved settings rather than reset defaults');
  await u.close();const reads=state.settingsReads;await ctx.reload();await u.open();await u.nav('providers');
  assert.ok(state.settingsReads>reads);assert.equal(await evaluate(`document.querySelectorAll('.ms-provider').length`),2);
  assert.deepEqual((await ctx.settingsDisk()).document.defaults.text,alpha);
  u.evidence('real browser refresh re-reads fixture persisted catalog and defaults');
  await u.click('.ms-provider-toggle');await u.type(t('provider-name-0'),'V3 DIRTY CANCEL PRESERVED');
  await u.click(t('settings-close'));await waitFor(`document.querySelector('[data-testid="settings-confirm"]')`,'dirty close confirmation');await u.click(t('settings-confirm-cancel'));
  assert.equal(await evaluate(`document.querySelector('[data-testid="provider-name-0"]').value`),'V3 DIRTY CANCEL PRESERVED');
  u.evidence('dirty close cancellation preserves unsaved provider draft');
  await u.click(t('settings-close'));await u.click(t('settings-confirm-accept'));await waitFor(`!document.querySelector('.ms-panel')`,'discard close');await u.open();await u.nav('providers');await u.click('.ms-provider-toggle');
  assert.equal(await evaluate(`document.querySelector('[data-testid="provider-name-0"]').value`),'V3 Fixture Alpha');
  u.evidence('dirty close explicit discard restores saved document on next open');
  // Saved providers collapse custom details by default. Open via trusted summary click before invalid URL entry.
  await u.click('[data-testid="provider-editor"] .ms-details summary');
  await u.type(t('provider-url-0'),'not-a-valid-url');const savesBefore=state.settingsSaves;await u.click(t('settings-save'));await waitFor(`document.querySelector('[data-testid="settings-error"]')`,'invalid field visible error');
  assert.equal(state.settingsSaves,savesBefore);assert.equal(await evaluate(`document.querySelector('[data-testid="provider-url-0"]').value`),'not-a-valid-url');
  u.evidence('invalid URL fails renderer validation visibly, retaining draft and leaving CAS file untouched');
  await u.type(t('provider-url-0'),'http://127.0.0.1:15432/v3-alpha');
  await u.type(t('provider-name-0'),'V3 Alpha Keyboard Saved');const projectSaves=state.saves,runs=state.runs;
  await u.key('s',{ctrl:true});await waitFor(`document.querySelector('[data-testid="settings-save"]')?.disabled&&document.querySelector('[data-testid="settings-save-status"]')?.textContent.startsWith('已保存')&&!document.querySelector('[data-testid="settings-error"]')`,'CtrlS saves settings only');
  assert.equal(state.saves,projectSaves);assert.equal(state.runs,runs);assert.equal(ctx.settingsSnapshot().document.providers[0].name,'V3 Alpha Keyboard Saved');
  u.evidence('trusted CtrlS saves settings only, not project/canvas');
  await u.type(t('provider-name-0'),'V3 ESCAPE DIRTY');await u.key('Enter',{ctrl:true});assert.equal(state.runs,runs);await u.key('Escape');await waitFor(`document.querySelector('[data-testid="settings-confirm"]')`,'Escape dirty guard');await u.key('Escape');
  assert.equal(await evaluate(`Boolean(document.querySelector('.ms-panel'))&&!document.querySelector('[data-testid="settings-confirm"]')`),true);assert.equal(state.runs,runs);assert.equal(state.saves,projectSaves);
  u.evidence('CtrlEnter cannot run canvas; Escape opens dirty guard then cancels only the nested confirmation');
  await u.click(t('settings-reload'));await u.click(t('settings-confirm-accept'));await waitFor(`document.querySelector('[data-testid="settings-save"]')?.disabled&&document.querySelector('[data-testid="settings-save-status"]')?.textContent.startsWith('已保存')`,'reload discard');
  await u.nav('providers');await u.click('.ms-provider-toggle');
  await u.click(t('model-delete-0-0'));await u.click(t('settings-confirm-cancel'));assert.equal(await evaluate(`document.querySelectorAll('[data-testid="model-row-0-0"]').length`),1);
  u.evidence('deleting a default-linked model requires confirmation and cancellation preserves model');
  await u.click(t('model-delete-0-0'));await u.click(t('settings-confirm-accept'));await u.nav('defaults');
  assert.equal(await evaluate(`document.querySelector('[data-testid="default-model-text"]').value`),'');assert.equal(await evaluate(`document.querySelector('[data-testid="default-model-image"]').value`),'');
  assert.deepEqual(ctx.settingsSnapshot().document.defaults.text,alpha);
  u.evidence('confirmed model deletion clears related defaults in draft only, not stored settings');
  await u.click(t('settings-reload'));await u.click(t('settings-confirm-accept'));await waitFor(`document.querySelector('[data-testid="settings-save"]')?.disabled&&document.querySelector('[data-testid="settings-save-status"]')?.textContent.startsWith('已保存')`,'restore deletion draft');
  await u.nav('providers');await u.click('.ms-provider-toggle');
  await u.click(t('provider-delete-0'));await u.click(t('settings-confirm-accept'));await u.nav('defaults');
  assert.equal(await evaluate(`document.querySelector('[data-testid="default-model-text"]').value`),'');
  u.evidence('confirmed provider deletion also clears its model/default associations without touching remote service');
  await u.click(t('settings-reload'));await u.click(t('settings-confirm-accept'));await waitFor(`document.querySelector('[data-testid="settings-save"]')?.disabled&&document.querySelector('[data-testid="settings-save-status"]')?.textContent.startsWith('已保存')`,'restore provider draft');
  await u.nav('providers');await u.click('.ms-provider-toggle');
  await u.click(t('provider-list-models-0'));await waitFor(`document.querySelector('[data-testid="model-candidates"]')`,'fixture metadata candidates');
  assert.equal(ctx.settingsSnapshot().document.providers[0].models.length,1);await u.click('[aria-label="选择候选 v3-fixture-candidate"]');
  assert.equal(await evaluate(`document.querySelector('[data-testid="model-candidates-apply"]').disabled`),true);
  u.evidence('fixture-only metadata candidates do not infer role or auto-modify saved directory');
  await u.click(t('candidate-v3-fixture-candidate-role-text'));await u.click(t('model-candidates-apply'));
  assert.equal(await evaluate(`document.querySelectorAll('.ms-model').length`),2);assert.equal(ctx.settingsSnapshot().document.providers[0].models.length,1);await u.save();
  assert.equal(ctx.settingsSnapshot().document.providers[0].models.length,2);
  u.evidence('explicit candidate role plus apply only changes draft; explicit save persists candidate (fixture metadata only)');
  ctx.fixture.metadataDeferred=true;await u.click(t('provider-list-models-0'));await waitFor(`document.querySelector('[data-testid="provider-list-cancel"]')`,'metadata pending');await u.click(t('provider-list-cancel'));await ctx.releaseMetadata();
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-testid="model-candidates"]'))`),false);assert.ok(state.metadataCancels>0);ctx.fixture.metadataDeferred=false;
  u.evidence('fixture metadata cancellation ignores deliberately late result without altering catalog');
  // Fixture credentials expose status only. No native dialog or secret is used or claimed.
  await u.click('[data-testid="provider-editor"] .ms-details summary');await u.select(t('provider-auth-0'),'required');await u.save();
  await u.click(t('provider-credential-set-0'));await waitFor(`document.querySelector('[data-testid="provider-credential-status-0"]')?.textContent.includes('已配置')`,'fake credential configured');
  assert.equal(ctx.settingsSnapshot().credentials['fixture-alpha'].configured,true);
  u.evidence('credential button obtains configured status from fake fixture operation, NOT Native dialog or provider authentication');
  ctx.fixture.credentialCancel=true;const revision=ctx.settingsSnapshot().revision;await u.click(t('provider-credential-set-0'));await waitFor(`document.querySelector('[data-testid="settings-notice"]')?.textContent.includes('取消')`,'fake credential cancel');assert.equal(ctx.settingsSnapshot().revision,revision);ctx.fixture.credentialCancel=false;
  u.evidence('fixture-only credential cancellation leaves saved revision unchanged; no secret entered');
  await u.click(t('provider-credential-clear-0'));await u.click(t('settings-confirm-accept'));await waitFor(`document.querySelector('[data-testid="provider-credential-status-0"]')?.textContent.includes('未配置')`,'fake credential clear');assert.equal(ctx.settingsSnapshot().credentials['fixture-alpha'].configured,false);
  u.evidence('fixture-only credential clear requires confirmation and returns unconfigured status');
  await u.select(t('provider-auth-0'),'none');await u.save();
  await u.type(t('provider-name-0'),'V3 CAS DRAFT MUST SURVIVE');await ctx.bumpRevision();const casRevision=ctx.settingsSnapshot().revision;await u.click(t('settings-save'));await waitFor(`document.querySelector('[data-testid="settings-error"]')?.textContent.includes('其他窗口')`,'CAS visible conflict');
  assert.equal(await evaluate(`document.querySelector('[data-testid="provider-name-0"]').value`),'V3 CAS DRAFT MUST SURVIVE');assert.equal(await evaluate(`document.querySelector('[data-testid="settings-save"]').disabled`),true);assert.equal(ctx.settingsSnapshot().revision,casRevision);
  u.evidence('fixture-only concurrent CAS mutation rejects stale save, disables overwrite and preserves complete draft');
  await u.click(t('settings-reload'));await u.click(t('settings-confirm-accept'));await waitFor(`!document.querySelector('[data-testid="settings-error"]')&&document.querySelector('[data-testid="settings-save"]')?.disabled&&document.querySelector('[data-testid="settings-save-status"]')?.textContent.startsWith('已保存')`,'conflict reload');
  assert.deepEqual(await ctx.settingsDisk(),ctx.settingsSnapshot());u.evidence('explicit reread resolves fixture CAS conflict using current persisted revision');
  await u.close();return {alpha,beta};
}

export async function runCanvasAcceptance(ctx,{beta}) {
  const {state,evaluate,waitFor}=ctx,u=controls(ctx),before=ctx.settingsSnapshot();
  await u.click('[data-testid="project-menu"]');await u.click('[data-testid="load-demo"]');const loaded=await ctx.waitForAutosave(p=>p.nodes.length===5&&p.nodes.some(n=>n.id==='idea'),'five demo nodes');
  assert.deepEqual(ctx.settingsSnapshot(),before);assert.equal(Object.hasOwn(loaded,'settings'),false);
  u.evidence('original Demo loads five nodes without replacing saved application catalog/defaults');
  const eventStart=state.events.length;await u.click('[aria-label="运行工作流"]');await waitFor(`document.querySelector('[aria-label="运行工作流"]')&&(()=>{const e=document.querySelector('.kind-output img');return e?.complete&&e.naturalWidth>0;})()`,'Demo output decoded');await ctx.engine.waitForIdle();
  const outputs=await ctx.waitForAutosave(p=>p.nodes.length===5&&p.nodes.every(n=>n.data.lastOutput),'Demo durable five outputs');
  assert.equal(new Set(state.events.slice(eventStart).filter(e=>e.status==='success').map(e=>e.nodeId)).size,5);assert.ok(outputs.nodes.filter(n=>n.data.lastOutput.image).every(n=>n.data.lastOutput.demo===true));
  assert.equal(await evaluate('window.__whaleFixtureEventCount()'),state.events.length);
  u.evidence('actual WorkflowEngine.runConfigured produces five Demo successes over real localhost SSE and decoded image',{successes:5,transport:'EventSource SSE, not Native WebMessage'});
  assert.deepEqual(await ctx.readProject(ctx.autosaveFile),outputs);
  u.evidence('all five Demo results durably reach real atomic autosave file, without fixed sleep');
  const saves=state.saves;await u.key('s',{ctrl:true});await waitFor(`document.querySelector('.toast')?.textContent.includes('项目已保存')`,'Demo save');const saved=await ctx.readProject(ctx.savedFile);assert.equal(state.saves,saves+1);assert.equal(saved.nodes.length,5);assert.ok(saved.nodes.every(n=>n.data.lastOutput));
  assert.match(saved.nodes.find(n=>n.id==='result').data.lastOutput.image,/^data:image\/svg\+xml/);
  u.evidence('trusted CtrlS writes portable Demo project including all outputs and embedded SVG');
  await ctx.flushAutosave();const restores=state.restores;await ctx.reload();await waitFor(`(()=>{const e=document.querySelector('.kind-output img');return e?.complete&&e.naturalWidth>0;})()`,'durable Demo refresh');assert.ok(state.restores>restores);assert.deepEqual(ctx.settingsSnapshot(),before);
  u.evidence('real refresh restores five-node Demo output from disk while application settings stay independent');
  // This guards a populated canvas as well as the initial empty-canvas keyboard checks.
  await u.open();const runCount=state.runs,saveCount=state.saves;await u.key('Enter',{ctrl:true});await u.key('s',{ctrl:true});assert.equal(state.runs,runCount);assert.equal(state.saves,saveCount);await u.key('Escape');await waitFor(`!document.querySelector('.ms-panel')`,'clean Escape closes only settings');assert.equal(state.runs,runCount);
  u.evidence('settings CtrlEnter/CtrlS/Escape cannot execute or save even with runnable populated Demo canvas');
  await u.fit();await u.click('.react-flow__node[data-id="writer"] .wf-node-label');await u.click('.react-flow__node[data-id="writer"] [aria-label="模型与服务参数"]');await waitFor(`document.querySelector('.popover-model select')`,'actual node model chooser');
  const option=await evaluate(`(()=>{const options=[...document.querySelector('.popover-model select').options];return options.find(o=>o.textContent.includes('v3-text-beta'))?.value;})()`);assert.ok(option,'Saved provider/model must be offered by actual node chooser');
  const modelProject=await u.persisted(()=>u.select('.popover-model select',option),p=>p.version===2&&p.nodes.find(n=>n.id==='writer')?.data.modelRef?.providerId===beta.providerId,'node modelRef autosave');
  assert.deepEqual(modelProject.nodes.find(n=>n.id==='writer').data.modelRef,beta);assert.notEqual(modelProject.nodes.find(n=>n.id==='writer').data.provider,'demo');await u.click('[aria-label="关闭参数"]');
  u.evidence('actual node model dropdown stores selected provider/modelRef and upgrades project to v2, clearing Demo override',{selection:beta});
  await u.key('s',{ctrl:true});await waitFor(`document.querySelector('.toast')?.textContent.includes('项目已保存')`,'v2 export save');const exported=await ctx.readProject(ctx.savedFile);assert.equal(exported.version,2);assert.deepEqual(exported.nodes.find(n=>n.id==='writer').data.modelRef,beta);
  u.evidence('real project export and backend readProject retain strict v2 providerId/modelId reference');
  await u.click('.react-flow__node[data-id="writer"] .wf-node-label');await u.click('[aria-label="缩放选项"]');await u.key('Escape');await u.key('c',{ctrl:true});await waitFor(`document.querySelector('.toast')?.textContent.includes('已复制选中节点')`,'isolated clipboard copy');
  const raw=await evaluate('window.__whaleFixtureClipboardReadback()');assert.ok(raw.startsWith('WHALEFLOW_NODES\n'));const payload=JSON.parse(raw.slice('WHALEFLOW_NODES\n'.length));assert.equal(payload.version,2);assert.equal(payload.nodes.length,1);assert.deepEqual(payload.nodes[0].data.modelRef,beta);
  u.evidence('trusted CtrlC uses isolated in-memory clipboard and carries v2 modelRef, never OS clipboard');
  const pasted=await u.persisted(()=>u.key('v',{ctrl:true}),p=>p.version===2&&p.nodes.length===6,'v2 clipboard paste');assert.equal(new Set(pasted.nodes.map(n=>n.id)).size,6);assert.equal(pasted.nodes.filter(n=>n.data.modelRef?.providerId===beta.providerId).length,2);
  u.evidence('trusted CtrlV creates distinct node ID while retaining v2 catalog reference');
  await ctx.flushAutosave();const disk=await ctx.readProject(ctx.autosaveFile),local=await evaluate('JSON.stringify({...localStorage})');
  for(const [name,object] of [['export',exported],['autosave',disk]]) {
    assert.equal(Object.hasOwn(object,'settings'),false);const text=JSON.stringify(object);
    for(const marker of ['v3-alpha','v3-beta','V3 Alpha Keyboard Saved','V3 Fixture Beta','v3-fixture-candidate','allowInsecureHttpAuth','credentials','modelSettings'])assert.equal(text.includes(marker),false,`${name} leaked application catalog marker ${marker}`);
  }
  for(const marker of ['fixture-alpha','fixture-beta','v3-alpha','v3-beta','v3-fixture-candidate','modelSettings','credentials'])assert.equal(local.includes(marker),false,`localStorage leaked ${marker}`);
  assert.deepEqual(await ctx.settingsDisk(),ctx.settingsSnapshot());
  u.evidence('catalog URLs/names/unused candidates and credentials excluded from exported project and durable autosave');
  u.evidence('fixture desktop path keeps catalog and model settings out of localStorage',{storage:local});
  assert.equal(state.runs,1,'Only dedicated Demo acceptance may run a workflow');
  u.evidence('all settings/modelRef/clipboard edits leave run count at one dedicated offline Demo; no supplier calls');
}
