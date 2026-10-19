import test from 'node:test';
import assert from 'node:assert/strict';
import {validateProject, serializeProject, parseProject} from '../lib/project.mjs';
import {validateClient, cleanProject, executionProject, addCanvas, switchCanvas} from '../src/graph.mjs';
import {node, project} from './helpers.mjs';

const ref = () => ({providerId:'provider-a',modelId:'shared-model'});
const configured = () => ({...project([node('a','text',{modelRef:ref()})]),version:2});

test('project v2 model reference survives both validators, cleaning and persistence', () => {
  const source=configured();
  assert.deepEqual(validateProject(source).nodes[0].data.modelRef,ref());
  const clean=validateClient(source);
  assert.equal(clean.version,2);
  assert.deepEqual(clean.nodes[0].data.modelRef,ref());
  assert.deepEqual(clean.workspace.canvases[0].nodes[0].data.modelRef,ref());
  assert.deepEqual(parseProject(serializeProject(clean)),clean);
  assert.deepEqual(cleanProject(clean),clean);
});

test('v1 cannot silently activate a new modelRef and unknown versions remain unsupported', () => {
  for (const validator of [validateProject,validateClient]) {
    assert.throws(()=>validator({...configured(),version:1}),/version: 2/);
    assert.throws(()=>validator({...configured(),version:4}));
    assert.doesNotThrow(()=>validator(project()));
    assert.doesNotThrow(()=>validator({...project([node('a','text',{modelRef:null})]),version:2}));
  }
});

test('model selection shape is strict but missing catalog references remain editable for preflight', () => {
  for (const validator of [validateProject,validateClient]) {
    assert.doesNotThrow(()=>validator(configured()));
    for (const modelRef of [{providerId:'provider-a'}, {providerId:'A',modelId:'x'}, {providerId:'provider-a',modelId:'x',credentialRef:'hidden'}, 'x', []]) {
      const source=configured();source.nodes[0].data.modelRef=modelRef;
      assert.throws(()=>validator(source));
    }
  }
});

test('inactive canvas model references keep v2 semantics through switching and execution flattening', () => {
  let source=validateClient(configured());const first=source.workspace.activeCanvasId;
  source=addCanvas(source,'Other');
  assert.equal(source.version,2);
  source=switchCanvas(source,first);
  assert.deepEqual(source.nodes[0].data.modelRef,ref());
  const execution=executionProject(source,['a']);
  assert.equal(execution.version,2);
  assert.deepEqual(execution.nodes[0].data.modelRef,ref());
  assert.doesNotThrow(()=>validateProject(execution));
  const legacy={...source,version:1};
  assert.throws(()=>validateProject(legacy));assert.throws(()=>validateClient(legacy));
});

test('model catalog, vault and opaque credential bindings cannot enter project metadata', () => {
  for (const validator of [validateProject,validateClient]) for (const field of ['credentialRef','credentials','vault','encryptedCredentials','modelSettings']) {
    const source=project();source.nodes[0].data.metadata={[field]:'controlled-noncredential-marker'};
    assert.throws(()=>validator(source),/凭据|模型服务配置/);
  }
});
