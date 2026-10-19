import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultModelSettings, validateModelSettings, validateProvider, normalizeModelBaseUrl } from '../lib/model-settings-schema.mjs';
import { validateRunSnapshot, resolveRunBindings, createSecretRegistry, ModelMetadataService } from '../lib/model-settings.mjs';
import { WorkflowEngine } from '../lib/workflow.mjs';

const provider = (id = 'alpha', extra = {}) => ({ id, name: id, protocol: 'openai', baseUrl: `https://${id}.example/v1`, auth: 'required', allowInsecureHttpAuth: false, models: [{ id: 'shared', name: 'Shared', roles: ['text'] }], ...extra });
const doc = (providers = [provider()]) => ({ ...createDefaultModelSettings(), providers, defaults: { text: providers.length ? { providerId: providers[0].id, modelId: providers[0].models[0].id } : null, image: null, video: null, audio: null } });
const keyFor = (id) => `mock-private-credential-${id}`;
const runSnapshot = (document = doc()) => ({ revision: 7, document, credentials: Object.fromEntries(document.providers.filter((p) => p.auth === 'required').map((p) => [p.id, { protocol: p.protocol, baseUrl: p.baseUrl, value: keyFor(p.id) }])) });
const node = (id, kind = 'text', data = {}) => ({ id, type: 'workflow', position: { x: 0, y: 0 }, data: { kind, title: id, content: 'Generate a whale', ...data } });
const graph = (nodes = [node('a')], version = 1) => ({ version, name: 'mock graph', nodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
const json = (value, options = {}) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' }, ...options });
const offline = async () => { throw new Error('Network must not be called'); };
const metadataInput = (p = provider(), requestId = 'metadata1') => ({ provider: p, credential: p.auth === 'required' ? { protocol: p.protocol, baseUrl: p.baseUrl, value: keyFor(p.id) } : null, requestId });
async function configured(project, snapshot, options = {}) {
  const engine = new WorkflowEngine({ fetchImpl: offline, ...options });
  engine.runConfigured(project, snapshot);
  return await engine.waitForIdle();
}

// All credentials and model endpoints below are inert test fixtures; no real APIs are used.
test('public settings: deterministic defaults, normalization, fresh objects, no input mutation', () => {
  const one = createDefaultModelSettings(); const two = createDefaultModelSettings();
  one.general.temperature = 1; assert.equal(two.general.temperature, 0.7);
  assert.deepEqual(validateModelSettings(two), two);
  const value = doc(); value.providers[0].baseUrl = ' HTTPS://Alpha.Example:443/v1/// ';
  const result = validateModelSettings(value);
  assert.equal(result.providers[0].baseUrl, 'https://alpha.example/v1');
  result.providers[0].models[0].roles.push('image');
  assert.deepEqual(value.providers[0].models[0].roles, ['text']);
});

test('public settings: strict fields, secret fields, prototypes and malformed defaults reject without echoing input', () => {
  for (const mutate of [
    (v) => { v.apiKey = 'never echo'; },
    (v) => { v.providers[0].headers = {}; },
    (v) => { v.providers[0].models[0].credentialRef = 'no'; },
    (v) => { v.defaults.text = { providerId: 'alpha' }; },
    (v) => { v.general.extra = true; },
    (v) => { v.defaults.text.modelId = 'deleted'; },
    (v) => { v.providers[0].models[0].roles = ['image']; },
    (v) => { v.version = 2; },
  ]) {
    const value = doc(); mutate(value); assert.throws(() => validateModelSettings(value));
  }
  const marker = 'mock-sensitive-unknown-field';
  const value = doc(); value[marker] = 'no';
  assert.throws(() => validateModelSettings(value), (error) => !error.message.includes(marker));
  assert.throws(() => validateModelSettings(Object.create(doc())));
  const getter = doc(); Object.defineProperty(getter, 'version', { get() { throw new Error('getter invoked'); }, enumerable: true });
  assert.throws(() => validateModelSettings(getter), /JSON/);
});

test('public settings: catalog size, identifiers, uniqueness, roles and general bounds', () => {
  const models = (n) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, name: `M${i}`, roles: ['text'] }));
  assert.equal(validateProvider(provider('alpha', { models: models(256) })).models.length, 256);
  assert.throws(() => validateProvider(provider('alpha', { models: models(257) })));
  assert.throws(() => validateModelSettings(doc([provider(), provider()])));
  assert.throws(() => validateModelSettings(doc(Array.from({ length: 33 }, (_, i) => provider(`p${i}`)))));
  const large = doc([provider('a', { models: models(256) }), provider('b', { models: models(256) }), provider('c')]);
  assert.throws(() => validateModelSettings(large), /512/);
  for (const mutate of [
    (p) => { p.id = 'Invalid'; }, (p) => { p.name = 'x'.repeat(101); },
    (p) => { p.models.push({ ...p.models[0] }); }, (p) => { p.models[0].id = ' '; },
    (p) => { p.models[0].id = 'x'.repeat(201); }, (p) => { p.models[0].roles = ['text', 'text']; },
    (p) => { p.models[0].roles = ['unknown']; }, (p) => { p.protocol = 'anthropic'; },
    (p) => { p.protocol = 'responses'; }, (p) => { p.protocol = 'ollama'; p.models[0].roles = ['image']; },
  ]) { const p = provider(); mutate(p); assert.throws(() => validateProvider(p)); }
  for (const temperature of [-1, 2.1, Infinity, NaN, '1']) { const value = doc(); value.general.temperature = temperature; assert.throws(() => validateModelSettings(value)); }
  for (const temperature of [0, 2]) { const value = doc(); value.general.temperature = temperature; assert.equal(validateModelSettings(value).general.temperature, temperature); }
});

