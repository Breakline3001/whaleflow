import test from 'node:test';
import assert from 'node:assert/strict';
import {nodeModelOptions, nodeModelPatch, nodeModelState} from '../src/model-routing.mjs';
import {createDefaultModelSettings, validateModelSettings} from '../lib/model-settings-schema.mjs';
import {resolveRunBindings} from '../lib/model-settings.mjs';
import {imageParameters} from '../lib/generation-options.mjs';
import {node, project} from './helpers.mjs';

const model = (id, roles = ['text']) => ({id, name: id, roles});
const provider = (id, overrides = {}) => ({id, name: `Service ${id}`, protocol: 'openai', baseUrl: `https://${id}.invalid/v1`, auth: 'required', allowInsecureHttpAuth: false, models: [model('shared'), model('gpt-image-1', ['image']), model('dall-e-3', ['image']), model('dall-e-2', ['image']), model('speech', ['audio']), model('movie', ['video'])], ...overrides});
const ref = (providerId = 'alpha', modelId = 'shared') => ({providerId, modelId});
function fixture(providers = [provider('alpha'), provider('beta')]) {
  const document = createDefaultModelSettings();
  document.providers = providers;
  if (providers.length) Object.assign(document.defaults, {text: ref(), image: ref('alpha', 'gpt-image-1'), audio: ref('alpha', 'speech'), video: ref('alpha', 'movie')});
  return {revision: 8, document, credentials: Object.fromEntries(providers.filter(p => p.auth === 'required').map(p => [p.id, {configured: true, source: 'saved'}]))};
}
function privateSnapshot(snapshot) {
  return {...snapshot, credentials: Object.fromEntries(snapshot.document.providers.filter(p => p.auth === 'required' && snapshot.credentials[p.id]?.configured).map(p => [p.id, {protocol: p.protocol, baseUrl: p.baseUrl, value: `synthetic-test-credential-${p.id}`}]))};
}
function backend(data, snapshot) {
  return resolveRunBindings({...project([node('a', data.kind || 'text', data)]), version: 2}, privateSnapshot(snapshot)).bindings.get('a');
}
function agrees(data, snapshot, expectedStatus) {
  const before = structuredClone({data, snapshot});
  const state = nodeModelState(data, snapshot);
  assert.equal(state.status, expectedStatus);
  if (state.error) assert.throws(() => backend(data, snapshot), error => error.message === state.error);
  else {
    const binding = backend(data, snapshot);
    assert.equal(binding.selectedModel, state.selectedModel);
    assert.equal(binding.config.provider, state.protocol || 'demo');
    if (state.selectedModel) assert.equal(binding.config.baseUrl, state.provider.baseUrl);
  }
  assert.deepEqual({data, snapshot}, before, 'reading model state must never repair saved nodes');
  return state;
}

test('routing: inherited and explicit selections match backend for every generation role and plan kind', () => {
  const snapshot = fixture();
  for (const kind of ['text', 'script', 'director', 'shots', 'clip', 'image', 'video', 'audio']) {
    const role = ['image', 'video', 'audio'].includes(kind) ? kind : 'text';
    const inherited = agrees({kind}, snapshot, 'ready');
    assert.equal(inherited.mode, 'inherit'); assert.equal(inherited.role, role);
    const explicit = agrees({kind, modelRef: {...snapshot.document.defaults[role], providerId: 'beta'}}, snapshot, 'ready');
    assert.equal(explicit.mode, 'ref'); assert.equal(explicit.provider.id, 'beta');
  }
});

test('routing: explicit DEMO always offline even with real/dangling ref, stale override and missing credentials', () => {
  const snapshot = fixture(); snapshot.credentials = {}; snapshot.document.defaults.text = null;
  for (const modelRef of [null, ref(), ref('deleted', 'missing')]) {
    const state = agrees({kind: 'text', provider: 'demo', modelRef, model: 'old'}, snapshot, 'demo');
    assert.equal(state.value, 'demo'); assert.equal(state.selection, null);
  }
});

