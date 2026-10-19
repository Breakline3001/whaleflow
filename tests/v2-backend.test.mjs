import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { once, EventEmitter } from 'node:events';
import { validateProject, serializeProject, parseProject, importMediaFile, validateMediaUrl, MAX_MEDIA_BYTES, MAX_PROJECT_BYTES, NODE_KINDS, writeProject } from '../lib/project.mjs';
import { executeWorkflow, validateConfig } from '../lib/workflow.mjs';
import { node, edge, project, jsonResponse } from './helpers.mjs';

const offline = async () => { throw new Error('Real network is forbidden'); };
function wav(extra = 0) {
  const bytes = Buffer.alloc(44 + extra); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(extra, 40); return bytes;
}
function mp4() { const b = Buffer.alloc(24); b.writeUInt32BE(24, 0); b.write('ftypisom', 4); return b; }
const audioUrl = (bytes = wav()) => `data:audio/wav;base64,${bytes.toString('base64')}`;
const openai = { provider: 'openai', baseUrl: 'https://mock.invalid/v1', model: 'text', audioModel: 'tts', videoModel: 'video', voice: 'alloy' };
async function temp(t) { const dir = await mkdtemp(join(process.cwd(), '.v2-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

// All remote adapters below use injected fetch; no paid or live provider is contacted.
test('v2 preserves version1, workflow type and validates group hierarchy and dimensions', () => {
  for (const kind of ['audio', 'group', 'script', 'clip', 'director', 'shots', 'asset']) assert(NODE_KINDS.includes(kind));
  const a = node('a', 'group'); const b = { ...node('b', 'text'), parentId: 'a', extent: 'parent', width: 320, height: 200 };
  assert.doesNotThrow(() => validateProject(project([a, b])));
  for (const mutate of [
    (p) => { p.nodes[1].parentId = 'missing'; }, (p) => { p.nodes[0].data.kind = 'text'; },
    (p) => { p.nodes[0].parentId = 'a'; }, (p) => { p.nodes[1].data.kind = 'group'; p.nodes[0].parentId = 'b'; },
    (p) => { p.nodes[1].width = 0; }, (p) => { p.nodes[1].height = Infinity; },
    (p) => { p.nodes[1].width = 100001; }, (p) => { delete p.nodes[1].parentId; }, (p) => { p.nodes[1].extent = [[0, 0], [1, 1]]; },
  ]) { const p = structuredClone(project([a, b])); mutate(p); assert.throws(() => validateProject(p)); }
});

test('workspace roundtrip preserves metadata and independent graph IDs; invalid canvas DAGs/IDs/secrets reject', () => {
  const graph = project([node('same')]);
  const p = project([node('execution-only')]);
  p.workspace = { activeCanvasId: 'one', custom: { grid: true }, canvases: [{ ...graph, id: 'one', name: 'One' }, { ...structuredClone(graph), id: 'two', name: 'Two' }] };
  assert.deepEqual(parseProject(serializeProject(p)), p);
  for (const mutate of [
    (v) => { v.workspace.activeCanvasId = 'absent'; }, (v) => { v.workspace.canvases[1].id = 'one'; },
    (v) => { v.workspace.canvases[1].edges = [edge('same', 'same')]; },
    (v) => { v.workspace.canvases[1].nodes.push(node('same')); },
    (v) => { v.workspace.custom.secret = 'never'; }, (v) => { v.workspace.canvases = []; },
    (v) => { v.workspace.canvases = Array.from({ length: 33 }, (_, i) => ({ ...graph, id: String(i), name: '' })); },
  ]) { const copy = structuredClone(p); mutate(copy); assert.throws(() => serializeProject(copy)); }
});

test('audio imports validate WAV MP3 OGG M4A FLAC signatures and data URLs with unchanged image/video behavior', async (t) => {
  const dir = await temp(t);
  const ogg = Buffer.alloc(36); ogg.write('OggS'); ogg.write('OpusHead', 28);
  const m4a = mp4(); m4a.write('M4A ', 8);
  const fixtures = [['wav', 'audio/wav', wav()], ['mp3', 'audio/mpeg', Buffer.from([0xff, 0xfb, 0x90, 0])], ['ogg', 'audio/ogg', ogg], ['m4a', 'audio/mp4', m4a], ['flac', 'audio/flac', Buffer.from('fLaC0000')]];
  for (const [extension, mime, bytes] of fixtures) {
    const path = join(dir, `sample.${extension}`); await writeFile(path, bytes);
    const result = await importMediaFile(path); assert.equal(result.kind, 'audio');
    assert.equal(result.url, `data:${mime};base64,${bytes.toString('base64')}`);
    assert.equal(validateMediaUrl(result.url, 'audio'), result.url);
    await writeFile(path, 'garbage'); await assert.rejects(importMediaFile(path), /音频/);
  }
  for (const value of ['https://mock.invalid/a.wav', 'data:audio/wav;base64,aGVsbG8=', 'data:audio/wav,RIFF', 'data:audio/ogg;base64,!!!!']) assert.throws(() => validateMediaUrl(value, 'audio'));
  assert.equal(validateMediaUrl('data:image/png;base64,aGVsbG8=', 'image'), 'data:image/png;base64,aGVsbG8=');
  assert.throws(() => validateMediaUrl(audioUrl(), 'video'));
});

test('audio enforces exact 20MiB limit and validates persisted lastOutput audio', () => {
  const exact = audioUrl(wav(MAX_MEDIA_BYTES - 44));
  assert.equal(validateMediaUrl(exact, 'audio'), exact);
  assert.throws(() => validateMediaUrl(audioUrl(wav(MAX_MEDIA_BYTES - 43)), 'audio'), /20 MiB/);
  assert.doesNotThrow(() => validateProject(project([node('a', 'audio', { lastOutput: { audio: audioUrl(), demo: false } })])));
  assert.throws(() => serializeProject(project([node('a', 'audio', { lastOutput: { audio: 'data:audio/wav;base64,aGVsbG8=' } })])));
});

test('TTS posts authentic OpenAI JSON protocol, node overrides and bounded binary WAV; output passes through', async () => {
  let call;
  const p = project([node('a', 'audio', { audioModel: 'node-tts', voice: 'nova', model: 'must-ignore', content: 'Speak me' }), node('b', 'output')], [edge('a', 'b')]);
  const result = await executeWorkflow(p, openai, { apiKey: 'test-only-key', fetchImpl: async (url, options) => {
    call = { url, options }; return new Response(wav(16), { headers: { 'content-type': 'audio/wav' } });
  } });
  assert.equal(result.status, 'success'); assert.equal(call.url, 'https://mock.invalid/v1/audio/speech');
  assert.equal(call.options.method, 'POST'); assert.equal(call.options.redirect, 'error'); assert.equal(call.options.headers.Authorization, 'Bearer test-only-key');
  assert.deepEqual(JSON.parse(call.options.body), { model: 'node-tts', voice: 'nova', input: 'Speak me', response_format: 'wav' });
  assert.equal(result.outputs.b.audio, audioUrl(wav(16))); assert.equal(result.outputs.b.demo, false);
});

test('TTS rejects HTTP/type/signature/oversize/credential-bearing binary without leaking provider bodies', async () => {
  const secret = 'audio-secret-value';
  const leaking = wav(64); leaking.write(secret, 44);
  for (const response of [
    new Response('private provider error', { status: 401 }), new Response(wav(), { headers: { 'content-type': 'text/html' } }),
    new Response('garbage', { headers: { 'content-type': 'audio/wav' } }),
    new Response(wav(), { headers: { 'content-type': 'audio/wav', 'content-length': String(MAX_MEDIA_BYTES + 1) } }),
    new Response(leaking, { headers: { 'content-type': 'audio/wav' } }),
  ]) {
    const events = [];
    const result = await executeWorkflow(project([node('a', 'audio')]), openai, { apiKey: secret, fetchImpl: async () => response, onEvent: (e) => events.push(e) });
    assert.equal(result.status, 'error'); assert.equal(result.outputs.a, undefined);
    assert(!JSON.stringify(events).includes(secret)); assert(!JSON.stringify(events).includes('private provider error'));
  }
});

test('videos multipart create -> poll -> content uses FormData Blob reference, model overrides and MP4 bytes', async () => {
  const calls = [];
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  const p = project([node('a', 'asset', { mediaUrl: image }), node('b', 'video', { videoModel: 'node-video', videoSize: '720x1280', videoSeconds: 8 })], [edge('a', 'b')]);
  const result = await executeWorkflow(p, openai, { apiKey: 'private-video-key', videoPollIntervalMs: 0, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return jsonResponse({ id: 'video_123', status: 'queued' });
    if (calls.length === 2) return jsonResponse({ id: 'video_123', status: 'in_progress' });
    if (calls.length === 3) return jsonResponse({ id: 'video_123', status: 'completed' });
    return new Response(mp4(), { headers: { 'content-type': 'video/mp4' } });
  } });
  assert.equal(result.status, 'success');
  assert.deepEqual(calls.map((c) => c.url), ['https://mock.invalid/v1/videos', 'https://mock.invalid/v1/videos/video_123', 'https://mock.invalid/v1/videos/video_123', 'https://mock.invalid/v1/videos/video_123/content']);
  const form = calls[0].options.body; assert(form instanceof FormData); assert.equal(form.get('model'), 'node-video'); assert.equal(form.get('seconds'), '8'); assert.equal(form.get('size'), '720x1280');
  assert(form.get('input_reference') instanceof Blob); assert.equal(form.get('input_reference').type, 'image/png');
  assert.deepEqual(Buffer.from(await form.get('input_reference').arrayBuffer()), Buffer.from('iVBORw0KGgo=', 'base64'));
  assert.equal(calls[0].options.headers['Content-Type'], undefined);
  const wire = new Request(calls[0].url, calls[0].options);
  assert.match(wire.headers.get('content-type'), /^multipart\/form-data; boundary=/);
  const wireBody = await wire.text();
  assert.match(wireBody, /name="model"\r\n\r\nnode-video/);
  assert.match(wireBody, /name="input_reference"; filename="reference.png"/);
  assert.match(wireBody, /Content-Type: image\/png/i);
  assert(calls.every((c) => c.options.headers.Authorization === 'Bearer private-video-key' && c.options.redirect === 'error'));
  assert.equal(result.outputs.b.video, `data:video/mp4;base64,${mp4().toString('base64')}`);
});

test('video failed/invalid jobs and bad content fail without fake media or provider error leakage', async () => {
  for (const job of [{ id: 'v', status: 'failed', error: { message: 'private-provider-body' } }, { id: '../escape', status: 'queued' }, { id: 'v', status: 'unknown' }]) {
    const events = [];
    const result = await executeWorkflow(project([node('a', 'video')]), openai, { fetchImpl: async () => jsonResponse(job), onEvent: (e) => events.push(e) });
    assert.equal(result.status, 'error'); assert.equal(result.outputs.a, undefined); assert(!JSON.stringify(events).includes('private-provider-body'));
  }
  let polled = 0;
  const failed = await executeWorkflow(project([node('a', 'video')]), openai, { videoPollIntervalMs: 0, fetchImpl: async () => {
    polled++; return jsonResponse(polled === 1 ? { id: 'v', status: 'queued' } : { id: 'v', status: 'failed', error: { message: 'not-published' } });
  } });
  assert.equal(failed.status, 'error'); assert.equal(polled, 2); assert.equal(failed.outputs.a, undefined);
  for (const content of [new Response('not MP4', { headers: { 'content-type': 'video/mp4' } }), new Response(mp4(), { headers: { 'content-type': 'video/mp4', 'content-length': String(MAX_MEDIA_BYTES + 1) } })]) {
    let calls = 0;
    const result = await executeWorkflow(project([node('a', 'video')]), openai, { fetchImpl: async () => ++calls === 1 ? jsonResponse({ id: 'v', status: 'completed' }) : content });
    assert.equal(result.status, 'error'); assert.equal(result.outputs.a, undefined);
  }
});

test('TTS and videos cancel active requests; video polling respects one total deadline', async () => {
  for (const kind of ['audio', 'video']) {
    const controller = new AbortController(); const emitter = new EventEmitter(); const events = [];
    const pending = executeWorkflow(project([node('a', kind), node('b', 'output')], [edge('a', 'b')]), openai, {
      signal: controller.signal, onEvent: (e) => events.push(e), fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }); emitter.emit('start');
      }),
    });
    await once(emitter, 'start'); controller.abort(); assert.equal((await pending).status, 'cancelled');
    assert.deepEqual(events.slice(-2).map((e) => e.status), ['cancelled', 'cancelled']);
  }
  const events = []; let polls = 0;
  const result = await executeWorkflow(project([node('a', 'video')]), openai, { requestTimeoutMs: 25, videoPollIntervalMs: 1, onEvent: (e) => events.push(e), fetchImpl: async () => { polls++; return jsonResponse({ id: 'v', status: 'queued' }); } });
  assert.equal(result.status, 'error'); assert(polls > 1); assert.match(events.at(-1).error, /总时限/);
});

