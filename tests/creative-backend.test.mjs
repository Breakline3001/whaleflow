import test from 'node:test';
import assert from 'node:assert/strict';
import { createCreativeDocument, validateCreativeDocument } from '../lib/creative-schema.mjs';
import { validateProject, MAX_MEDIA_BYTES } from '../lib/project.mjs';
import { executeWorkflow, WorkflowEngine } from '../lib/workflow.mjs';
import { createDefaultModelSettings } from '../lib/model-settings-schema.mjs';
import { project, node } from './helpers.mjs';

test('creative factory exposes the stable v4 document shape and validator is browser-safe', () => {
  const document = createCreativeDocument({ title: 'Board', shots: [{ id: 's1', title: 'Open', description: '', duration: 4, shotSize: 'wide', camera: 'locked', dialogue: '', sound: '', prompt: '', referenceNodeId: 'img-1' }] });
  assert.deepEqual(Object.keys(document), ['revision', 'title', 'synopsis', 'style', 'aspectRatio', 'script', 'shots', 'characters', 'scenes', 'props']);
  assert.deepEqual(validateCreativeDocument(document), { valid: true, errors: [] });
  const invalid = structuredClone(document); invalid.shots[0].duration = -1;
  assert.equal(validateCreativeDocument(invalid).valid, false);
  assert.throws(() => createCreativeDocument({ revision: -1 }), /revision/);
  assert.doesNotThrow(() => createCreativeDocument({ history: [createCreativeDocument()] }));
  for (const history of [[{}], [createCreativeDocument({ history: [] })], Array.from({ length: 9 }, () => createCreativeDocument()), new Array(1)]) {
    const invalid = { ...createCreativeDocument(), history };
    assert.equal(validateCreativeDocument(invalid).valid, false);
    assert.throws(() => validateProject({ ...project([node('a', 'script', { creative: invalid })]), version: 3 }), /creative/);
  }
});

test('creative arrays reject holes before the factory can normalize them into invalid null entries', () => {
  for (const field of ['shots', 'characters', 'scenes', 'props', 'history']) {
    const sparse = new Array(2);
    const value = { ...createCreativeDocument(), [field]: sparse };
    const result = validateCreativeDocument(value);
    assert.equal(result.valid, false, field);
    assert(result.errors.some(error => error.startsWith(`${field}[0]`)), field);
    assert.throws(() => createCreativeDocument({ [field]: sparse }), /expected/, field);
  }
});

test('version 3 project accepts creative on script and shots, directorStage on director, and modelRef', () => {
  const p = project([
    node('script', 'script', { creative: createCreativeDocument() }),
    node('shots', 'shots', { creative: createCreativeDocument({ title: 'Shots' }) }),
    node('director', 'director', { directorStage: { revision: 0, objects: [], camera: { azimuth: 0, elevation: 0, distance: 2, target: [0, 0, 0], fov: 45 }, background: '#000000', grid: true, aspectRatio: 1 } }),
  ]);
  p.version = 3;
  p.nodes[0].data.modelRef = null;
  assert.doesNotThrow(() => validateProject(p));
  p.nodes[0].data.creative = { ...createCreativeDocument(), shots: [{ id: 'dup', title: '', description: '', duration: 1, shotSize: '', camera: '', dialogue: '', sound: '', prompt: '' }, { id: 'dup', title: '', description: '', duration: 1, shotSize: '', camera: '', dialogue: '', sound: '', prompt: '' }] };
  assert.throws(() => validateProject(p), /creative/);
});

test('OpenAI image reference edit uses multipart /images/edits and video uses input_reference', async () => {
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  const calls = [];
  const response = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const imageProject = project([node('a', 'image', { referenceImage: image, content: 'edit sky' })]);
  const imageRun = await executeWorkflow(imageProject, { provider: 'openai', imageModel: 'img' }, { fetchImpl: async (url, options) => { calls.push({ url, options }); return response({ data: [{ b64_json: 'iVBORw0KGgo=' }] }); } });
  assert.equal(imageRun.status, 'success'); assert.match(calls[0].url, /\/images\/edits$/); assert(calls[0].options.body instanceof FormData); assert(calls[0].options.body.get('image') instanceof Blob);
  calls.length = 0;
  const videoProject = project([node('a', 'video', { referenceImage: image, content: 'move camera' })]);
  const videoRun = await executeWorkflow(videoProject, { provider: 'openai', videoModel: 'vid' }, { videoPollIntervalMs: 0, fetchImpl: async (url, options) => { calls.push({ url, options }); if (calls.length === 1) return response({ id: 'v1', status: 'completed' }); return new Response(Buffer.from('....ftypisom00000000'), { headers: { 'content-type': 'video/mp4' } }); } });
  assert.equal(videoRun.status, 'success'); assert(calls[0].options.body.get('input_reference') instanceof Blob);
});

