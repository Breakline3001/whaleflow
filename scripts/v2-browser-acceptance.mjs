import assert from 'node:assert/strict';
import path from 'node:path';

// Interaction helpers deliberately use CDP Input, never HTMLElement.click or React internals.
function controls(ctx) {
  const { evaluate, send, waitFor, state, waitForAutosave, log } = ctx;
  const evidence = (name, details = {}) => { state.evidence.push({ name, ...details }); log(`PASS ${name}`); };
  const point = selector => evaluate(`(() => {
    const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw Error('Missing target: '+${JSON.stringify(selector)});
    if(element.disabled||element.closest('[inert]'))throw Error('Disabled target: '+${JSON.stringify(selector)});
    const r=element.getBoundingClientRect();const x=Math.max(2,Math.min(innerWidth-2,r.x+r.width/2)),y=Math.max(2,Math.min(innerHeight-2,r.y+r.height/2));
    const hit=document.elementFromPoint(x,y);if(!r.width||!r.height||!element.contains(hit))throw Error('Occluded/offscreen target: '+${JSON.stringify(selector)}+' rect='+JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height})+' hit='+hit?.outerHTML?.slice(0,160));
    return{x,y};
  })()`);
  async function mouse(type, position, options = {}) { await send('Input.dispatchMouseEvent', { type, ...position, ...options }); }
  async function clickAt(position, count = 1) {
    await mouse('mouseMoved', position);
    await mouse('mousePressed', position, { button: 'left', buttons: 1, clickCount: count });
    await mouse('mouseReleased', position, { button: 'left', buttons: 0, clickCount: count });
  }
  async function click(selector) { await clickAt(await point(selector)); }
  async function key(key, { ctrl = false, shift = false, alt = false, downOnly = false, upOnly = false } = {}) {
    const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0) | (alt ? 1 : 0);
    const special = { Escape: ['Escape', 27], Delete: ['Delete', 46], ' ': ['Space', 32], Control: ['ControlLeft', 17], Enter: ['Enter', 13] };
    const [code, windowsVirtualKeyCode] = special[key] || [/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key, key.toUpperCase().charCodeAt(0)];
    const params = { key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers };
    if (!upOnly) await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
    if (!downOnly) await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
  }
  async function type(selector, text) {
    await click(selector); await key('a', { ctrl: true }); await send('Input.insertText', { text });
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`), text, 'Trusted input did not reach the controlled editor');
  }
  async function blank(preferred) {
    return evaluate(`(() => {const points=${JSON.stringify(preferred ? [preferred] : [{ x: 1420, y: 760 }, { x: 1250, y: 700 }, { x: 120, y: 760 }, { x: 1400, y: 300 }, { x: 700, y: 100 }])};
      for(const point of points){const e=document.elementFromPoint(point.x,point.y);if(e?.closest('.react-flow__pane')&&!e.closest('.react-flow__node,.floating,header,.empty-canvas'))return point;}throw Error('No unobstructed canvas point');})()`);
  }
  async function blur() { await clickAt(await blank()); }
  async function snapshotAfter(action, predicate, label) {
    const count = state.autosaves; await action();
    const snapshot = await waitForAutosave(p => state.autosaves > count && predicate(p), label);
    const disk = await ctx.readProject(ctx.autosaveFile);
    assert.deepEqual(disk, snapshot, `${label}: autosave listener differed from real atomic file`);
    return snapshot;
  }
  async function paletteAt(position, label) {
    await clickAt(await blank(position)); await clickAt(position, 2);
    await waitFor(`document.querySelector('.add-palette')`, 'double-click add palette');
    await type('[aria-label="搜索节点类型"]', label);
    await waitFor(`document.querySelectorAll('.add-palette .palette-row').length===1`, 'filtered add palette');
    await click('.add-palette .palette-row');
  }
  async function fit({ preserveSelection = false } = {}) {
    if (preserveSelection) { await click('[aria-label="缩放选项"]'); await key('Escape'); }
    else await blur();
    await key('0', { ctrl: true });
    // Frame boundaries synchronize with the actual ReactFlow animation, not a fixed sleep.
    await evaluate(`new Promise(resolve=>{let previous='',stable=0;const check=()=>{const value=document.querySelector('.react-flow__viewport')?.getAttribute('style');if(value===previous)stable++;else stable=0;previous=value;if(stable>=8)resolve();else requestAnimationFrame(check);};requestAnimationFrame(check);})`);
  }
  async function drag(start, end, button = 'left') {
    const buttons = button === 'middle' ? 4 : 1;
    await mouse('mouseMoved', start); await mouse('mousePressed', start, { button, buttons, clickCount: 1 });
    for (let index = 1; index <= 12; index++) await mouse('mouseMoved', { x: start.x + (end.x - start.x) * index / 12, y: start.y + (end.y - start.y) * index / 12 }, { button, buttons });
    await mouse('mouseReleased', end, { button, buttons: 0, clickCount: 1 });
  }
  async function selectAll() { await blur(); await key('a', { ctrl: true }); }
  async function projectMenu() { await click('[data-testid="project-menu"]'); await waitFor(`document.querySelector('.project-menu')`, 'project menu'); }
  return { point, click, clickAt, key, type, blank, blur, snapshotAfter, paletteAt, fit, drag, selectAll, projectMenu, evidence, mouse };
}

export async function runEditorAcceptance(ctx) {
  const { state, waitFor, evaluate, send, reload } = ctx, ui = controls(ctx);
  assert.deepEqual(await evaluate('Object.keys(window.desktop).sort()'), ['openProject', 'saveProject', 'autosave', 'restoreAutosave', 'importMedia', 'runWorkflow', 'cancelWorkflow', 'getAppInfo', 'onWorkflowEvent'].sort(), 'Fixture must exactly match the real public bridge API, with no fictional aliases');
  assert.equal(await evaluate(`document.querySelectorAll('.workflow-node').length`), 0);
  assert.equal(await evaluate(`document.querySelector('[aria-label="运行工作流"]').disabled`), true);
  await ctx.waitForAutosave(p => p.nodes.length === 0, 'initial empty autosave');
  ui.evidence('V2 initial empty canvas and exact real-bridge fixture keys', { nodes: 0 });
  try {
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 665, deviceScaleFactor: 2, mobile: false });
    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`);
    const layout = await evaluate(`(() => {
      const rect=selector=>{const e=document.querySelector(selector);if(!e)throw Error('Missing layout region '+selector);const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};};
      const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).display!=='none';};
      return{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,background:getComputedStyle(document.querySelector('.canvas-app')).backgroundColor,flowBackground:getComputedStyle(document.querySelector('.react-flow')).backgroundColor,permanentSidebarCount:[...document.querySelectorAll('aside,.library,.inspector')].filter(visible).length,regions:{surface:rect('.flow-surface'),topLeft:rect('.top-left-cluster'),dock:rect('.creation-dock'),bottomLeft:rect('.bottom-left-controls')}};
    })()`);
    assert.equal(layout.width, 1280); assert.equal(layout.height, 665); assert.equal(layout.dpr, 2);
    assert.equal(layout.background, 'rgb(20, 20, 20)'); assert.equal(layout.permanentSidebarCount, 0);
    assert.deepEqual(layout.regions.surface, { x: 0, y: 0, width: 1280, height: 665 });
    for (const rect of Object.values(layout.regions)) assert.ok(rect.x>=0&&rect.y>=0&&rect.width>0&&rect.height>0&&rect.x+rect.width<=1281&&rect.y+rect.height<=666, 'Primary region must fit the reference viewport');
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
    const bytes = Buffer.from(shot.data, 'base64'), filename = path.join(ctx.artifacts, 'v2-empty-canvas.png');
    await ctx.writeFile(filename, bytes);
    ui.evidence('reference-size empty canvas screenshot and objective layout evidence', { screenshot: filename, pixelWidth: bytes.readUInt32BE(16), pixelHeight: bytes.readUInt32BE(20), ...layout });
  } finally {
    await send('Emulation.setDeviceMetricsOverride', { width: 1512, height: 980, deviceScaleFactor: 1, mobile: false });
    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`);
  }

  await ui.paletteAt({ x: 240, y: 170 }, '文本');
  await waitFor(`document.querySelector('.kind-text.is-intro')`, 'new text introduction');
  await ui.click('.kind-text .wf-try button:first-of-type');
  const manualText = 'V2 browser handwritten content — 月光与鲸鱼';
  let snapshot = await ui.snapshotAfter(async () => {
    await ui.type('[aria-label="文本输入内容"]', manualText);
    await ui.type('.kind-prompt [aria-label="节点名称"]', 'V2 手写验收'); await ui.blur();
  }, p => p.nodes.length === 1 && p.nodes[0].data.content === manualText && p.nodes[0].data.title === 'V2 手写验收', 'handwritten content persisted');
  const promptId = snapshot.nodes[0].id;
  assert.equal(snapshot.nodes[0].data.kind, 'prompt'); assert.equal(snapshot.nodes[0].data.manual, true);
  ui.evidence('blank double-click → text → write manually with trusted CDP input and disk readback', { id: promptId, content: manualText });

  for (const [kind, label, position] of [['image', '图片', { x: 700, y: 160 }], ['video', '视频', { x: 240, y: 560 }], ['audio', '音频', { x: 850, y: 600 }]]) {
    snapshot = await ui.snapshotAfter(() => ui.paletteAt(position, label), p => p.nodes.some(n => n.data.kind === kind), `${kind} created and persisted`);
    assert.ok(await evaluate(`Boolean(document.querySelector('.kind-${kind}'))`), 'Newly created onscreen media node is visible');
    ui.evidence(`real add palette creates ${kind} node`, { id: snapshot.nodes.find(n => n.data.kind === kind).id });
  }
  assert.equal(snapshot.nodes.length, 4);
  const imageId = snapshot.nodes.find(n => n.data.kind === 'image').id;
  await ui.fit();
  const nodeSelector = id => `.react-flow__node[data-id="${id}"]`;
  snapshot = await ui.snapshotAfter(async () => {
    const source = await ui.point(`${nodeSelector(promptId)} .react-flow__handle.source`), target = await ui.point(`${nodeSelector(imageId)} .react-flow__handle.target`);
    await ui.drag(source, target);
    await ui.key('Escape');
  }, p => p.edges.some(e => e.source === promptId && e.target === imageId), 'native ReactFlow handle drag creates edge');
  assert.equal(await evaluate(`document.querySelectorAll('.react-flow__edge').length`), 1);
  ui.evidence('actual native ReactFlow handle drag + persisted edge', { source: promptId, target: imageId });

  await ui.selectAll();
  await waitFor(`document.querySelector('.react-flow__node.selected')`, 'Ctrl+A selects visible nodes; full selection is proved by persisted grouping below');
  const worlds = Object.fromEntries(snapshot.nodes.map(n => [n.id, n.position]));
  snapshot = await ui.snapshotAfter(() => ui.key('g', { ctrl: true }), p => p.nodes.length === 5 && p.nodes.some(n => n.data.kind === 'group'), 'Ctrl+G group');
  const group = snapshot.nodes.find(n => n.data.kind === 'group');
  for (const n of snapshot.nodes.filter(n => n.id !== group.id)) {
    assert.equal(n.parentId, group.id); assert.deepEqual({ x: n.position.x + group.position.x, y: n.position.y + group.position.y }, worlds[n.id]);
  }
  await ui.fit({ preserveSelection: true });
  ui.evidence('Ctrl+A / Ctrl+G grouping preserves each world coordinate and edge', { nodes: 5, groupId: group.id });
  snapshot = await ui.snapshotAfter(() => ui.key('d', { ctrl: true }), p => p.nodes.length === 10 && p.edges.length === 2, 'Ctrl+D nested group duplicate');
  assert.equal(snapshot.nodes.filter(n => n.data.kind === 'group').length, 2);
  await waitFor(`document.querySelector('.kind-group.is-selected')`, 'copied group selected; recursive deletion below proves the copied subtree selection');
  ui.evidence('Ctrl+D copies selected group and all children/internal edge', { nodes: 10, edges: 2 });
  snapshot = await ui.snapshotAfter(() => ui.key('Delete'), p => p.nodes.length === 5 && p.edges.length === 1, 'Delete removes duplicate subtree');
  snapshot = await ui.snapshotAfter(() => ui.key('z', { ctrl: true }), p => p.nodes.length === 10 && p.edges.length === 2, 'Ctrl+Z restores subtree');
  snapshot = await ui.snapshotAfter(() => ui.key('z', { ctrl: true, shift: true }), p => p.nodes.length === 5 && p.edges.length === 1, 'Ctrl+Shift+Z deletes subtree again');
  ui.evidence('Delete / Ctrl+Z / Ctrl+Shift+Z verified by actual autosave graphs', { finalNodes: snapshot.nodes.length });
  await ui.selectAll();
  snapshot = await ui.snapshotAfter(() => ui.key('g', { ctrl: true, shift: true }), p => p.nodes.length === 4 && p.nodes.every(n => !n.parentId), 'Ctrl+Shift+G ungroups');
  for (const n of snapshot.nodes) assert.deepEqual(n.position, worlds[n.id]);
  ui.evidence('Ctrl+Shift+G releases children without world-coordinate jumps');

  await ui.blur(); await ui.key('f', { ctrl: true });
  await waitFor(`document.querySelector('[aria-label="搜索画布节点"]')`, 'NodeSearch opened');
  await ui.type('[aria-label="搜索画布节点"]', manualText);
  await waitFor(`document.querySelectorAll('.search-results button').length===1`, 'NodeSearch filters by typed content');
  await ui.click('.search-results button');
  await waitFor(`!document.querySelector('.search-panel')&&document.querySelector(${JSON.stringify(`${nodeSelector(promptId)}.selected`)})`, 'NodeSearch selects actual matching node');
  ui.evidence('NodeSearch Ctrl+F content filter and click selects/reveals matching canvas node', { id: promptId });
  await ui.fit();

  async function movement(name, action, check) {
    const visible = await evaluate(`(() => {const matrix=new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform);return{x:matrix.m41,y:matrix.m42,zoom:matrix.a};})()`);
    const before = await ctx.waitForAutosave(p => p.nodes.length === 4 && ['x','y','zoom'].every(key => Math.abs(p.viewport[key]-visible[key]) < 0.001), `${name} initial viewport persisted`);
    const baseline = { ...before.viewport };
    snapshot = await ui.snapshotAfter(action, p => check(p.viewport, baseline), name);
    ui.evidence(name, { before: baseline, after: snapshot.viewport });
  }
  await movement('ordinary wheel pans without zoom', async () => {
    const position = await ui.blank(); await ui.mouse('mouseMoved', position);
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...position, deltaX: 58, deltaY: 95, modifiers: 0 });
  }, (view, before) => (view.x !== before.x || view.y !== before.y) && view.zoom === before.zoom);
  await movement('Ctrl+wheel changes zoom', async () => {
    const position = await ui.blank(); await ui.key('Control', { ctrl: true, downOnly: true });
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...position, deltaX: 0, deltaY: -100, modifiers: 2 });
    await ui.key('Control', { upOnly: true });
  }, (view, before) => Math.abs(view.zoom - before.zoom) > 0.001);
  await movement('Space + real left drag pans', async () => {
    const start = await ui.blank(); await ui.key(' ', { downOnly: true });
    await waitFor(`document.querySelector('.canvas-app.panning')`, 'Space enters panning mode');
    await ui.drag(start, { x: start.x - 80, y: start.y - 35 }); await ui.key(' ', { upOnly: true });
  }, (view, before) => view.x !== before.x || view.y !== before.y);
  await movement('real middle-button drag pans', async () => {
    const start = await ui.blank(); await ui.drag(start, { x: start.x - 55, y: start.y + 25 }, 'middle');
  }, (view, before) => view.x !== before.x || view.y !== before.y);

  const firstCanvasId = snapshot.workspace.activeCanvasId;
  snapshot = await ui.snapshotAfter(async () => {
    await ui.click('[aria-label="切换画布"]'); await ui.click('[aria-label="新建画布"]');
  }, p => p.nodes.length === 0 && p.workspace.canvases.length === 2, 'new canvas active and first graph retained');
  const secondCanvasId = snapshot.workspace.activeCanvasId;
  snapshot = await ui.snapshotAfter(async () => {
    await ui.paletteAt({ x: 360, y: 200 }, '音频');
  }, p => p.nodes.length === 1 && p.nodes[0].data.kind === 'audio' && p.workspace.activeCanvasId === secondCanvasId, 'second canvas edit');
  const secondNodeId = snapshot.nodes[0].id;
  snapshot = await ui.snapshotAfter(async () => {
    await ui.click('[aria-label="切换画布"]'); await ui.click('.canvases-menu .canvas-row:nth-child(2) .canvas-name');
  }, p => p.workspace.activeCanvasId === firstCanvasId && p.nodes.length === 4, 'switch back retains first graph');
  assert.equal(snapshot.workspace.canvases.find(c => c.id === secondCanvasId).nodes[0].id, secondNodeId);
  await ui.key('s', { ctrl: true });
  await waitFor(`document.querySelector('.toast')?.textContent.includes('项目已保存')`, 'workspace manual save');
  const saved = await ctx.readProject(ctx.savedFile);
  assert.equal(saved.workspace.canvases.length, 2); assert.equal(saved.nodes.length, 4);
  const restoresBefore = state.restores;
  await ctx.flushAutosave(); await reload();
  await ctx.waitForAutosave(p => p.workspace.activeCanvasId === firstCanvasId && p.nodes.length === 4 && p.workspace.canvases.length === 2, 'cross-canvas restored full graph, independent of virtualization');
  assert.ok(state.restores > restoresBefore);
  snapshot = await ui.snapshotAfter(async () => {
    await ui.click('[aria-label="切换画布"]');
    await ui.click('.canvases-menu .canvas-row:last-child .canvas-name');
  }, p => p.workspace.activeCanvasId === secondCanvasId && p.nodes.length === 1 && p.nodes[0].id === secondNodeId, 'inactive canvas restored after real reload');
  ui.evidence('cross-canvas edit / switch / real manual save / startup restore / switch back', { firstCanvasId, secondCanvasId, secondNodeId, canvases: 2 });
  await runIsolatedClipboardAcceptance(ctx, ui, secondNodeId);
  await runPlanEditingAcceptance(ctx, ui);
  return { manualText, firstCanvasId, secondCanvasId };
}

async function runIsolatedClipboardAcceptance(ctx, ui, sentinelId) {
  const sentinel = 'V2 UNSELECTED SENTINEL MUST NEVER ENTER CLIPBOARD';
  await ui.snapshotAfter(async () => {
    await ui.click(`.react-flow__node[data-id="${sentinelId}"] .wf-node-label`);
    await ui.type(`.react-flow__node[data-id="${sentinelId}"] [aria-label="节点名称"]`, sentinel);
    await ui.blur();
  }, p => p.nodes.length===1&&p.nodes[0].data.title===sentinel, 'unselected clipboard sentinel persisted');
  await ui.paletteAt({ x: 900, y: 160 }, '文本');
  await ui.click('.kind-text .wf-try button:first-of-type');
  const marker = 'V2 SELECTED CLIPBOARD CLOSURE';
  let snapshot = await ui.snapshotAfter(async () => {
    await ui.type('[aria-label="文本输入内容"]', marker);
    // Focus a UI button, not the pane, to keep the prompt selected for grouping.
    await ui.click('[aria-label="缩放选项"]'); await ui.key('Escape'); await ui.key('g', { ctrl: true });
  }, p => p.nodes.length===3&&p.nodes.some(n=>n.data.kind==='group'), 'single selected prompt grouped for clipboard closure');
  const originalIds = new Set(snapshot.nodes.map(n=>n.id));
  await ui.key('c', { ctrl: true });
  await ctx.waitFor(`document.querySelector('.toast')?.textContent.includes('已复制选中节点')`, 'Ctrl+C serializes selected closure to isolated fixture clipboard');
  const raw = await ctx.evaluate('window.__whaleFixtureClipboardReadback()');
  assert.ok(raw.startsWith('WHALEFLOW_NODES\n')); assert.equal(raw.includes(sentinel), false);
  const payload = JSON.parse(raw.slice('WHALEFLOW_NODES\n'.length));
  assert.equal(payload.nodes.length, 2); assert.equal(payload.edges.length, 0);
  const copiedGroup = payload.nodes.find(n=>n.data.kind==='group'), copiedPrompt = payload.nodes.find(n=>n.data.kind==='prompt');
  assert.ok(copiedGroup&&copiedPrompt); assert.equal(copiedPrompt.parentId,copiedGroup.id); assert.equal(copiedPrompt.data.content,marker);
  for (let index=1;index<=3;index++) {
    snapshot = await ui.snapshotAfter(()=>ui.key('v',{ctrl:true}), p=>p.nodes.length===3+index*2, `Ctrl+V repeat ${index} persists only selected group closure`);
    assert.equal(new Set(snapshot.nodes.map(n=>n.id)).size,snapshot.nodes.length);
    assert.equal(new Set(snapshot.edges.map(e=>e.id)).size,snapshot.edges.length);
    assert.equal(snapshot.nodes.filter(n=>n.data.title===sentinel).length,1);
    assert.equal(snapshot.nodes.filter(n=>n.data.content===marker).length,index+1);
    for(const n of snapshot.nodes.filter(n=>!originalIds.has(n.id)&&n.data.kind==='prompt')) assert.ok(snapshot.nodes.some(g=>g.id===n.parentId&&g.data.kind==='group'));
  }
  ui.evidence('actual Ctrl+C → Ctrl+V three times: unique IDs, selected group closure only, unselected sentinel excluded', { clipboard:'isolated per-page memory mock; native OS clipboard NOT TESTED or accessed', repeats:3, nodes:snapshot.nodes.length, payloadNodes:payload.nodes.length });
}

async function runPlanEditingAcceptance(ctx, ui) {
  await ui.snapshotAfter(async()=>{
    await ui.click('[aria-label="切换画布"]'); await ui.click('[aria-label="新建画布"]');
    await ui.paletteAt({x:420,y:170},'脚本');
    await ui.type('.kind-script [aria-label="脚本创作要求"]','V2 本地分镜脚本演示');
  },p=>p.nodes.length===1&&p.nodes[0].data.kind==='script'&&p.nodes[0].data.content==='V2 本地分镜脚本演示','dedicated plan-node canvas');
  await ui.click('.kind-script [aria-label="生成脚本"]');
  await ctx.waitFor(`document.querySelector('[aria-label="运行工作流"]')&&document.querySelector('.kind-script .wf-plan')`,'demo plan displayed');
  await ctx.engine.waitForIdle();
  const generated=await ctx.waitForAutosave(p=>p.nodes.length===1&&Boolean(p.nodes[0].data.lastOutput?.plan),'real engine plan persisted');
  assert.equal(generated.nodes[0].data.lastOutput.demo,true);
  const selector='.kind-script [aria-label="脚本创作要求"]';
  const replacement='生成后连续输入：多字符保持焦点 ABC123';
  await ui.snapshotAfter(async()=>{
    await ui.click(selector); await ui.key('a',{ctrl:true});
    let expected='';
    for(const character of replacement){
      await ctx.send('Input.insertText',{text:character}); expected+=character;
      const actual=await ctx.evaluate(`(() => {const editor=document.querySelector(${JSON.stringify(selector)});return{focused:document.activeElement===editor,value:editor?.value??null};})()`);
      assert.equal(actual.focused,true,'Plan editor lost real keyboard focus after output invalidation');
      assert.equal(actual.value,expected,'Plan editor dropped a character during React rerender');
    }
    await ui.blur();
  },p=>p.nodes[0]?.data.content===replacement&&!p.nodes[0].data.lastOutput,'generated plan remains continuously editable with stable input focus');
  ui.evidence('real demo plan generation → character-by-character trusted editing preserves focus and persists full text', {kind:'script',characters:[...replacement].length,paidApis:false});
}

export async function runPersistenceAcceptance(ctx) {
  const { state, waitFor, evaluate, engine } = ctx, ui = controls(ctx);
  const demoEventStart = state.events.length;
  await ui.projectMenu(); await ui.click('[data-testid="load-demo"]');
  await waitFor(`document.querySelector('[aria-label="运行工作流"]')&&!document.querySelector('[aria-label="运行工作流"]').disabled`, 'explicit demo ready; complete node count comes from actual autosave');
  const demoSnapshot = await ctx.waitForAutosave(p => p.nodes.length === 5 && p.nodes.some(n => n.id === 'idea'), 'loaded demo autosave');
  assert.equal(demoSnapshot.settings.provider, 'demo');
  ui.evidence('project-menu → explicit demo loader yields original five nodes');
  await ui.click('[aria-label="运行工作流"]');
  await waitFor(`document.querySelector('[aria-label="运行工作流"]')&&(()=>{const image=document.querySelector('.kind-output img');return image?.complete&&image.naturalWidth>0;})()`, 'decoded output image and restored run button; five engine successes verified independently below');
  await engine.waitForIdle();
  assert.equal(new Set(state.events.slice(demoEventStart).filter(event => event.status === 'success').map(event => event.nodeId)).size, 5);
  assert.ok(state.events.filter(event => event.output?.image).every(event => event.output.demo === true));
  await ctx.waitForAutosave(p => p.nodes.length === 5 && p.nodes.every(n => n.data.lastOutput), 'successful demo outputs autosaved');
  ui.evidence('real local WorkflowEngine through explicit fixture: five successes / decoded SVG / button reset', { successes: 5 });

  const beforeSave = state.saves;
  await ui.key('s', { ctrl: true }); await waitFor(`document.querySelector('.toast')?.textContent.includes('项目已保存')`, 'demo save');
  const saved = await ctx.readProject(ctx.savedFile);
  assert.equal(state.saves, beforeSave + 1); assert.equal(saved.nodes.length, 5);
  assert.equal(Object.hasOwn(saved, 'settings'), false); assert.ok(saved.nodes.every(n => n.data.lastOutput));
  assert.match(saved.nodes.find(n => n.data.kind === 'output').data.lastOutput.image, /^data:image\/svg\+xml/);
  ui.evidence('UI save atomic file readback persists every output and portable data image without settings');

  await ui.fit();
  await ui.snapshotAfter(async () => {
    await ui.type('.kind-prompt textarea', 'Changed via real CDP keyboard: invalidate old demo results'); await ui.blur();
  }, p => p.nodes.find(n => n.id === 'idea').data.content.startsWith('Changed via real CDP') && ['idea', 'writer', 'visual', 'result'].every(id => !p.nodes.find(n => n.id === id).data.lastOutput), 'prompt edit invalidates old outputs');
  await waitFor(`!document.querySelector('.kind-text.success')&&!document.querySelector('.kind-image.success')&&!document.querySelector('.kind-output.success')&&!document.querySelector('.kind-image img')&&!document.querySelector('.kind-output img')`, 'stale downstream preview removed');
  ui.evidence('trusted prompt edit invalidates downstream status, images and persisted lastOutput');
  await ui.key('o', { ctrl: true });
  await waitFor(`(()=>{const image=document.querySelector('.kind-output img');return image?.complete&&image.naturalWidth>0;})()`, 'open restores decoded saved image');
  assert.equal(state.opens, 1);
  await ui.click('.react-flow__node[data-id="writer"] .wf-node-label');
  await waitFor(`document.querySelector('.kind-text [aria-label="复制文本"]')`, 'restored text copy affordance');
  ui.evidence('UI open restores saved outputs and exposes copy output control');

  // The fixture supplies a deliberately corrupt disk file through the real openProject contract.
  const savedBytes = await ctx.readFile(ctx.savedFile, 'utf8');
  const beforeBad = await ctx.waitForAutosave(p => p.nodes.every(n => n.data.lastOutput), 'pre-corruption graph');
  state.expectOpenFailure = true;
  try {
    await ctx.writeFile(ctx.savedFile, '{"version":999,"nodes":');
    await ui.key('o', { ctrl: true });
    await waitFor(`document.querySelector('.toast.error')`, 'bad file rejection visible');
    assert.equal(state.expectedErrors.length, 1); assert.equal((await ctx.readProject(ctx.autosaveFile)).nodes.length, 5);
    assert.deepEqual((await ctx.readProject(ctx.autosaveFile)).nodes, beforeBad.nodes, 'Bad import replaced the healthy autosave graph');
  } finally { state.expectOpenFailure = false; await ctx.writeFile(ctx.savedFile, savedBytes); }
  ui.evidence('bad disk project is rejected visibly without replacing current graph/autosave');

  const persistentSettings = { provider: 'demo', baseUrl: 'http://127.0.0.1:15432/browser-persistence', model: 'browser-demo-restored-model', imageModel: 'browser-demo-restored-image', audioModel: 'browser-demo-restored-audio', videoModel: 'browser-demo-restored-video', voice: 'browser-demo-voice', temperature: 0.7 };
  await ui.click('[aria-label="模型服务设置"]'); await ui.click('.provider-tabs button:nth-child(3)');
  await waitFor(`document.querySelectorAll('.settings-fields input:not([type="range"])').length===6`, 'all V2 settings exposed without running providers');
  const fields = [
    ['baseUrl', '.settings-fields > label:nth-child(1) input'],
    ['model', '.settings-fields > label:nth-child(2) input'],
    ['imageModel', '.settings-fields > .two-fields:nth-child(3) > label:nth-child(1) input'],
    ['audioModel', '.settings-fields > .two-fields:nth-child(3) > label:nth-child(2) input'],
    ['videoModel', '.settings-fields > .two-fields:nth-child(4) > label:nth-child(1) input'],
    ['voice', '.settings-fields > .two-fields:nth-child(4) > label:nth-child(2) input'],
  ];
  for (const [key, selector] of fields) await ui.type(selector, persistentSettings[key]);
  await ui.click('.provider-tabs button:nth-child(1)'); await ui.click('[aria-label="关闭设置"]');
  const matches = p => Object.entries(persistentSettings).every(([key, value]) => p.settings?.[key] === value);
  const configSaved = await ctx.waitForAutosave(matches, 'full V2 settings autosave');
  assert.deepEqual(configSaved.settings, persistentSettings);
  assert.deepEqual((await ctx.readProject(ctx.autosaveFile)).settings, persistentSettings);
  ui.evidence('real settings UI autosaves demo provider and all V2 model/voice fields');
  await ui.key('s', { ctrl: true }); await waitFor(`document.querySelector('.toast')?.textContent.includes('项目已保存')`, 'post-config manual save');
  const exported = await ctx.readProject(ctx.savedFile), serialized = JSON.stringify(exported);
  assert.equal(Object.hasOwn(exported, 'settings'), false);
  for (const key of ['baseUrl', 'model', 'imageModel', 'audioModel', 'videoModel', 'voice']) assert.equal(serialized.includes(persistentSettings[key]), false, `Export leaked app preference ${key}`);
  const hasSecret = value => value && typeof value === 'object' && Object.entries(value).some(([key, child]) => /(?:api[_-]?key|token|password|secret|authorization)$/i.test(key) || hasSecret(child));
  assert.equal(Boolean(hasSecret(exported)), false); assert.equal(Boolean(hasSecret(configSaved)), false);
  ui.evidence('manual portable export excludes settings, all app model values and credential fields');

  const restoresBefore = state.restores, autosavesBefore = state.autosaves;
  await ctx.flushAutosave();
  // Deliberate persistence fault injection, not an editing shortcut or claimed UI interaction.
  await evaluate(`localStorage.clear();localStorage.setItem('whaleflow-v2-config',JSON.stringify({provider:'ollama',baseUrl:'http://127.0.0.1:19999',model:'wrong-localStorage-model',imageModel:'wrong-localStorage-image',audioModel:'wrong-audio',videoModel:'wrong-video',voice:'wrong-voice',temperature:0.2}));`);
  await ctx.reload();
  await waitFor(`document.querySelector('.demo-chip')?.textContent.includes('离线演示')&&(()=>{const image=document.querySelector('.kind-output img');return image?.complete&&image.naturalWidth>0;})()`, 'disk startup restore overrides conflicting localStorage');
  await ctx.waitForAutosave(p => state.autosaves > autosavesBefore && matches(p), 'restored preferences re-autosaved');
  assert.ok(state.restores > restoresBefore); assert.deepEqual(state.lastRestoredSettings, persistentSettings);
  assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('whaleflow-v2-config'))`), persistentSettings);
  await ui.click('[aria-label="模型服务设置"]');
  await waitFor(`document.querySelector('.provider-tabs .selected')?.textContent.includes('离线演示')`, 'restored settings modal');
  assert.equal(await evaluate(`document.querySelectorAll('.settings-fields input').length`), 0);
  await ui.click('[aria-label="关闭设置"]');
  assert.equal(state.events.slice(demoEventStart).filter(event => event.status === 'running').length, 5, 'Editing/persistence accidentally started another workflow after the dedicated plan test');
  ui.evidence('startup disk settings override conflicting localStorage and return to visible offline demo', { exactHiddenSettingsVerifiedBy: 'real disk readback + startup bridge + app-written localStorage + new autosave' });
}
