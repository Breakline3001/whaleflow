import test from 'node:test';
import assert from 'node:assert/strict';
import {imageParameters, validateGenerationOptions} from '../lib/generation-options.mjs';
import {executeWorkflow} from '../lib/workflow.mjs';
import {validateProject, serializeProject, parseProject} from '../lib/project.mjs';
import {validateClient} from '../src/graph.mjs';
import {node, project, jsonResponse} from './helpers.mjs';

const sizes = ['auto', '256x256', '512x512', '1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792'];
const supported = {
  'gpt-image-1': ['auto', '1024x1024', '1536x1024', '1024x1536'],
  'gpt-image-1-mini': ['auto', '1024x1024', '1536x1024', '1024x1536'],
  'dall-e-3': ['1024x1024', '1792x1024', '1024x1792'],
  'dall-e-2': ['256x256', '512x512', '1024x1024'],
};
const params = (model, data = {}, config = {}) => imageParameters({imageModel: model, ...config}, data);
const png = 'iVBORw0KGgo=';

test('known image model families accept only their final explicit wire sizes and never rewrite old choices', () => {
  for (const [model, allowed] of Object.entries(supported)) for (const size of sizes) {
    const data = {imageSize: size}; const before = structuredClone(data);
    if (allowed.includes(size)) assert.deepEqual(params(model, data), {n: 1, size});
    else assert.throws(() => params(model, data), error => error.message.includes(model) && error.message.includes(size));
    assert.deepEqual(data, before);
  }
});

test('known models permit unspecified size for provider defaults while explicit unsupported auto is rejected', () => {
  for (const model of Object.keys(supported)) assert.deepEqual(params(model), {n: 1});
  for (const model of ['dall-e-2', 'dall-e-3']) assert.throws(() => params(model, {imageSize: 'auto'}), /不支持图像尺寸 auto/);
  assert.deepEqual(params('gpt-image-1', {imageSize: 'auto'}), {n: 1, size: 'auto'});
});

test('ratio mappings are checked against the actual final model size before request construction', () => {
  const valid = [
    ['gpt-image-1', '1:1', '1024x1024'], ['gpt-image-1', '3:2', '1536x1024'], ['gpt-image-1', '2:3', '1024x1536'],
    ['dall-e-3', '1:1', '1024x1024'], ['dall-e-3', '16:9', '1792x1024'], ['dall-e-3', '9:16', '1024x1792'],
    ['dall-e-2', '1:1', '1024x1024'],
  ];
  for (const [model, ratio, size] of valid) {
    assert.deepEqual(params(model, {imageAspectRatio: ratio}), {n: 1, size});
    assert.deepEqual(params(model, {imageSize: 'auto', imageAspectRatio: ratio}), {n: 1, size});
  }
  for (const [model, ratio] of [['gpt-image-1', '16:9'], ['gpt-image-1', '9:16'], ['dall-e-3', '3:2'], ['dall-e-3', '2:3'], ['dall-e-2', '16:9'], ['dall-e-2', '3:2']]) {
    assert.throws(() => params(model, {imageAspectRatio: ratio}), error => error.message.includes(model) && error.message.includes(ratio) && /不支持/.test(error.message));
  }
});

test('dall-e-3 allows only n=1 while GPT Image and dall-e-2 retain the generic batch bound', () => {
  for (const count of [1, 2, 3, 4]) {
    if (count === 1) assert.deepEqual(params('dall-e-3', {batchSize: count}), {n: 1});
    else assert.throws(() => params('dall-e-3', {batchSize: count}), /dall-e-3.*batchSize.*1/);
    for (const model of ['gpt-image-1', 'dall-e-2', 'custom-generator']) assert.deepEqual(params(model, {batchSize: count}), {n: count});
  }
  for (const count of [0, 5, 1.5]) assert.throws(() => params('custom-generator', {batchSize: count}), /batchSize/);
});

test('dedicated node model overrides are trimmed and empty overrides correctly inherit global model capabilities', () => {
  assert.deepEqual(params('gpt-image-1', {imageModel: '  dall-e-3  ', imageSize: '1792x1024'}), {n: 1, size: '1792x1024'});
  assert.throws(() => params('dall-e-3', {imageModel: 'gpt-image-1', imageSize: '1792x1024'}), /gpt-image-1.*1792x1024/);
  for (const empty of ['', '   ', undefined]) assert.throws(() => params('  gpt-image-1  ', {imageModel: empty, imageSize: '256x256'}), /gpt-image-1.*256x256/);
  assert.throws(() => params('dall-e-3', {imageModel: '', batchSize: 2}), /batchSize/);
  assert.deepEqual(params('gpt-image-1', {model: 'dall-e-3', imageAspectRatio: '3:2'}), {n: 1, size: '1536x1024'});
});

