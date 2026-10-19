import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { executeWorkflow, topologicalSort, validateConfig, WorkflowEngine } from '../lib/workflow.mjs';
import { project, node, edge, jsonResponse } from './helpers.mjs';

const settings = { provider: 'demo', baseUrl: '', model: '' };
const noNetwork = async () => { throw new Error('demo must never contact a network'); };

test('DAG topological order respects dependencies and stable independent node ordering', () => {
  const p = project([node('c'), node('b'), node('a'), node('d')], [edge('a', 'b'), edge('b', 'c')]);
  assert.deepEqual(topologicalSort(p).map((n) => n.id), ['a', 'd', 'b', 'c']);
});

test('demo outputs are deterministic, visibly labelled, portable, and make no network request', async () => {
  const p = project([node('a'), node('b', 'text'), node('c', 'image'), node('d', 'output')], [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')]);
  const events = [];
  const result = await executeWorkflow(p, settings, { onEvent: (event) => events.push(event), fetchImpl: noNetwork });
  const again = await executeWorkflow(p, settings, { fetchImpl: noNetwork });
  assert.equal(result.status, 'success');
  assert.deepEqual(result.outputs, again.outputs);
  assert.match(result.outputs.b.text, /DEMO.*非真实 AI/);
  assert.equal(result.outputs.b.demo, true);
  assert.match(result.outputs.c.image, /^data:image\/svg\+xml/);
  assert.match(decodeURIComponent(result.outputs.c.image), /NOT AI GENERATED/);
  assert.equal(result.outputs.d.image, result.outputs.c.image);
  assert.equal(result.outputs.d.demo, true);
  assert.deepEqual(events.map((e) => [e.nodeId, e.status]), ['a', 'b', 'c', 'd'].flatMap((id) => [[id, 'running'], [id, 'success']]));
  assert(events.every((event) => event.runId === result.runId));
});

test('OpenAI text adapter uses /chat/completions with upstream output and bearer credential', async () => {
  let call;
  const p = project([node('a', 'prompt', { content: 'upstream prompt' }), node('b', 'text', { content: 'be concise', model: 'node-model' })], [edge('a', 'b')]);
  const result = await executeWorkflow(p, { provider: 'openai', baseUrl: 'https://models.example/v1/', model: 'fallback', temperature: 0.4 }, {
    apiKey: 'test-only-key', fetchImpl: async (url, options) => { call = { url, options }; return jsonResponse({ choices: [{ message: { content: 'real provider text' } }] }); },
  });
  assert.equal(result.status, 'success');
  assert.equal(call.url, 'https://models.example/v1/chat/completions');
  assert.equal(call.options.headers.Authorization, 'Bearer test-only-key');
  const body = JSON.parse(call.options.body);
  assert.equal(body.model, 'node-model'); assert.equal(body.temperature, 0.4); assert.equal(body.stream, false);
  assert.match(body.messages[0].content, /upstream prompt[\s\S]*be concise/);
  assert.equal(body.apiKey, undefined); assert.equal(result.outputs.b.demo, false);
});

test('Ollama /api/chat sends nonstreaming messages and options.temperature', async () => {
  let call;
  const result = await executeWorkflow(project([node('a', 'text')]), { provider: 'ollama', model: 'qwen3', temperature: 0 }, {
    fetchImpl: async (url, options) => { call = { url, options }; return jsonResponse({ message: { role: 'assistant', content: 'Ollama reply' } }); },
  });
  assert.equal(call.url, 'http://127.0.0.1:11434/api/chat');
  assert.deepEqual(JSON.parse(call.options.body).options, { temperature: 0 });
  assert.equal(result.outputs.a.text, 'Ollama reply');
});

test('OpenAI images use imageModel (not node/text model) and aggregate upstream output', async () => {
  const p = project([node('a', 'prompt', { content: 'blue whale' }), node('b', 'image', { model: 'ignored-text-model', content: 'sunset' })], [edge('a', 'b')]);
  let call;
  const result = await executeWorkflow(p, { provider: 'openai', baseUrl: 'https://models.example/v1', model: 'text-only', imageModel: 'image-generator' }, {
    fetchImpl: async (url, options) => { call = { url, options }; return jsonResponse({ data: [{ b64_json: 'iVBORw0KGgo=' }] }); },
  });
  assert.equal(result.status, 'success');
  assert.equal(call.url, 'https://models.example/v1/images/generations');
  const body = JSON.parse(call.options.body);
  assert.equal(body.model, 'image-generator'); assert.match(body.prompt, /blue whale[\s\S]*sunset/);
  assert.equal(result.outputs.b.image, 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(result.outputs.b.demo, false);
});

test('generated remote images are downloaded and embedded without sending API credentials to CDN', async () => {
  const calls = [];
  const result = await executeWorkflow(project([node('a', 'image')]), { provider: 'openai', model: '', imageModel: 'image-generator' }, {
    apiKey: 'test-api-key', fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1 ? jsonResponse({ data: [{ url: 'https://cdn.example/picture?signature=abc' }] }) : new Response(Buffer.from('png'), { headers: { 'content-type': 'image/png' } });
    },
  });
  assert.equal(result.status, 'success'); assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers, undefined);
  assert.equal(result.outputs.a.image, 'data:image/png;base64,cG5n');
});

test('missing image model, unsupported image provider and video generation fail rather than fake', async () => {
  for (const [kind, config, expected] of [
    ['image', { provider: 'openai', model: 'text-model' }, /imageModel/],
    ['image', { provider: 'ollama', model: 'text-model' }, /只支持 OpenAI/],
    ['video', settings, /未配置视频生成模型/],
  ]) {
    const events = [];
    const result = await executeWorkflow(project([node('a', kind), node('b', 'output')], [edge('a', 'b')]), config, { fetchImpl: noNetwork, onEvent: (event) => events.push(event) });
    assert.equal(result.status, 'error'); assert.match(events.at(-1).error, expected);
    assert(!events.some((event) => event.nodeId === 'b')); assert.equal(result.outputs.a, undefined);
  }
});

test('imported media pass through without generation or demo flag, and output preserves real video', async () => {
  const url = 'data:video/mp4;base64,aGVsbG8=';
  const result = await executeWorkflow(project([node('a', 'video', { mediaUrl: url }), node('b', 'output')], [edge('a', 'b')]), settings, { fetchImpl: noNetwork });
  assert.equal(result.status, 'success'); assert.equal(result.outputs.b.video, url); assert.equal(result.outputs.b.demo, false);
});

test('HTTP errors, malformed JSON, empty replies and credential-bearing replies fail cleanly', async () => {
  for (const fetchImpl of [
    async () => jsonResponse({ error: { message: 'sensitive provider body must not leak' } }, 401),
    async () => new Response('not-json'),
    async () => jsonResponse({ choices: [] }),
    async () => { throw new Error('failed with test-secret'); },
    async () => jsonResponse({ choices: [{ message: { content: 'test-secret' } }] }),
  ]) {
    const events = [];
    const result = await executeWorkflow(project([node('a', 'text'), node('b', 'text')], [edge('a', 'b')]), { provider: 'openai', model: 'm' }, { apiKey: 'test-secret', fetchImpl, onEvent: (e) => events.push(e) });
    assert.equal(result.status, 'error'); assert.equal(events.at(-1).status, 'error');
    assert(!JSON.stringify({ result, events }).includes('test-secret'));
    assert(!JSON.stringify(events).includes('sensitive provider body'));
    assert(!events.some((e) => e.nodeId === 'b'));
  }
});

test('workflow config rejects token fields, unknown options, unsafe URLs, and invalid temperature', () => {
  assert.equal(validateConfig().provider, 'demo');
  for (const config of [ { provider: 'bad' }, { apiKey: 'nope' }, { token: 'nope' }, { headers: {} }, { temperature: NaN }, { temperature: 3 }, { baseUrl: 'file:///etc/passwd' }, { baseUrl: 'https://user:pass@example.test' }, { baseUrl: 'https://example.test?key=abc' } ]) assert.throws(() => validateConfig(config));
});

test('cancel aborts an active provider request and marks pending nodes cancelled', async () => {
  const emitter = new EventEmitter();
  const events = [];
  const controller = new AbortController();
  const pending = executeWorkflow(project([node('a', 'text'), node('b', 'output')], [edge('a', 'b')]), { provider: 'ollama', model: 'm' }, {
    signal: controller.signal, onEvent: (e) => events.push(e),
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }); emitter.emit('started'); }),
  });
  await once(emitter, 'started'); controller.abort();
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(events.map((e) => [e.nodeId, e.status]), [['a', 'running'], ['a', 'cancelled'], ['b', 'cancelled']]);
});

