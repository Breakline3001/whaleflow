import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { createNativeServer, CSP, NATIVE_BRIDGE } from '../native-shell/server.mjs';
import { node, edge, project } from './helpers.mjs';
import { assertArchivePath, sourceInputs, runtimeInputs, sourceTopFiles, sourceNativeFiles, sourceDirectories, runtimeFiles, runtimeDirectories, documents, modelModules, nativeSources, assertNativeSmoke, assertV4BrowserEvidence, libModules, version } from '../scripts/archive-helpers.mjs';

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(process.cwd(), '.native-test-'));
  const session = randomBytes(32).toString('base64');
  const readyPath = join(root, 'ready.json');
  const host = await createNativeServer({ session, dataDir: join(root, 'Data'), readyPath, ...overrides });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const request = (path, { method = 'GET', body, headers = {}, auth = true } = {}) => new Promise((resolve, reject) => {
    const req = http.request(`${host.origin}${path}`, { method, headers: { ...(auth ? { 'X-WhaleFlow-Session': session } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }); });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
  const rpc = (method, args = [], extra = {}) => request('/rpc', { method: 'POST', body: { method, args }, ...extra });
  return { ...host, root, readyPath, session, request, rpc };
}

test('native server requires canonical private session and absolute host paths', async () => {
  await assert.rejects(createNativeServer({ session: '', dataDir: process.cwd(), readyPath: join(process.cwd(), 'unused.json') }), /WHALEFLOW_HOST_SESSION/);
  await assert.rejects(createNativeServer({ session: randomBytes(32).toString('base64'), dataDir: 'relative', readyPath: join(process.cwd(), 'unused.json') }), /绝对路径/);
});

test('real HTTP authentication, Host, browser isolation, RPC validation and readiness', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(JSON.parse(await readFile(f.readyPath, 'utf8')), { port: f.port });
  assert.equal((await readFile(f.readyPath, 'utf8')).includes(f.session), false);
  assert.equal((await f.rpc('app.info', [], { auth: false })).status, 401);
  assert.equal((await f.rpc('app.info', [], { headers: { 'X-WhaleFlow-Session': 'x'.repeat(44) } })).status, 401);
  assert.equal((await f.request('/events', { auth: false })).status, 401);
  assert.equal((await f.rpc('app.info', [], { headers: { Host: `localhost:${f.port}` } })).status, 403);
  const browser = await f.rpc('app.info', [], { headers: { Origin: 'https://evil.example' } });
  assert.equal(browser.status, 403); assert.equal(browser.headers['access-control-allow-origin'], undefined);
  assert.equal((await f.rpc('app.info', [], { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 403);
  assert.deepEqual((await f.rpc('app.info')).json(), { result: { version: '0.5.0', platform: 'win32' } });
  for (const body of [{ method: 'constructor', args: [] }, { method: 'app.info', args: [1] }, { method: 'app.info' }, { method: 'app.info', args: [], extra: 1 }, [], 'not JSON']) {
    assert.equal((await f.request('/rpc', { method: 'POST', body })).status, 400);
  }
  assert.equal((await f.request('/rpc', { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.request('/rpc', { method: 'POST', body: '{}', headers: { 'Content-Length': String(100 * 1024 * 1024 + 1) } })).status, 413);
  assert.equal((await f.rpc('project.open', ['relative.json'])).status, 400);
  assert.equal((await f.rpc('workflow.run', [project(), { apiKey: 'not allowed' }])).status, 400);
});

test('static root injects external bridge before module and enforces strict CSP/assets only', async (t) => {
  const f = await fixture(t);
  const page = await f.request('/', { auth: false });
  assert.equal(page.status, 200); assert.equal(page.headers['content-security-policy'], CSP);
  assert.ok(page.text.indexOf('<script src="/native-bridge.js"></script>') < page.text.indexOf('<script type="module"'));
  assert.equal(/<script\b[^>]*>\s*[^<\s]/i.test(page.text), false);
  const bridge = await f.request('/native-bridge.js', { auth: false });
  assert.equal(bridge.status, 200); assert.equal(bridge.text, NATIVE_BRIDGE);
  assert.equal(bridge.text.includes(f.session), false); assert.equal(bridge.text.includes('fetch('), false);
  const asset = page.text.match(/src="\.?(\/assets\/[^\"]+)"/)[1];
  assert.equal((await f.request(asset, { auth: false })).status, 200);
  for (const path of ['/lib/project.mjs', '/electron/main.cjs', '/assets/../index.html', '/assets/%2e%2e/index.html', '/assets/%2e%2e%5clib%5cproject.mjs', '/assets/%00.js', '/index.html', '/assets/missing.js']) {
    assert.equal((await f.request(path, { auth: false })).status, 404, path);
  }
  assert.equal((await f.request('/', { headers: { Origin: 'https://evil.example' }, auth: false })).status, 403);
});

test('bridge exactly preserves preload API, C# messages, promises and independent event subscriptions', async () => {
  const calls = []; let receive;
  const window = { chrome: { webview: { postMessage: (message) => calls.push(message), addEventListener: (name, callback) => { assert.equal(name, 'message'); receive = callback; } } } };
  vm.runInNewContext(NATIVE_BRIDGE, { window, setTimeout });
  const desktop = window.desktop;
  const publicMethods = ['openProject', 'saveProject', 'autosave', 'restoreAutosave', 'importMedia', 'runWorkflow', 'cancelWorkflow', 'getAppInfo', 'onWorkflowEvent', 'getModelSettings', 'saveModelSettings', 'configureModelCredential', 'listProviderModels', 'cancelProviderModels'];
  assert.equal(publicMethods.length, 14);
  assert.deepEqual(Object.keys(desktop).sort(), publicMethods.sort());
  assert.equal(Object.isFrozen(desktop), true);
  const p = project(); const config = { settingsRevision: 7 };
  const save = { expectedRevision: 7, document: { version: 1, providers: [] } };
  const listing = { providerId: 'synthetic', expectedRevision: 7, requestId: 'metadata-static-1' };
  const promises = [desktop.openProject(), desktop.saveProject(p), desktop.saveProject(p, true), desktop.autosave(p), desktop.restoreAutosave(), desktop.importMedia(), desktop.runWorkflow(p, config), desktop.cancelWorkflow(), desktop.getAppInfo(), desktop.getModelSettings(), desktop.saveModelSettings(save), desktop.configureModelCredential('synthetic', 7, 'set'), desktop.listProviderModels(listing), desktop.cancelProviderModels('metadata-static-1')];
  assert.deepEqual(JSON.parse(JSON.stringify(calls.map(({ method, args }) => [method, args]))), [['openProject', []], ['saveProject', [p, false]], ['saveProject', [p, true]], ['autosave', [p]], ['restoreAutosave', []], ['importMedia', []], ['runWorkflow', [p, config]], ['cancelWorkflow', []], ['getAppInfo', []], ['getModelSettings', []], ['saveModelSettings', [save]], ['configureModelCredential', ['synthetic', 7, 'set']], ['listProviderModels', [listing]], ['cancelProviderModels', ['metadata-static-1']]]);
  for (const call of calls) receive({ data: { id: call.id, result: 'ok' } });
  assert.deepEqual(await Promise.all(promises), Array(14).fill('ok'));
  const rejected = desktop.getAppInfo(); receive({ data: { id: calls.at(-1).id, error: 'denied' } });
  await assert.rejects(rejected, /denied/);
  const conflict = desktop.saveModelSettings(save);
  receive({ data: { id: calls.at(-1).id, error: { message: 'settings changed', code: 'REVISION_CONFLICT', currentRevision: 8 } } });
  await assert.rejects(conflict, error => { assert.equal(error.message, 'settings changed'); assert.equal(error.code, 'REVISION_CONFLICT'); assert.equal(error.currentRevision, 8); return true; });
  const clear = desktop.configureModelCredential('synthetic', 8, 'clear');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).args)), ['synthetic', 8, 'clear']);
  receive({ data: { id: calls.at(-1).id, result: { cancelled: true, revision: 8 } } });
  assert.deepEqual(JSON.parse(JSON.stringify(await clear)), { cancelled: true, revision: 8 });
  const malformed = desktop.getModelSettings();
  receive({ data: { id: calls.at(-1).id, error: { message: 'invalid detail', code: 42, currentRevision: '8' } } });
  await assert.rejects(malformed, error => { assert.equal(error.message, 'invalid detail'); assert.equal(Object.hasOwn(error, 'code'), false); assert.equal(Object.hasOwn(error, 'currentRevision'), false); return true; });
  const events = []; const callback = (event) => events.push(event);
  const off1 = desktop.onWorkflowEvent(callback); const off2 = desktop.onWorkflowEvent(callback);
  const event = { runId: 'r', nodeId: 'n', status: 'running' };
  receive({ data: { event } }); assert.deepEqual(events, [event, event]);
  off1(); off1(); receive({ data: { event } }); assert.equal(events.length, 3);
  off2(); receive({ data: { event } }); assert.equal(events.length, 3);
  assert.throws(() => desktop.onWorkflowEvent(null), /必须是函数/);
});

test('archive static contract rejects private paths and requires new model source/runtime entries dynamically', async (t) => {
  for (const name of ['Data/autosave.json', 'lib/Data/private.json', 'model-settings.dpapi', 'tests/value.dpapi.backup', 'tests/model-settings.lock', 'lib/file.tmp', 'tests/file.tmp.json', 'artifacts/model-native-test.exe', 'tests/native-test.exe', 'host/test.exe', 'user.key', 'id_rsa', 'credentials.json', '.env.local', '../outside', 'tests/vendor/private.json', 'tests/.dsh/config.json']) {
    assert.throws(() => assertArchivePath(name, { source: true }), undefined, name);
  }
  assert.throws(() => assertArchivePath('native-test.exe'));
  assert.doesNotThrow(() => assertArchivePath('tests/fixtures/synthetic-provider.json', { source: true }));
  assert.doesNotThrow(() => assertArchivePath('native-shell/ModelSettings.cs', { source: true }));
  assert.doesNotThrow(() => assertArchivePath('host/node.exe'));
  const root = await mkdtemp(join(process.cwd(), '.native-archive-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'release', 'synthetic-output');
  const put = async (base, name, content = '') => { const file = join(base, name); await mkdir(dirname(file), { recursive: true }); await writeFile(file, content); };
  for (const dir of sourceDirectories) await mkdir(join(root, dir), { recursive: true });
  for (const dir of runtimeDirectories) await mkdir(join(output, dir), { recursive: true });
  for (const name of [...sourceTopFiles, ...sourceNativeFiles, ...modelModules]) await put(root, name);
  for (const name of [...runtimeFiles, ...modelModules]) await put(output, name);
  for (const name of documents) await put(root, name);
  await put(root, 'tests/fixtures/synthetic-provider.json', JSON.stringify({ marker: 'synthetic-only-not-a-user-key' }));
  await put(root, 'Data/model-settings.dpapi', 'synthetic excluded file');
  await put(root, 'artifacts/native-test.exe', 'synthetic excluded file');
  const source = await sourceInputs(root, output), runtime = await runtimeInputs(root, output);
  for (const file of [...nativeSources, ...modelModules]) assert(source.has(file), file);
  for (const file of modelModules) assert(runtime.has(file), file);
  assert(runtime.has('host/build-source-manifest.json'));
  assert(source.has('tests/fixtures/synthetic-provider.json'));
  assert([...source.keys(), ...runtime.keys()].every(name => !name.startsWith('Data/') && !name.startsWith('artifacts/')));
  await put(root, 'tests/new-regression.test.mjs');
  assert.equal((await sourceInputs(root, output)).size, source.size + 1, 'New tests must dynamically enter the exact source contract');
  await put(root, 'tests/native-test.exe');
  await assert.rejects(sourceInputs(root, output), /Binary|Private|Unexpected/);
});

test('archive dynamically includes all lib modules and gates on distinct v4 evidence', async (t) => {
  const modules = await libModules();
  assert(modules.includes('lib/creative-schema.mjs'));
  assert(modules.includes('lib/director-stage.mjs'));
  assert.deepEqual([...((await import('../scripts/archive-helpers.mjs')).evidenceFiles(process.cwd(), join(process.cwd(), 'release', 'test-output')).keys())].filter(name=>name.includes('v4-')).sort(), ['verification/v4-browser-integration.report.json','verification/v4-creative-studio.png','verification/v4-director-stage.png']);
  const root = await mkdtemp(join(process.cwd(), '.v4-evidence-test-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  await mkdir(join(root, 'artifacts'), {recursive:true});
  await mkdir(join(root, 'dist', 'assets'), {recursive:true});
  await writeFile(join(root, 'dist', 'index.html'), '<html></html>');
  await writeFile(join(root, 'dist', 'assets', 'app.js'), 'void 0;');
  const png = Buffer.from([137,80,78,71,13,10,26,10,0]);
  await writeFile(join(root, 'artifacts', 'v4-creative-studio.png'), png);
  await writeFile(join(root, 'artifacts', 'v4-director-stage.png'), png);
  const manifest = [{path:'index.html',sha256:createHash('sha256').update('<html></html>').digest('hex')},{path:'assets/app.js',sha256:createHash('sha256').update('void 0;').digest('hex')}];
  await writeFile(join(root, 'artifacts', 'v4-browser-integration.report.json'), JSON.stringify({passed:true,ok:true,errors:[],version,distUnchangedDuringRun:true,distManifest:manifest}));
  assert.equal((await assertV4BrowserEvidence(root)).version, version);
  const historical = JSON.parse(await readFile(join(root,'artifacts','v4-browser-integration.report.json'),'utf8'));
  historical.version = '0.3.0';
  await writeFile(join(root,'artifacts','v4-browser-integration.report.json'),JSON.stringify(historical));
  await assert.rejects(assertV4BrowserEvidence(root), /different version/);
});

test('archive static smoke contract keeps durable-output checks and rejects old-version evidence', () => {
  const report = { ok: true, details: { appInfo: { version, platform: 'win32' }, checks: ['app-ready-and-empty-canvas', 'project-menu-loads-five-node-demo', 'desktop-getAppInfo', 'visible-run-action-clicked', 'five-success-events-and-nodes', 'output-image-decoded', 'run-button-reset', 'autosave-restore-roundtrip', 'invalid-project-rejected-without-overwrite'], autosaveObservation: { nodeCount: 5, outputs: 5 }, outputImage: { width: 1024, height: 640 } } };
  report.details.modelSettingsChecks=['exact-fourteen-native-bridge-members','native-catalog-save-and-encrypted-readback','structured-cas-conflict-preserves-current-revision','native-password-modal-cancel-unchanged','native-password-modal-save-status-only-and-reopen','native-credential-clear','native-endpoint-change-invalidates-credential-binding','actual-settings-component-reloads-native-snapshot'];
  assert.doesNotThrow(() => assertNativeSmoke(report));
  const missingModel=structuredClone(report);missingModel.details.modelSettingsChecks.pop();assert.throws(()=>assertNativeSmoke(missingModel),/Missing native model settings/);
  const stale = structuredClone(report); stale.details.appInfo.version = '0.2.0';
  assert.throws(() => assertNativeSmoke(stale), /different version/);
  const lost = structuredClone(report); lost.details.autosaveObservation.outputs = 4;
  assert.throws(() => assertNativeSmoke(lost), /five durable outputs/);
  const missing = structuredClone(report); missing.details.checks.pop();
  assert.throws(() => assertNativeSmoke(missing), /Missing native acceptance/);
});

test('save/open roundtrip, ordered autosave, real media validation and secret rejection/redaction', async (t) => {
  const key = 'synthetic-native-test-private-model-key';
  const f = await fixture(t);
  assert.equal((await f.rpc('models.registerSecrets', [[key]])).status, 200);
  assert.deepEqual((await f.rpc('project.restore')).json(), { result: null });
  const path = join(f.root, 'roundtrip.json'); const p = project();
  assert.deepEqual((await f.rpc('project.save', [path, p])).json(), { result: { filePath: path } });
  assert.deepEqual((await f.rpc('project.open', [path])).json(), { result: p });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), p);
  assert.equal((await f.rpc('project.autosave', [p])).status, 200);
  const latest = { ...p, name: 'latest' };
  assert.equal((await f.rpc('project.autosave', [latest])).status, 200);
  assert.deepEqual((await f.rpc('project.restore')).json(), { result: latest });
  for (const secret of [key, f.session]) {
    const bad = project([node('a', 'prompt', { content: secret })]);
    for (const [method, args] of [['project.save', [path, bad]], ['project.autosave', [bad]]]) {
      const response = await f.rpc(method, args); assert.equal(response.status, 400); assert.equal(response.text.includes(secret), false);
    }
    const missing = await f.rpc('project.open', [join(f.root, secret.replaceAll('/', '_'), 'missing.json')]);
    assert.equal(missing.text.includes(secret), false);
  }
  const bad = project(); bad.token = 'credential';
  assert.equal((await f.rpc('project.save', [path, bad])).status, 400);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), p);
  await writeFile(join(f.root, 'Data', 'autosave.json'), 'broken');
  assert.equal((await f.rpc('project.restore')).status, 400);
  const png = join(f.root, 'sample.png'); await writeFile(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  const imported = (await f.rpc('media.import', [png])).json().result;
  assert.equal(imported.kind, 'image'); assert.ok(imported.url.startsWith('data:image/png;base64,'));
  await writeFile(png, 'not png'); assert.equal((await f.rpc('media.import', [png])).status, 400);
});

test('workspace and audio roundtrip over native RPC reject credentials hidden in embedded media', async (t) => {
  const key = 'synthetic-v3-native-private-key';
  const f = await fixture(t);
  assert.equal((await f.rpc('models.registerSecrets', [[key]])).status, 200);
  const bytes = Buffer.alloc(100); bytes.write('RIFF'); bytes.write('WAVE', 8);
  const url = () => `data:audio/wav;base64,${bytes.toString('base64')}`;
  const p = project([node('a', 'audio', { mediaUrl: url(), lastOutput: { audio: url(), demo: false } })]);
  p.workspace = { activeCanvasId: 'main', canvases: [{ id: 'main', name: 'Main', nodes: p.nodes, edges: p.edges, viewport: p.viewport }] };
  const path = join(f.root, 'workspace.json');
  assert.equal((await f.rpc('project.save', [path, p])).status, 200);
  assert.deepEqual((await f.rpc('project.open', [path])).json().result, p);
  assert.equal((await f.rpc('project.autosave', [p])).status, 200);
  assert.deepEqual((await f.rpc('project.restore')).json().result, p);
  for (const secret of [key, f.session]) {
    bytes.fill(0, 44); bytes.write(secret, 44);
    const bad = structuredClone(p); bad.workspace.canvases[0].nodes[0].data.lastOutput.audio = url();
    const response = await f.rpc('project.save', [path, bad]);
    assert.equal(response.status, 400); assert.equal(response.text.includes(secret), false);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), p);
  }
});

