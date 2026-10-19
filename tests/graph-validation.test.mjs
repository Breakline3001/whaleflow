import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateClient, cleanProject, createProject, demoProject, executionProject, addCanvas, switchCanvas} from '../src/graph.mjs';
import {validateMediaUrl, assertJsonData, MAX_MEDIA_BYTES, MAX_PROJECT_BYTES} from '../src/schema.mjs';
import {validateProject, validateMediaUrl as hostMedia} from '../lib/project.mjs';

const node = (id = 'a', kind = 'text', data = {}) => ({id, type: 'workflow', position: {x: 0, y: 0}, data: {kind, title: id, content: '', ...data}});
const project = (nodes = [node()], edges = []) => ({version: 1, name: '校验项目', nodes, edges, viewport: {x: 0, y: 0, zoom: 1}});
const clone = value => structuredClone(value);
const badOnBoth = value => { assert.throws(() => validateProject(value)); assert.throws(() => validateClient(value)); assert.throws(() => cleanProject(value)); };
function wav(size = 44) { const bytes = Buffer.alloc(size); bytes.write('RIFF'); bytes.write('WAVE', 8); return bytes; }
const dataUrl = (mime, bytes) => `data:${mime};base64,${bytes.toString('base64')}`;
const image = 'data:image/png;base64,aGVsbG8=';
const video = 'data:video/mp4;base64,aGVsbG8=';
const audio = dataUrl('audio/wav', wav());

test('schema preserves demo, legacy normalization and legitimate lastOutput metadata without host-only assumptions', () => {
  const legacy = project([node('a', 'output', {lastOutput: {text: 123, demo: 'custom', plan: {custom: true}, extra: ['kept']}})]);
  delete legacy.nodes[0].type;
  const value = validateClient(legacy);
  assert.equal(value.nodes[0].type, 'workflow'); assert.deepEqual(value.nodes[0].data.lastOutput, legacy.nodes[0].data.lastOutput);
  assert.doesNotThrow(() => validateProject(value));
  assert.doesNotThrow(() => validateProject(validateClient(demoProject())));
  const optional = project([node('a', 'text', {provider: undefined, model: undefined, optional: undefined})]);
  assert.equal(Object.hasOwn(validateClient(optional).nodes[0].data, 'provider'), false);
  assert.doesNotThrow(() => validateClient(createProject()));
});

test('input mutations reject all finite geometry, extent, identifier and string-boundary violations on both validators', () => {
  for (const mutate of [
    p => { p.name = 'x'.repeat(201); }, p => { p.nodes[0].id = ' '; }, p => { p.nodes[0].id = 'x'.repeat(201); },
    p => { p.nodes[0].data.title = 'x'.repeat(501); }, p => { p.nodes[0].data.content = 'x'.repeat(1_000_001); },
    p => { p.nodes[0].data.model = 'x'.repeat(201); }, p => { p.nodes[0].position.x = Infinity; },
    p => { p.nodes[0].width = 100001; }, p => { p.nodes[0].height = NaN; }, p => { p.nodes[0].width = true; },
    p => { p.nodes[0].extent = [[0, 0], [100, 100]]; }, p => { p.nodes[0].extent = 'parent'; },
    p => { p.nodes[0].parentId = 'x'.repeat(201); }, p => { p.nodes[0].parentId = ' '; },
    p => { p.viewport.zoom = 10.001; }, p => { p.viewport.zoom = 0; }, p => { p.viewport.y = NaN; },
    p => { p.edges[0].id = ' '; }, p => { p.edges[0].id = 'x'.repeat(201); }, p => { p.edges[0].source = 'x'.repeat(201); },
    p => { p.edges[0].target = null; },
  ]) {
    const p = project([node('a'), node('b')], [{id: 'e', source: 'a', target: 'b'}]); mutate(p); badOnBoth(p);
  }
  const exact = project([node('a', 'group'), {...node('x'.repeat(200), 'text', {title: 'x'.repeat(500), content: 'x'.repeat(1_000_000), model: 'x'.repeat(200)}), parentId: 'a', extent: 'parent', width: 100000, height: 100000}]);
  exact.name = 'x'.repeat(200); exact.viewport.zoom = 10;
  assert.doesNotThrow(() => validateProject(validateClient(exact)));
});