test('engine returns runId immediately, rejects concurrent runs and permits later run after cancellation', async () => {
  const events = [];
  const engine = new WorkflowEngine({ onEvent: (e) => events.push(e), fetchImpl: noNetwork });
  assert.throws(() => engine.run(project([], []), settings), /没有节点/);
  const { runId } = engine.run(project([node('a', 'text'), node('b', 'text')], [edge('a', 'b')]), settings);
  assert.match(runId, /^[a-f0-9-]+$/); assert.equal(events.length, 0);
  assert.throws(() => engine.run(project(), settings), /正在运行/);
  await engine.cancel(); assert.equal(engine.running, false);
  assert(events.every((e) => e.status === 'cancelled'));
  const next = engine.run(project([node('c', 'text')]), settings);
  const result = await engine.waitForIdle();
  assert.equal(result.runId, next.runId); assert.equal(result.status, 'success');
  await engine.cancel();
});

test('engine snapshots project/config against renderer mutations after run', async () => {
  const p = project([node('a', 'text')]);
  const config = { ...settings };
  const engine = new WorkflowEngine({ fetchImpl: noNetwork });
  engine.run(p, config);
  p.nodes[0].data.content = 'tampered'; config.provider = 'openai';
  const result = await engine.waitForIdle();
  assert.equal(result.status, 'success'); assert.match(result.outputs.a.text, /a content/); assert.doesNotMatch(result.outputs.a.text, /tampered/);
});