test('configured WorkflowEngine sends exact single reference bytes and bound image/video model credentials', async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const referenceImage = `data:image/png;base64,${bytes.toString('base64')}`;
  for (const kind of ['image', 'video']) {
    const document = createDefaultModelSettings();
    document.providers = [{ id: 'fixture', name: 'Fixture', protocol: 'openai', baseUrl: 'https://fixture.invalid/v1', auth: 'required', allowInsecureHttpAuth: false, models: [{ id: 'bound-model', name: 'Bound model', roles: [kind] }] }];
    document.defaults[kind] = { providerId: 'fixture', modelId: 'bound-model' };
    const snapshot = { revision: 1, document, credentials: { fixture: { protocol: 'openai', baseUrl: 'https://fixture.invalid/v1', value: 'inert-test-key' } } };
    const calls = [];
    const engine = new WorkflowEngine({ fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/content')) return new Response(Buffer.from('....ftypisom00000000'), { headers: { 'content-type': 'video/mp4' } });
      return new Response(JSON.stringify(kind === 'image' ? { data: [{ b64_json: bytes.toString('base64') }] } : { id: 'video1', status: 'completed' }), { headers: { 'content-type': 'application/json' } });
    } });
    const p = { ...project([node('a', kind, { referenceImage, content: 'camera instruction', modelRef: document.defaults[kind] })]), version: 3 };
    engine.runConfigured(p, snapshot);
    assert.equal((await engine.waitForIdle()).status, 'success');
    const { options } = calls[0]; const form = options.body;
    assert.equal(options.headers.Authorization, 'Bearer inert-test-key');
    assert.equal(form.get('model'), 'bound-model');
    const field = kind === 'image' ? 'image' : 'input_reference';
    const file = form.get(field);
    assert.equal(file.type, 'image/png'); assert.equal(file.name, 'reference.png');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
    assert.equal(options.headers['Content-Type'], undefined);
    const wire = new Request(calls[0].url, options);
    assert.match(wire.headers.get('content-type'), /^multipart\/form-data; boundary=/);
    assert.match(await wire.text(), new RegExp(`name="${field}"; filename="reference.png"`));
    assert(!JSON.stringify((await engine.waitForIdle()) ?? {}).includes('inert-test-key'));
  }
});

test('reference schema rejects remote paths, invalid data, unsupported media and oversize before execution', () => {
  for (const referenceImage of ['https://fixture.invalid/reference.png', 'file:///C:/reference.png', 'data:image/png;base64,!!!!', 'data:image/svg+xml,%3Csvg%3E', 'data:image/gif;base64,R0lGODlh', `data:image/png;base64,${Buffer.alloc(MAX_MEDIA_BYTES + 1).toString('base64')}`]) {
    assert.throws(() => validateProject(project([node('a', 'image', { referenceImage })])));
  }
  assert.throws(() => validateProject(project([node('a', 'text', { referenceImage: 'data:image/png;base64,iVBORw0KGgo=' })])), /referenceImage/);
});

test('demo cannot claim a reference edit and rejects without network or output', async () => {
  const result = await executeWorkflow(project([node('a', 'image', { referenceImage: 'data:image/png;base64,iVBORw0KGgo=' })]), { provider: 'demo' }, { fetchImpl: async () => { throw new Error('must stay offline'); } });
  assert.equal(result.status, 'error'); assert.deepEqual(result.outputs, {});
  const events = [];
  const engine = new WorkflowEngine({ onEvent: (event) => events.push(event), fetchImpl: async () => { throw new Error('must stay offline'); } });
  assert.throws(() => engine.runConfigured({ ...project([node('a', 'image', { provider: 'demo', referenceImage: 'data:image/png;base64,iVBORw0KGgo=' })]), version: 3 }, { revision: 0, document: createDefaultModelSettings(), credentials: {} }), /DEMO/);
  assert.deepEqual(events, []); assert.equal(engine.running, false);
});