test('node, edge and canvas counts enforce exact backend boundaries and independent canvas IDs', () => {
  const atNodeLimit = project(Array.from({length: 2000}, (_, i) => node(String(i))));
  assert.equal(validateClient(atNodeLimit).nodes.length, 2000);
  badOnBoth({...atNodeLimit, nodes: [...atNodeLimit.nodes, node('extra')]});
  const nodes = Array.from({length: 143}, (_, i) => node(String(i))), edges = [];
  for (let a = 0; a < 143 && edges.length < 10001; a++) for (let b = a + 1; b < 143 && edges.length < 10001; b++) edges.push({id: `e-${a}-${b}`, source: String(a), target: String(b)});
  assert.equal(validateClient(project(nodes, edges.slice(0, 10000))).edges.length, 10000);
  badOnBoth(project(nodes, edges));
  const p = project(); p.workspace = {activeCanvasId: 'c0', canvases: Array.from({length: 32}, (_, i) => ({id: `c${i}`, name: 'Canvas', nodes: [node('same-id')], edges: [], viewport: p.viewport}))};
  assert.equal(validateClient(p).workspace.canvases.length, 32);
  for (const mutate of [
    v => { v.workspace.canvases.push({...v.workspace.canvases[0], id: 'c32'}); },
    v => { v.workspace.canvases[1].id = 'c0'; }, v => { v.workspace.canvases[0].id = ' '; },
    v => { v.workspace.canvases[0].name = 'x'.repeat(201); }, v => { v.workspace.canvases[0].id = 'x'.repeat(201); },
    v => { v.workspace.activeCanvasId = 'missing'; }, v => { v.workspace.canvases[1].viewport.zoom = 11; },
  ]) { const copy = clone(p); mutate(copy); badOnBoth(copy); }
});

test('recursive credential fields and unsafe keys are rejected before clean prunes unknown or inactive fields', () => {
  for (const key of ['apiKey', 'api_key', 'API-TOKEN', 'access_token', 'refreshToken', 'authorization', 'password', 'secret', 'token']) {
    for (const locate of [
      p => p, p => p.nodes[0].data, p => p.workspace,
      p => p.workspace.canvases[1].nodes[0].data.lastOutput.metadata,
    ]) {
      const p = project(); p.workspace = {activeCanvasId: 'one', canvases: [{...project(), id: 'one', name: 'One'}, {...project([node('other', 'audio', {lastOutput: {audio, metadata: {}}})]), id: 'two', name: 'Two'}]};
      locate(p)[key] = 'do-not-persist'; badOnBoth(p);
    }
  }
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const p = project(); p.nodes[0].data.extra = JSON.parse(`{"${key}":{}}`); badOnBoth(p);
  }
});

test('JSON guards reject cycles, excessive depth, exotic objects and non-JSON values before normalization', () => {
  for (const value of [NaN, Infinity, () => {}, 1n, Symbol('bad'), new Date(), new Map(), new Uint8Array([1])]) {
    const p = project(); p.nodes[0].data.extra = value; badOnBoth(p);
  }
  const recursive = project(); recursive.nodes[0].data.extra = recursive; badOnBoth(recursive);
  const arrayUndefined = project(); arrayUndefined.nodes[0].data.extra = [undefined]; badOnBoth(arrayUndefined);
  const deep = project(); let current = deep;
  for (let i = 0; i < 41; i++) { current.extra = {}; current = current.extra; } badOnBoth(deep);
  const shared = {value: 'safe'}; const normal = project(); normal.nodes[0].data.extra = [shared, shared];
  assert.doesNotThrow(() => validateClient(normal));
  assert.doesNotThrow(() => assertJsonData(Object.assign(Object.create(null), {value: 'safe'})));
});