test('public URL policy rejects credentials/query/hash, metadata, linklocal and unspecified; preserves loopback/LAN', () => {
  for (const url of ['file:///tmp/model', 'https://user:pass@example.test', 'https://example.test?x=y', 'https://example.test/#x', 'http://169.254.169.254', 'http://0.0.0.0', 'http://[::]', 'http://[fe80::1]', 'http://[febf::1]', 'http://[::ffff:169.254.169.254]', 'http://metadata.google.internal', 'http://100.100.100.200', 'http://0xA9FEA9FE']) assert.throws(() => normalizeModelBaseUrl(url));
  for (const url of ['http://127.0.0.1:11434', 'http://localhost:11434', 'http://[::1]:11434']) assert.equal(validateProvider(provider('alpha', { baseUrl: url })).baseUrl, url);
  assert.throws(() => validateProvider(provider('alpha', { baseUrl: 'http://192.168.1.3:8080' })), /allowInsecureHttpAuth/);
  assert.equal(validateProvider(provider('alpha', { baseUrl: 'http://192.168.1.3:8080', allowInsecureHttpAuth: true })).baseUrl, 'http://192.168.1.3:8080');
  assert.equal(validateProvider(provider('alpha', { baseUrl: 'http://192.168.1.3', auth: 'none' })).baseUrl, 'http://192.168.1.3');
});

test('private snapshot: strict credential schema, endpoint/protocol binding, no orphan keys, and no public secret values', () => {
  const snapshot = runSnapshot(); assert.deepEqual(validateRunSnapshot(snapshot), snapshot);
  for (const mutate of [
    (s) => { s.revision = -1; }, (s) => { s.extra = true; },
    (s) => { s.credentials.beta = s.credentials.alpha; },
    (s) => { s.credentials.alpha.baseUrl = 'https://changed.example/v1'; },
    (s) => { s.credentials.alpha.protocol = 'ollama'; },
    (s) => { s.credentials.alpha.extra = true; },
    (s) => { s.credentials.alpha = { configured: true, source: 'saved' }; },
    (s) => { s.credentials.alpha.value = 'key\r\nheader'; },
    (s) => { s.credentials.alpha.value = 'x'.repeat(8193); },
    (s) => { s.document.providers[0].auth = 'none'; },
    (s) => { s.document.providers[0].name = keyFor('alpha'); },
  ]) { const s = runSnapshot(); mutate(s); assert.throws(() => validateRunSnapshot(s)); }
  const registry = createSecretRegistry(['retired-secret']); const s = runSnapshot(); s.document.general.voice = 'retired-secret';
  assert.throws(() => validateRunSnapshot(s, { secretRegistry: registry }), /敏感凭据/);
});