test('demo audio is deterministic labelled WAV; demo videos refuse fabrication; group/asset never call AI', async () => {
  const p = project([node('a', 'audio'), node('b', 'group'), node('c', 'output')], [edge('a', 'b'), edge('b', 'c')]);
  const a = await executeWorkflow(p, {}, { fetchImpl: offline }); const b = await executeWorkflow(p, {}, { fetchImpl: offline });
  assert.equal(a.status, 'success'); assert.deepEqual(a.outputs, b.outputs); assert.match(a.outputs.a.text, /DEMO.*非语音合成/);
  assert.equal(a.outputs.c.audio, a.outputs.a.audio); assert.equal(a.outputs.c.demo, true); validateMediaUrl(a.outputs.c.audio, 'audio');
  assert.equal((await executeWorkflow(project([node('a', 'video')]), {}, { fetchImpl: offline })).status, 'error');
  const real = await executeWorkflow(project([node('a', 'asset', { mediaUrl: audioUrl() }), node('b', 'group')], [edge('a', 'b')]), openai, { fetchImpl: offline });
  assert.equal(real.status, 'success'); assert.equal(real.outputs.b.audio, audioUrl()); assert.equal(real.outputs.b.demo, false);
});

test('script/director/shots/clip use text-only JSON production plans, never claim rendered media', async () => {
  for (const kind of ['script', 'director', 'shots', 'clip']) {
    let body;
    const result = await executeWorkflow(project([node('a', kind)]), openai, { fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body); return jsonResponse({ choices: [{ message: { content: JSON.stringify({ title: 'Plan', items: [{ description: 'Proposed shot', startSeconds: 0, endSeconds: 4 }] }) } }] });
    } });
    assert.equal(result.status, 'success'); assert.equal(result.outputs.a.plan.kind, kind); assert.equal(result.outputs.a.plan.rendered, false);
    assert.equal(result.outputs.a.plan.mediaUnderstanding, false); assert.equal(result.outputs.a.video, undefined); assert.match(body.messages[0].content, /Do not claim to render/);
    const demo = await executeWorkflow(project([node('a', kind)]), {}, { fetchImpl: offline }); assert.equal(demo.outputs.a.demo, true);
  }
  const result = await executeWorkflow(project([node('a', 'clip')]), openai, { fetchImpl: async () => jsonResponse({ choices: [{ message: { content: '{"title":"Bad","items":[{"description":"Bad","startSeconds":3,"endSeconds":1}]}' } }] }) });
  assert.equal(result.status, 'error');
});