test('browser media accepts exactly the host portable MIME/base64 syntax including legacy image/video and demo SVG', () => {
  const valid = [
    ['image', image], ['video', video], ['audio', audio],
    ['image', 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg">鲸</svg>')],
    ['image', 'data:image/png;base64,AB=='], ['image', 'data:image/png,hello'],
    ['audio', dataUrl('audio/mpeg', Buffer.from('ID3'))], ['audio', dataUrl('audio/mp3', Buffer.from([0xff, 0xfb, 0x90]))],
    ['audio', dataUrl('audio/flac', Buffer.from('fLaC0000'))], ['audio', dataUrl('audio/x-flac', Buffer.from('fLaC0000'))],
    ['audio', dataUrl('audio/x-wav', wav())],
  ];
  const ogg = Buffer.alloc(27); ogg.write('OggS'); valid.push(['audio', dataUrl('audio/ogg', ogg)]);
  const m4a = Buffer.alloc(16); m4a.write('ftypM4A ', 4); valid.push(['audio', dataUrl('audio/mp4', m4a)], ['audio', dataUrl('audio/x-m4a', m4a)]);
  for (const [kind, value] of valid) {
    assert.equal(validateMediaUrl(value, kind), hostMedia(value, kind));
    assert.doesNotThrow(() => validateClient(project([node('a', kind, {mediaUrl: value})])));
  }
  for (const value of [
    'https://untrusted.invalid/a.png', 'file:///C:/a.png', 'blob:untrusted', 'javascript:alert(1)',
    'data:text/html;base64,aGVsbG8=', 'data:image/png;base64,!!!!', 'data:image/png;base64,abc',
    'data:image/png;base64,AAAA====', 'data:image/png,%XY',
  ]) { assert.throws(() => validateMediaUrl(value, 'image')); assert.throws(() => hostMedia(value, 'image')); badOnBoth(project([node('a', 'image', {mediaUrl: value})])); }
  for (const [kind, value] of [['video', image], ['audio', video], ['audio', 'data:audio/wav;base64,aGVsbG8='], ['audio', 'data:audio/wav,RIFF']]) {
    assert.throws(() => validateMediaUrl(value, kind)); assert.throws(() => hostMedia(value, kind));
  }
});

test('media byte limit includes exact 20MiB acceptance and single-byte overflow before browser decoding', () => {
  const exact = dataUrl('audio/wav', wav(MAX_MEDIA_BYTES));
  assert.equal(validateMediaUrl(exact, 'audio'), exact);
  assert.equal(hostMedia(exact, 'audio'), exact);
  const oversized = dataUrl('audio/wav', wav(MAX_MEDIA_BYTES + 1));
  assert.throws(() => validateMediaUrl(oversized, 'audio'), /20 MiB/);
  assert.throws(() => hostMedia(oversized, 'audio'), /20 MiB/);
});

test('lastOutput and asset media are validated without imposing an invented output schema', () => {
  for (const kind of ['image', 'video', 'audio']) {
    const value = {image, video, audio}[kind];
    const output = {[kind]: value, plan: {custom: true}, text: null};
    assert.doesNotThrow(() => validateProject(validateClient(project([node('a', 'asset', {mediaUrl: value, lastOutput: output})]))));
  }
  for (const output of [null, [], 'bad', {image: 'https://untrusted.invalid/a.png'}, {audio: image}, {images: [image, image, image, image, image]}, {images: 'not-array'}, {images: ['invalid']}]) badOnBoth(project([node('a', 'image', {lastOutput: output})]));
  badOnBoth(project([node('a', 'text', {mediaUrl: image})]));
  assert.doesNotThrow(() => validateClient(project([node('a', 'image', {lastOutput: {images: []}})])));
});

test('node generation overrides share the actual host whitelist and strict parameter constraints', () => {
  for (const data of [
    {provider: 'unknown'}, {audioModel: 3}, {videoModel: 'x'.repeat(201)}, {voice: 'x'.repeat(201)},
    {imageSize: 'huge'}, {imageAspectRatio: '0:1'}, {batchSize: 0}, {batchSize: 5}, {batchSize: 1.2},
    {videoSize: 'auto'}, {videoSeconds: '4'}, {videoSeconds: 5}, {imageSize: '1024x1024', imageAspectRatio: '16:9'},
  ]) badOnBoth(project([node('a', 'image', data)]));
  for (const data of [
    {imageSize: 'auto', imageAspectRatio: '4:3', batchSize: 4},
    {imageSize: '1792x1024', imageAspectRatio: '16:9'},
    {audioModel: 'node-audio', videoModel: 'node-video', voice: 'custom-voice', videoSize: '1280x720', videoSeconds: 12},
  ]) assert.doesNotThrow(() => validateProject(validateClient(project([node('a', 'image', data)]))));
});

test('workspace switching, media-library metadata and flattened execution preserve valid saved assets', () => {
  const source = project([node('g', 'group'), {...node('a', 'audio', {mediaUrl: audio, lastOutput: {audio, demo: false}, inLibrary: true}), parentId: 'g', extent: 'parent'}]);
  let p = validateClient(source); const first = p.workspace.activeCanvasId;
  p = addCanvas(p, 'Other'); p = switchCanvas(p, first);
  assert.equal(p.nodes[1].data.lastOutput.audio, audio); assert.equal(p.nodes[1].data.inLibrary, true);
  const execution = executionProject(p, ['g']);
  assert.doesNotThrow(() => validateProject(execution)); assert.equal(execution.nodes.length, 1);
  assert.equal(execution.nodes[0].parentId, undefined); assert.equal(execution.workspace.canvases[0].nodes.length, 2);
  assert.deepEqual(validateClient(p), cleanProject(p));
});

test('total project size counts UTF-8 bytes and rejects synchronized snapshots that push a legacy graph over 100MiB', () => {
  const unicode = project(); unicode.metadata = '鲸'.repeat(Math.ceil(MAX_PROJECT_BYTES / 3));
  assert.throws(() => cleanProject(unicode), /100 MiB/);
  delete unicode.metadata;
  const duplicated = project([node('a', 'text', {payload: 'x'.repeat(51 * 1024 * 1024)})]);
  assert.doesNotThrow(() => validateProject(duplicated));
  assert.throws(() => cleanProject(duplicated), /100 MiB/);
});

test('in-memory guard mutation probes prove the forbidden inputs reach each targeted schema assertion', async () => {
  // Never mutate production files: import two intentionally weakened copies by data URL.
  const url = new URL('../src/schema.mjs', import.meta.url);
  const source = (await readFile(url, 'utf8'))
    .replace("'../lib/generation-options.mjs'", JSON.stringify(new URL('../lib/generation-options.mjs', import.meta.url).href))
    .replace("'../lib/model-settings-schema.mjs'", JSON.stringify(new URL('../lib/model-settings-schema.mjs', import.meta.url).href))
    .replace("'../lib/creative-schema.mjs'", JSON.stringify(new URL('../lib/creative-schema.mjs', import.meta.url).href))
    .replace("'../lib/director-stage.mjs'", JSON.stringify(new URL('../lib/director-stage.mjs', import.meta.url).href));
  const noSecret = source.replace('if (SECRET_KEY.test(key) ||', 'if (false && SECRET_KEY.test(key) ||');
  assert.notEqual(noSecret, source);
  const secretMutant = await import(`data:text/javascript;base64,${Buffer.from(noSecret).toString('base64')}#no-secret`);
  assert.throws(() => assertJsonData({nested: {apiKey: 'forbidden'}}));
  assert.doesNotThrow(() => secretMutant.assertJsonData({nested: {apiKey: 'forbidden'}}));
  const noPortable = source.replace('if (!match || !match[1].toLowerCase().startsWith(`${kind}/`))', 'if (!match)');
  assert.notEqual(noPortable, source);
  const mediaMutant = await import(`data:text/javascript;base64,${Buffer.from(noPortable).toString('base64')}#wrong-kind`);
  assert.throws(() => validateMediaUrl(image, 'video'));
  assert.equal(mediaMutant.validateMediaUrl(image, 'video'), image);
});