test('configured execution: default role applies real endpoint/key/general, never old global configuration', async () => {
  const snapshot = runSnapshot(); snapshot.document.general.temperature = 0.2;
  let call;
  const result = await configured(graph(), snapshot, { apiKey: 'unrelated-legacy-host-key', fetchImpl: async (url, options) => { call = { url, options }; return json({ choices: [{ message: { content: 'Generated text' } }] }); } });
  assert.equal(result.status, 'success'); assert.equal(call.url, 'https://alpha.example/v1/chat/completions');
  assert.equal(call.options.headers.Authorization, `Bearer ${keyFor('alpha')}`);
  assert.deepEqual(JSON.parse(call.options.body), { model: 'shared', messages: [{ role: 'user', content: 'Generate a whale' }], stream: false, temperature: 0.2 });
});

test('configured execution: every node preflight precedes fetch and event; no credential/env fallback', () => {
  let calls = 0; let events = 0;
  const engine = new WorkflowEngine({ apiKey: 'legacy-not-for-new-providers', fetchImpl: async () => { calls++; }, onEvent: () => events++ });
  const s = runSnapshot(); s.credentials = {};
  assert.throws(() => engine.runConfigured(graph(), s), /缺少/);
  const p = graph([node('first'), node('bad', 'text', { model: 'not-in-catalog' })]);
  assert.throws(() => engine.runConfigured(p, runSnapshot()), /模型/);
  assert.throws(() => engine.runConfigured(graph([node('first'), node('bad', 'image')]), runSnapshot()), /image/);
  assert.throws(() => engine.runConfigured(graph([node('bad', 'text', { provider: 'ollama' })]), runSnapshot()), /协议/);
  assert.equal(calls, 0); assert.equal(events, 0); assert.equal(engine.running, false);
});

test('configured execution: explicit demo and passive nodes remain offline, empty catalog demo does not modify defaults', async () => {
  const s = runSnapshot(); s.document.defaults.text = null; s.credentials = {};
  const result = await configured(graph([node('demo', 'text', { provider: 'demo' }), node('note', 'note'), node('prompt', 'prompt'), node('output', 'output')]), s);
  assert.equal(result.status, 'success'); assert.equal(result.outputs.demo.demo, true);
  const empty = runSnapshot(doc([])); assert.equal((await configured(graph(), empty)).outputs.a.demo, true);
  assert.equal(empty.document.defaults.text, null);
});

test('configured execution: shared engine lock and immutable deep snapshots across settings edits', async () => {
  let enter; const started = new Promise((resolve) => { enter = resolve; });
  let release; const held = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const engine = new WorkflowEngine({ fetchImpl: async (url, options) => { calls.push({ url, options }); enter(); await held; return json({ choices: [{ message: { content: 'Stable snapshot' } }] }); } });
  const p = graph([node('a'), node('b')]); const s = runSnapshot();
  engine.runConfigured(p, s); const pending = engine.waitForIdle();
  assert.equal(engine.running, true); assert.throws(() => engine.run(p), /正在运行/); assert.throws(() => engine.runConfigured(p, s), /正在运行/);
  await started;
  s.document.providers[0].baseUrl = 'https://changed.example'; s.credentials.alpha.value = 'newly-edited-key'; p.nodes[1].data.content = 'Edited graph';
  release(); const result = await pending;
  assert.equal(result.status, 'success'); assert.equal(calls.length, 2);
  for (const call of calls) { assert.equal(call.url, 'https://alpha.example/v1/chat/completions'); assert.equal(call.options.headers.Authorization, `Bearer ${keyFor('alpha')}`); }
  assert.equal(JSON.parse(calls[1].options.body).messages[0].content, 'Generate a whale');
  engine.run(graph([node('local', 'prompt')])); assert.throws(() => engine.runConfigured(graph(), runSnapshot()), /正在运行/); await engine.waitForIdle();
});