test('global and node generation options have strict whitelist/value bounds; images use dedicated override and real batch', async () => {
  for (const input of [{ unknown: 1 }, { audioModel: 3 }, { voice: 'x'.repeat(201) }, { imageSize: 'huge' }, { imageAspectRatio: '0:0' }, { batchSize: 0 }, { batchSize: 5 }, { batchSize: 1.1 }, { videoSeconds: '4' }, { videoSize: 'auto' }, { imageSize: '1024x1024', imageAspectRatio: '16:9' }]) assert.throws(() => validateConfig(input));
  for (const data of [{ batchSize: 5 }, { audioModel: {} }, { imageSize: 'bad' }, { videoSeconds: 100 }]) assert.throws(() => validateProject(project([node('a', 'image', data)])));
  let body;
  const result = await executeWorkflow(project([node('a', 'image', { model: 'ignored', imageModel: 'specific-image', batchSize: 2, imageAspectRatio: '3:2' })]), { ...openai, imageModel: 'fallback-image' }, { fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return jsonResponse({ data: [{ b64_json: 'iVBORw0KGgo=' }, { b64_json: 'iVBORw0KGgo=' }] }); } });
  assert.equal(result.status, 'success'); assert.equal(body.model, 'specific-image'); assert.equal(body.n, 2); assert.equal(body.size, '1536x1024'); assert.equal(result.outputs.a.images.length, 2);
});