test('routing: empty catalog inherits DEMO; configured catalog without role default errors instead', () => {
  for (const kind of ['text', 'image', 'audio', 'video']) {
    agrees({kind, provider: 'openai', model: 'legacy'}, fixture([]), 'demo');
    const snapshot = fixture(); snapshot.document.defaults[kind] = null;
    const state = agrees({kind}, snapshot, 'unconfigured');
    assert.match(state.label, /未配置/); assert.equal(state.protocol, null);
  }
  agrees({kind: 'text', modelRef: ref('deleted')}, fixture([]), 'missing-provider');
  assert.equal(nodeModelState({kind: 'text'}, undefined).status, 'loading');
});

test('routing: deleted provider/model/role refs remain editable without mutating or substituting defaults', () => {
  const snapshot = fixture();
  for (const [selection, status] of [[ref('deleted'), 'missing-provider'], [ref('alpha', 'deleted'), 'missing-model'], [ref('alpha', 'speech'), 'missing-model']]) {
    const state = agrees({kind: 'text', modelRef: selection}, snapshot, status);
    assert.deepEqual(JSON.parse(state.value), selection); assert.deepEqual(state.selection, selection);
    assert.equal(nodeModelOptions(snapshot, 'text').some(option => option.value === state.value), false);
  }
  snapshot.document.providers[1].models = [];
  agrees({kind: 'text', modelRef: ref('beta')}, snapshot, 'missing-model');
});

test('routing: null/missing ref uses trimmed legacy override only inside default provider and matching protocol', () => {
  const snapshot = fixture(); snapshot.document.providers[1].models.push(model('beta-only'));
  snapshot.document.providers[0].models.push(model('alpha-only'));
  for (const modelRef of [undefined, null]) {
    const state = agrees({kind: 'text', provider: 'openai', modelRef, model: '  alpha-only  '}, snapshot, 'ready');
    assert.equal(state.selectedModel, 'alpha-only'); assert.equal(state.provider.id, 'alpha');
    agrees({kind: 'text', modelRef, model: 'beta-only'}, snapshot, 'missing-model');
    agrees({kind: 'text', modelRef, provider: 'ollama'}, snapshot, 'protocol-mismatch');
    for (const empty of ['', '  ', undefined]) assert.equal(agrees({kind: 'text', modelRef, model: empty}, snapshot, 'ready').selectedModel, 'shared');
  }
  agrees({kind: 'text', modelRef: ref(), model: 'not-in-catalog'}, snapshot, 'ready');
  agrees({kind: 'text', modelRef: ref(), provider: 'ollama'}, snapshot, 'protocol-mismatch');
});

test('routing: role-specific legacy media overrides never consume stale generic text model', () => {
  const snapshot = fixture();
  for (const kind of ['image', 'audio', 'video']) {
    const selected = snapshot.document.defaults[kind].modelId;
    assert.equal(agrees({kind, model: 'not-in-catalog'}, snapshot, 'ready').selectedModel, selected);
    agrees({kind, [`${kind}Model`]: 'not-in-catalog'}, snapshot, 'missing-model');
  }
});

test('routing: saved credential metadata is not vendor authentication; missing metadata matches preflight failure', () => {
  const snapshot = fixture();
  assert.match(agrees({kind: 'text'}, snapshot, 'ready').description, /未经服务认证/);
  snapshot.credentials.alpha = {configured: false, source: 'none'};
  agrees({kind: 'text'}, snapshot, 'missing-credential');
  snapshot.credentials = {};
  agrees({kind: 'text'}, snapshot, 'missing-credential');
  snapshot.document.providers[0].auth = 'none';
  const state = agrees({kind: 'text'}, snapshot, 'ready'); assert.match(state.description, /无认证配置/);
});