test('demo SSE immediately establishes, delivers ordered actual node outputs and releases subscriptions', async (t) => {
  const f = await fixture(t, { smoke: true });
  const controller = new AbortController();
  const response = await fetch(`${f.origin}/events`, { headers: { 'X-WhaleFlow-Session': f.session }, signal: controller.signal });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const events = [];
  const reader = response.body.getReader();
  const reading = (async () => {
    let buffered = '';
    while (events.length < 6) {
      const { value, done } = await reader.read(); if (done) break;
      buffered += new TextDecoder().decode(value);
      let index;
      while ((index = buffered.indexOf('\n\n')) >= 0) {
        const frame = buffered.slice(0, index); buffered = buffered.slice(index + 2);
        events.push(JSON.parse(frame.slice('data: '.length)));
      }
    }
  })();
  const p = project([node('a'), node('b', 'image'), node('c', 'output')], [edge('a', 'b'), edge('b', 'c')]);
  const run = (await f.rpc('workflow.run', [p, { provider: 'demo' }])).json().result;
  await reading;
  assert.deepEqual(events.map(({ nodeId, status }) => [nodeId, status]), [['a', 'running'], ['a', 'success'], ['b', 'running'], ['b', 'success'], ['c', 'running'], ['c', 'success']]);
  assert.ok(events.every((event) => event.runId === run.runId));
  assert.ok(events[3].output.image.startsWith('data:image/svg+xml')); assert.equal(events[3].output.demo, true);
  assert.equal(events[5].output.image, events[3].output.image);
  assert.equal(JSON.stringify(events).includes(f.session), false);
  controller.abort(); await reader.cancel().catch(() => {});
  for (const config of [{ provider: 'openai', model: 'x' }, { provider: 'ollama', model: 'x' }]) assert.equal((await f.rpc('workflow.run', [p, config])).status, 400);
  p.nodes[1].data.provider = 'openai';
  assert.equal((await f.rpc('workflow.run', [p, { provider: 'demo' }])).status, 400);
  assert.deepEqual((await f.rpc('workflow.cancel')).json(), { result: null });
  // Closing and reconnecting must not exhaust the bounded subscription pool.
  for (let i = 0; i < 10; i++) {
    const abort = new AbortController();
    const next = await fetch(`${f.origin}/events`, { headers: { 'X-WhaleFlow-Session': f.session }, signal: abort.signal });
    assert.equal(next.status, 200); abort.abort(); await next.body.cancel().catch(() => {});
  }
});

test('shutdown acknowledges, flushes accepted saves and closes listener/readiness', async (t) => {
  let resolveShutdown;
  const finished = new Promise((resolve) => { resolveShutdown = resolve; });
  const f = await fixture(t, { onShutdown: resolveShutdown });
  const path = join(f.root, 'shutdown-save.json'); const p = project();
  assert.equal((await f.rpc('project.save', [path, p])).status, 200);
  assert.deepEqual((await f.rpc('host.shutdown')).json(), { result: null });
  await finished;
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), p);
  await assert.rejects(readFile(f.readyPath), { code: 'ENOENT' });
  await assert.rejects(fetch(f.origin));
});