test('chunked binary responses enforce size limits without content-length and stalled bodies cancel', async () => {
  let cancelled = false;
  const large = new ReadableStream({ start(controller) { const chunk = new Uint8Array(1024 * 1024); for (let i = 0; i < 21; i++) controller.enqueue(chunk); }, cancel() { cancelled = true; } });
  const result = await executeWorkflow(project([node('a', 'audio')]), openai, { fetchImpl: async () => new Response(large, { headers: { 'content-type': 'audio/wav' } }) });
  assert.equal(result.status, 'error'); assert.equal(cancelled, true);
  const control = new AbortController(); const emitter = new EventEmitter();
  const pending = executeWorkflow(project([node('a', 'audio')]), openai, { signal: control.signal, fetchImpl: async () => {
    const body = new ReadableStream({ start() { setImmediate(() => emitter.emit('reading')); }, cancel() { cancelled = true; } });
    return new Response(body, { headers: { 'content-type': 'audio/wav' } });
  } });
  await once(emitter, 'reading'); cancelled = false; control.abort(); assert.equal((await pending).status, 'cancelled'); assert.equal(cancelled, true);
});

test('video cancellation during polling delay or content streaming stops without publishing output', async () => {
  for (const phase of ['poll', 'content']) {
    const control = new AbortController(); const emitter = new EventEmitter(); let calls = 0;
    const pending = executeWorkflow(project([node('a', 'video')]), openai, { signal: control.signal, videoPollIntervalMs: 1000, fetchImpl: async () => {
      calls++;
      if (calls === 1) {
        if (phase === 'poll') setImmediate(() => emitter.emit('ready'));
        return jsonResponse({ id: 'v', status: phase === 'poll' ? 'queued' : 'completed' });
      }
      const body = new ReadableStream({ start(controller) { controller.enqueue(mp4()); setImmediate(() => emitter.emit('ready')); } });
      return new Response(body, { headers: { 'content-type': 'video/mp4' } });
    } });
    await once(emitter, 'ready'); control.abort(); const result = await pending;
    assert.equal(result.status, 'cancelled'); assert.equal(result.outputs.a, undefined); assert.equal(calls, phase === 'poll' ? 1 : 2);
  }
});