test('routing: same-name models retain provider identity and separate endpoints in both options and backend', () => {
  const snapshot = fixture(); const options = nodeModelOptions(snapshot, 'text');
  assert.equal(options.length, 2); assert.notEqual(options[0].value, options[1].value);
  assert.notEqual(options[0].label, options[1].label);
  for (const option of options) {
    const data = {kind: 'text', ...nodeModelPatch(option.value)};
    const state = agrees(data, snapshot, 'ready');
    assert.equal(state.provider.id, option.providerId); assert.equal(state.selectedModel, 'shared');
    assert.equal(backend(data, snapshot).config.baseUrl, `https://${option.providerId}.invalid/v1`);
  }
});

test('routing: options filter exactly by declared role, not guessed model name or provider enumeration', () => {
  const snapshot = fixture();
  snapshot.document.providers.push(provider('local', {protocol: 'ollama', auth: 'none', models: [model('dall-e-3')]}));
  for (const kind of ['text', 'script', 'director', 'shots', 'clip']) {
    const options = nodeModelOptions(snapshot, kind);
    assert.equal(options.length, 3); assert.equal(options.at(-1).protocol, 'ollama');
  }
  for (const [kind, count] of [['image', 6], ['audio', 2], ['video', 2]]) {
    const options = nodeModelOptions(snapshot, kind);
    assert.equal(options.length, count); assert(options.every(option => option.providerId !== 'local'));
  }
  for (const kind of ['prompt', 'note', 'group', 'output', 'asset']) assert.deepEqual(nodeModelOptions(snapshot, kind), []);
  assert.deepEqual(nodeModelOptions(undefined, 'text'), []);
});

test('routing: JSON-encoded selection values roundtrip punctuation, quotes, unicode and sentinel-like model IDs', () => {
  const snapshot = fixture();
  const ids = ['a::b/c?d#e', 'model "quoted" \\ path', '模型 [a,b] {x:y}', 'inherit', 'demo', '{"providerId":"beta","modelId":"shared"}'];
  snapshot.document.providers[0].models.push(...ids.map(id => model(id)));
  assert.doesNotThrow(() => validateModelSettings(snapshot.document));
  for (const id of ids) {
    const option = nodeModelOptions(snapshot, 'text').find(item => item.modelId === id);
    assert.deepEqual(JSON.parse(option.value), ref('alpha', id));
    assert.deepEqual(nodeModelPatch(option.value).modelRef, ref('alpha', id));
    agrees({kind: 'text', ...nodeModelPatch(option.value)}, snapshot, 'ready');
  }
  for (const invalid of ['', 'null', '{}', '["alpha","shared"]', '{"providerId":"alpha","modelId":"shared","extra":true}']) assert.throws(() => nodeModelPatch(invalid), /模型选择无效/);
});

test('routing: explicit real/inherit patches remove demo/protocol and all four stale model overrides', () => {
  const snapshot = fixture();
  const old = {kind: 'image', provider: 'demo', modelRef: ref('beta', 'deleted'), model: 'old', imageModel: 'dall-e-2', audioModel: 'old', videoModel: 'old'};
  for (const value of ['inherit', JSON.stringify(ref('beta', 'gpt-image-1'))]) {
    const patch = nodeModelPatch(value); const updated = {...old, ...patch};
    for (const key of ['provider', 'model', 'imageModel', 'audioModel', 'videoModel']) { assert(Object.hasOwn(patch, key)); assert.equal(updated[key], undefined); }
    const state = agrees(updated, snapshot, 'ready'); assert.equal(state.selectedModel, 'gpt-image-1');
    assert.equal(state.provider.id, value === 'inherit' ? 'alpha' : 'beta');
  }
  const demo = nodeModelPatch('demo'); assert.equal(demo.provider, 'demo'); assert.equal(demo.modelRef, null);
  agrees({...old, ...demo}, snapshot, 'demo');
});