test('configured execution: all known/unused/retired credentials protect text, thrown errors and decoded binary media', async () => {
  const registry = createSecretRegistry(['retired-mock-secret']); registry.register(['unused-mock-secret']);
  for (const fetchImpl of [
    async () => json({ choices: [{ message: { content: 'unused-mock-secret' } }] }),
    async () => { throw new Error('retired-mock-secret'); },
    async () => json({ choices: [{ message: { content: keyFor('beta') } }] }),
  ]) {
    const events = []; const result = await configured(graph(), runSnapshot(doc([provider(), provider('beta')])), { secretRegistry: registry, fetchImpl, onEvent: (event) => events.push(event) });
    assert.equal(result.status, 'error'); const emitted = JSON.stringify({ result, events });
    for (const secret of registry.values()) assert.equal(emitted.includes(secret), false);
  }
  const p = provider('alpha', { models: [{ id: 'voice-model', name: 'Voice', roles: ['audio'] }] });
  const d = createDefaultModelSettings(); d.providers = [p]; d.defaults.audio = { providerId: 'alpha', modelId: 'voice-model' };
  const bytes = Buffer.alloc(128); bytes.write('RIFF'); bytes.write('WAVE', 8); bytes.write('retired-mock-secret', 44);
  const result = await configured(graph([node('audio', 'audio')]), runSnapshot(d), { secretRegistry: registry, fetchImpl: async () => new Response(bytes, { headers: { 'content-type': 'audio/wav' } }) });
  assert.equal(result.status, 'error'); assert.equal(result.outputs.audio, undefined);
  const imported = graph([node('imported', 'audio', { mediaUrl: `data:audio/wav;base64,${bytes.toString('base64')}` })]);
  assert.throws(() => resolveRunBindings(imported, runSnapshot(doc([])), { secretRegistry: registry }), /敏感凭据/);
});

test('metadata: GET-only OpenAI and Ollama lists, no role inference, no settings mutation', async () => {
  for (const protocol of ['openai', 'ollama']) {
    const p = provider('alpha', { protocol, auth: protocol === 'ollama' ? 'none' : 'required' }); const input = metadataInput(p);
    const before = structuredClone(input); let call;
    const service = new ModelMetadataService({ fetchImpl: async (url, options) => { call = { url, options }; return json(protocol === 'ollama' ? { models: [{ model: 'remote-model', name: 'Remote' }] } : { data: [{ id: 'remote-model', name: 'Remote' }] }); } });
    assert.deepEqual(await service.list(input), { requestId: 'metadata1', providerId: 'alpha', models: [{ id: 'remote-model', name: 'Remote' }], source: 'metadata' });
    assert.equal(call.url, `${p.baseUrl}${protocol === 'ollama' ? '/api/tags' : '/models'}`); assert.equal(call.options.method, 'GET'); assert.equal(call.options.redirect, 'error'); assert.equal(call.options.body, undefined);
    assert.equal(call.options.headers.Authorization, protocol === 'ollama' ? undefined : `Bearer ${keyFor('alpha')}`);
    assert.deepEqual(input, before);
  }
});

test('metadata: refuses private origin, missing/stale binding, unsafe URL before fetch', async () => {
  let calls = 0; const service = new ModelMetadataService({ fetchImpl: async () => { calls++; } });
  service.setForbiddenOrigins(['https://alpha.example']);
  await assert.rejects(service.list(metadataInput()), /私有 origin/);
  const missing = metadataInput(); missing.credential = null; await assert.rejects(service.list(missing), /缺少/);
  const changed = metadataInput(); changed.credential.baseUrl = 'https://elsewhere.example'; await assert.rejects(service.list(changed), /绑定/);
  const unsafe = metadataInput(); unsafe.provider.baseUrl = 'http://169.254.169.254'; await assert.rejects(service.list(unsafe));
  assert.equal(calls, 0);
});