test('workspace metadata shares the overall 100MiB project limit and recursion guard', () => {
  const p = project(); p.workspace = { activeCanvasId: 'main', canvases: [{ ...project(), id: 'main', name: 'main' }], metadata: 'x'.repeat(MAX_PROJECT_BYTES) };
  assert.throws(() => validateProject(p), /100 MiB/);
  delete p.workspace.metadata;
  let obj = p.workspace;
  for (let i = 0; i < 41; i++) { obj.extra = {}; obj = obj.extra; }
  assert.throws(() => validateProject(p), /嵌套层级/);
});

test('imported credentials hidden in base64 media are blocked from workflow events', async () => {
  const key = 'hidden-media-private-key'; const bytes = wav(100); bytes.write(key, 44); const events = [];
  const result = await executeWorkflow(project([node('a', 'audio', { mediaUrl: audioUrl(bytes) })]), {}, { apiKey: key, fetchImpl: offline, onEvent: (e) => events.push(e) });
  assert.equal(result.status, 'error'); assert.equal(result.outputs.a, undefined); assert.equal(events.some((e) => e.output), false);
});

test('workspace nested secrets and lastOutput audio never overwrite a safe project file', async (t) => {
  const dir = await temp(t); const path = join(dir, 'safe.json'); const safe = project(); await writeProject(path, safe);
  const bad = project(); bad.workspace = { activeCanvasId: 'x', canvases: [{ ...project([node('a', 'audio', { lastOutput: { audio: audioUrl(), metadata: { api_key: 'do-not-write' } } })]), id: 'x', name: 'x' }] };
  await assert.rejects(writeProject(path, bad), /凭据/); assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), safe);
});