test('global image options inherit independently and unknown custom model IDs receive no guessed capability restrictions', () => {
  assert.deepEqual(params('gpt-image-1', {}, {imageSize: '1536x1024', batchSize: 2}), {n: 2, size: '1536x1024'});
  assert.throws(() => params('dall-e-2', {imageModel: 'gpt-image-1'}, {imageSize: '256x256'}), /gpt-image-1.*256x256/);
  assert.deepEqual(params('dall-e-3', {imageModel: 'custom-generator'}, {imageSize: 'auto', batchSize: 4}), {n: 4, size: 'auto'});
  for (const model of ['custom-generator', 'custom-dall-e-3', 'my-gpt-image-1']) for (const size of sizes) assert.deepEqual(params(model, {imageSize: size, batchSize: 4}), {n: 4, size});
});

test('model-incompatible but generically valid settings remain openable and roundtrip without silent correction', () => {
  for (const data of [
    {imageModel: 'gpt-image-1', imageSize: '256x256'},
    {imageModel: 'gpt-image-1', imageAspectRatio: '16:9'},
    {imageModel: 'dall-e-3', imageSize: 'auto', batchSize: 4},
  ]) {
    assert.doesNotThrow(() => validateGenerationOptions(data));
    const value = project([node('a', 'image', data)]);
    assert.doesNotThrow(() => validateProject(value));
    assert.deepEqual(parseProject(serializeProject(value)), value);
    const restored = validateClient(value);
    for (const [key, field] of Object.entries(data)) assert.equal(restored.nodes[0].data[key], field);
  }
});

test('invalid known-model generation fails the node with zero fetch calls even when running the entire graph', async () => {
  const invalid = [
    ['gpt-image-1', {imageSize: '256x256'}], ['gpt-image-1', {imageAspectRatio: '16:9'}],
    ['dall-e-3', {imageSize: 'auto'}], ['dall-e-3', {batchSize: 2}],
    ['dall-e-3', {imageAspectRatio: '3:2'}], ['dall-e-2', {imageSize: '1536x1024'}],
    ['gpt-image-1', {imageModel: '', imageSize: '256x256'}],
  ];
  for (const [imageModel, data] of invalid) {
    let fetchCalls = 0; const events = [];
    const result = await executeWorkflow(project([node('a', 'image', data), node('later', 'text')]), {provider: 'openai', model: 'text-model', imageModel}, {
      fetchImpl: async () => { fetchCalls++; throw new Error('No real network permitted'); }, onEvent: event => events.push(event),
    });
    assert.equal(result.status, 'error'); assert.equal(fetchCalls, 0); assert.equal(result.outputs.a, undefined);
    assert.equal(events.at(-1).nodeId, 'a'); assert.match(events.at(-1).error, /imageModel/);
    assert(!events.some(event => event.nodeId === 'later'));
  }
});

test('valid image workflows send the exact dedicated model, mapped size and batch through the real request shape mock', async () => {
  const valid = [
    {globalModel: 'gpt-image-1', data: {imageAspectRatio: '3:2', batchSize: 2}, expectedModel: 'gpt-image-1', size: '1536x1024', n: 2},
    {globalModel: 'gpt-image-1', data: {imageModel: 'dall-e-3', imageAspectRatio: '16:9'}, expectedModel: 'dall-e-3', size: '1792x1024', n: 1},
    {globalModel: 'dall-e-2', data: {imageModel: '   ', imageSize: '512x512'}, expectedModel: 'dall-e-2', size: '512x512', n: 1},
    {globalModel: 'gpt-image-1', data: {}, expectedModel: 'gpt-image-1', size: undefined, n: 1},
    {globalModel: 'custom-generator', data: {imageSize: '256x256', batchSize: 4}, expectedModel: 'custom-generator', size: '256x256', n: 4},
  ];
  for (const fixture of valid) {
    let call;
    const result = await executeWorkflow(project([node('a', 'image', {content: 'A blue whale', model: 'ignored-text-model', ...fixture.data})]), {provider: 'openai', baseUrl: 'https://mock.invalid/v1', model: 'text-only', imageModel: fixture.globalModel}, {
      apiKey: 'test-only-key', fetchImpl: async (url, options) => {
        call = {url, options}; const body = JSON.parse(options.body);
        return jsonResponse({data: Array.from({length: body.n}, () => ({b64_json: png}))});
      },
    });
    assert.equal(result.status, 'success'); assert.equal(call.url, 'https://mock.invalid/v1/images/generations');
    const body = JSON.parse(call.options.body);
    assert.deepEqual(body, {model: fixture.expectedModel, prompt: 'A blue whale', n: fixture.n, ...(fixture.size ? {size: fixture.size} : {})});
    assert.equal(call.options.headers.Authorization, 'Bearer test-only-key'); assert.equal(call.options.redirect, 'error');
    assert.equal(result.outputs.a.demo, false); assert.equal(result.outputs.a.images?.length ?? 1, fixture.n);
  }
});