test('metadata: cancellation and total timeout settle even with non-cooperative fetch/body; duplicate IDs reject', async () => {
  let signal;
  const service = new ModelMetadataService({ fetchImpl: async (_url, options) => { signal = options.signal; return await new Promise(() => {}); } });
  const pending = service.list(metadataInput());
  await assert.rejects(service.list(metadataInput()), /正在使用/);
  service.cancel('metadata1'); await assert.rejects(pending, /取消/); assert.equal(signal.aborted, true);
  const timeout = new ModelMetadataService({ timeoutMs: 10, fetchImpl: async () => new Response(new ReadableStream({ start() {} })) });
  await assert.rejects(timeout.list(metadataInput()), /总时限/);
  const fetchTimeout = new ModelMetadataService({ timeoutMs: 10, fetchImpl: async () => await new Promise(() => {}) });
  await assert.rejects(fetchTimeout.list(metadataInput()), /总时限/);
  const signals = [];
  const bulk = new ModelMetadataService({ fetchImpl: async (_url, options) => { signals.push(options.signal); return await new Promise(() => {}); } });
  const requests = ['bulk1', 'bulk2'].map((id) => bulk.list(metadataInput(provider(), id)));
  const cancelled = requests.map((request) => assert.rejects(request, /取消/));
  bulk.cancelAll(); await Promise.all(cancelled);
  assert.equal(signals.length, 2); assert.equal(signals.every((signal) => signal.aborted), true);
  bulk.cancelAll(); // Shutdown cancellation is idempotent after every request has settled.
});

test('metadata: body/item limits, redirect/error responses and all known-secret reflections reject without mutation/leak', async () => {
  const registry = createSecretRegistry(['retired-metadata-key']);
  const cases = [
    async () => new Response('x', { headers: { 'content-length': '1048577' } }),
    async () => new Response(new Uint8Array(1024 * 1024 + 1)),
    async () => json({ data: Array.from({ length: 513 }, (_, i) => ({ id: `m${i}` })) }),
    async () => new Response(null, { status: 302, headers: { location: 'https://cdn.example' } }),
    async () => new Response('private error', { status: 401 }),
    async () => { throw new Error(keyFor('alpha')); },
    async () => json({ data: [{ id: 'retired-metadata-key' }] }),
    async () => json({ data: [{ id: keyFor('alpha') }] }),
    async () => json({ data: [{ id: 'duplicate' }, { id: 'duplicate' }] }),
    async () => new Response('not json'),
  ];
  for (const fetchImpl of cases) {
    const service = new ModelMetadataService({ fetchImpl, secretRegistry: registry }); const input = metadataInput(); const before = structuredClone(input);
    await assert.rejects(service.list(input), (error) => !registry.values().some((secret) => error.message.includes(secret)));
    assert.deepEqual(input, before);
  }
});

test('version2 refs route same-name models to distinct providers and keys; explicit refs beat old model overrides', async () => {
  const calls = [];
  const snapshot = runSnapshot(doc([provider(), provider('beta')]));
  const project = graph([
    node('alpha', 'text', { model: 'old-unknown-name', modelRef: { providerId: 'alpha', modelId: 'shared' } }),
    node('beta', 'text', { modelRef: { providerId: 'beta', modelId: 'shared' } }),
  ], 2);
  const result = await configured(project, snapshot, { fetchImpl: async (url, options) => { calls.push({ url, options }); return json({ choices: [{ message: { content: 'Independent provider output' } }] }); } });
  assert.equal(result.status, 'success'); assert.equal(calls.length, 2);
  for (const [index, id] of ['alpha', 'beta'].entries()) {
    assert.equal(calls[index].url, `https://${id}.example/v1/chat/completions`);
    assert.equal(calls[index].options.headers.Authorization, `Bearer ${keyFor(id)}`);
    assert.equal(JSON.parse(calls[index].options.body).model, 'shared');
    assert.equal(JSON.stringify(calls[index]).includes(keyFor(id === 'alpha' ? 'beta' : 'alpha')), false);
  }
  assert.equal(JSON.stringify(calls).includes('credentials'), false); assert.equal(JSON.stringify(calls).includes('workspace'), false);
});