test('routing: manual/textMode/passive imported media bypass missing refs/providers/credentials exactly like backend', () => {
  const snapshot = fixture(); snapshot.credentials = {}; snapshot.document.defaults.text = null;
  for (const data of [
    {kind: 'text', manual: true}, {kind: 'text', textMode: 'manual'},
    ...['prompt', 'note', 'output', 'group', 'asset'].map(kind => ({kind})),
    {kind: 'image', mediaUrl: 'data:image/png;base64,iVBORw0KGgo='},
    {kind: 'video', mediaUrl: 'data:video/mp4;base64,aGVsbG8='},
    {kind: 'audio', mediaUrl: 'data:audio/mpeg;base64,SUQz'}, // Synthetic ID3 prefix accepted by the real project validator; no playback assertion.
  ]) {
    const state = agrees({...data, modelRef: ref('deleted'), provider: 'ollama'}, snapshot, 'passive');
    assert.equal(state.passive, true); assert.equal(state.imageRules, null); assert.equal(state.error, '');
  }
});

test('routing: inheritance preserves handwriting; only intentional generation selection clears both manual flags', () => {
  const snapshot = fixture();
  for (const flags of [{manual: true}, {textMode: 'manual'}, {manual: true, textMode: 'manual'}]) {
    const original = {kind: 'text', content: 'Keep my written text', ...flags};
    const inherited = {...original, ...nodeModelPatch('inherit')};
    for (const [key, value] of Object.entries(flags)) assert.equal(inherited[key], value);
    assert.equal(nodeModelState(inherited, snapshot).status, 'passive'); assert.equal(backend(inherited, snapshot).selectedModel, null);
    for (const value of ['demo', JSON.stringify(ref())]) {
      const generated = {...original, ...nodeModelPatch(value)};
      assert.equal(generated.manual, undefined); assert.equal(generated.textMode, undefined); assert.equal(generated.content, original.content);
      agrees(generated, snapshot, value === 'demo' ? 'demo' : 'ready');
    }
  }
});

test('routing: ref-selected image capabilities ignore stale imageModel, matching backend request-model selection', () => {
  const snapshot = fixture();
  for (const modelId of ['gpt-image-1', 'dall-e-3', 'dall-e-2']) {
    const data = {kind: 'image', modelRef: ref('beta', modelId), imageModel: modelId === 'dall-e-3' ? 'gpt-image-1' : 'dall-e-3'};
    const state = agrees(data, snapshot, 'ready');
    assert.equal(state.selectedModel, modelId);
    for (const size of ['auto', '256x256', '512x512', '1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792']) {
      const binding = backend(data, snapshot);
      const params = () => imageParameters(binding.config, {...data, imageModel: binding.selectedModel, imageSize: size});
      if (state.imageRules.sizes.includes(size)) assert.doesNotThrow(params);
      else assert.throws(params, /不支持图像尺寸/);
    }
    if (modelId === 'dall-e-3') {
      assert.equal(state.imageRules.maxBatch, 1);
      const binding = backend(data, snapshot);
      assert.throws(() => imageParameters(binding.config, {...data, imageModel: binding.selectedModel, batchSize: 2}), /batchSize/);
      assert.deepEqual(imageParameters(binding.config, {...data, imageModel: binding.selectedModel, imageSize: 'auto', imageAspectRatio: '16:9'}), {n: 1, size: '1792x1024'});
    }
  }
});

test('routing: image legacy override and custom case-sensitive model IDs use the actual selected model capabilities', () => {
  const snapshot = fixture();
  snapshot.document.providers[0].models.push(model('DALL-E-3', ['image']), model('custom-image', ['image']));
  const legacy = agrees({kind: 'image', modelRef: null, imageModel: ' dall-e-2 '}, snapshot, 'ready');
  assert.deepEqual(legacy.imageRules.sizes, ['256x256', '512x512', '1024x1024']);
  for (const modelId of ['DALL-E-3', 'custom-image']) {
    const state = agrees({kind: 'image', modelRef: ref('alpha', modelId)}, snapshot, 'ready');
    assert.equal(state.imageRules, null);
    assert.deepEqual(imageParameters(backend({kind: 'image', modelRef: ref('alpha', modelId)}, snapshot).config, {imageSize: '256x256', batchSize: 4}), {n: 4, size: '256x256'});
  }
});