test('version2 unknown/deleted refs, role mismatch and old protocol mismatch preflight entire graph before fetch', () => {
  let calls = 0; let events = 0;
  const engine = new WorkflowEngine({ fetchImpl: async () => { calls++; }, onEvent: () => events++ });
  const cases = [
    node('bad', 'text', { modelRef: { providerId: 'deleted', modelId: 'shared' } }),
    node('bad', 'text', { modelRef: { providerId: 'alpha', modelId: 'deleted' } }),
    node('bad', 'image', { modelRef: { providerId: 'alpha', modelId: 'shared' } }),
    node('bad', 'text', { provider: 'ollama', modelRef: { providerId: 'alpha', modelId: 'shared' } }),
    node('bad', 'text', { modelRef: { providerId: 'alpha' } }),
  ];
  for (const bad of cases) assert.throws(() => engine.runConfigured(graph([node('good'), bad], 2), runSnapshot()));
  assert.throws(() => engine.runConfigured(graph([node('legacy', 'text', { modelRef: { providerId: 'alpha', modelId: 'shared' } })], 1), runSnapshot()), /version/);
  assert.equal(calls, 0); assert.equal(events, 0); assert.equal(engine.running, false);
});

test('version2 selected image model controls both payload and capability validation, not stale imageModel', async () => {
  const p = provider('alpha', { models: [{ id: 'gpt-image-1', name: 'Image', roles: ['image'] }] });
  const d = createDefaultModelSettings(); d.providers = [p];
  let body;
  const result = await configured(graph([node('image', 'image', { imageModel: 'dall-e-3', batchSize: 2, modelRef: { providerId: 'alpha', modelId: 'gpt-image-1' } })], 2), runSnapshot(d), {
    fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return json({ data: [{ b64_json: 'iVBORw0KGgo=' }, { b64_json: 'iVBORw0KGgo=' }] }); },
  });
  assert.equal(result.status, 'success'); assert.equal(body.model, 'gpt-image-1'); assert.equal(body.n, 2);
});

test('version2 selected audio/video models control actual adapter payloads and general voice is used', async () => {
  const p = provider('alpha', { models: [{ id: 'selected-audio', name: 'Audio', roles: ['audio'] }, { id: 'selected-video', name: 'Video', roles: ['video'] }] });
  const d = createDefaultModelSettings(); d.providers = [p]; d.general.voice = 'nova';
  const wav = Buffer.alloc(44); wav.write('RIFF'); wav.write('WAVE', 8);
  const mp4 = Buffer.alloc(32); mp4.write('ftyp', 4);
  const calls = [];
  const result = await configured(graph([
    node('audio', 'audio', { audioModel: 'stale-audio', modelRef: { providerId: 'alpha', modelId: 'selected-audio' } }),
    node('video', 'video', { videoModel: 'stale-video', modelRef: { providerId: 'alpha', modelId: 'selected-video' } }),
  ], 2), runSnapshot(d), {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/audio/speech')) return new Response(wav, { headers: { 'content-type': 'audio/wav' } });
      if (url.endsWith('/videos')) return json({ id: 'mockjob', status: 'completed' });
      return new Response(mp4, { headers: { 'content-type': 'video/mp4' } });
    },
  });
  assert.equal(result.status, 'success'); assert.equal(JSON.parse(calls[0].options.body).model, 'selected-audio');
  assert.equal(JSON.parse(calls[0].options.body).voice, 'nova'); assert.equal(calls[1].options.body.get('model'), 'selected-video');
});

test('null modelRef means inherit in both supported project versions; sparse/extended public arrays reject', async () => {
  for (const version of [1, 2]) {
    const result = await configured(graph([node('a', 'text', { modelRef: null })], version), runSnapshot(), { fetchImpl: async () => json({ choices: [{ message: { content: 'Inherited model' } }] }) });
    assert.equal(result.status, 'success');
  }
  for (const mutate of [
    (d) => { d.providers = Array(1); },
    (d) => { d.providers[0].models = Array(1); d.defaults.text = null; },
    (d) => { d.providers[0].models[0].roles = ['text', ,]; },
    (d) => { d.providers[0].models.extra = true; },
  ]) { const d = doc(); mutate(d); assert.throws(() => validateModelSettings(d)); }
});

test('secret registry is add-only, does not expose mutable storage, rejects malformed registration', () => {
  const registry = createSecretRegistry(['first-mock-key']); const values = registry.values(); values.length = 0;
  registry.register(['second-mock-key', 'first-mock-key']);
  assert.deepEqual(registry.values(), ['first-mock-key', 'second-mock-key']);
  assert.throws(() => registry.register(['valid', ''])); assert.equal(registry.values().includes('valid'), false);
});
