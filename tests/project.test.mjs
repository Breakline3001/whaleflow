import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProject, parseProject, serializeProject, writeProject, readProject, importMediaFile, validateMediaUrl, MAX_MEDIA_BYTES } from '../lib/project.mjs';
import { project, node, edge } from './helpers.mjs';

const temporary = async (t) => {
  const dir = await mkdtemp(join(fileURLToPath(new URL('.', import.meta.url)), '.tmp-project-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test('project JSON roundtrip preserves fixed protocol and additional node metadata', () => {
  const original = project([node('a', 'text', { model: 'qwen3', provider: 'ollama', custom: { collapsed: true } })]);
  assert.deepEqual(parseProject(serializeProject(original)), original);
  assert.deepEqual(validateProject(project([], [])), project([], []));
  const optional = project([node('b', 'text', { provider: undefined, model: undefined })]);
  assert.doesNotThrow(() => validateProject(optional));
  assert.equal(Object.hasOwn(parseProject(serializeProject(optional)).nodes[0].data, 'provider'), false);
});

test('reject malformed protocol, coordinates, viewport and invalid JSON', () => {
  assert.throws(() => parseProject('{ broken'), /JSON/);
  for (const mutate of [
    (p) => { p.version = 4; }, (p) => { p.nodes[0].type = 'other'; },
    (p) => { p.nodes[0].data.kind = 'unknown-kind'; }, (p) => { p.nodes[0].position.x = Infinity; },
    (p) => { p.viewport.zoom = 0; }, (p) => { p.nodes[0].data.content = null; },
    (p) => { p.nodes[0].data.provider = 'unknown'; }, (p) => { p.viewport = null; },
  ]) { const p = project(); mutate(p); assert.throws(() => validateProject(p)); }
});

test('reject duplicate nodes, edge IDs, repeated connections, dangling links and cycles', () => {
  assert.throws(() => validateProject(project([node('a'), node('a')])), /重复/);
  const nodes = [node('a'), node('b')];
  assert.throws(() => validateProject(project(nodes, [edge('a', 'b', 'e'), edge('b', 'a', 'e')])), /重复/);
  assert.throws(() => validateProject(project(nodes, [edge('a', 'b', 'e1'), edge('a', 'b', 'e2')])), /重复连线/);
  assert.throws(() => validateProject(project(nodes, [edge('a', 'missing')])), /悬空/);
  assert.throws(() => validateProject(project(nodes, [edge('a', 'b'), edge('b', 'a')])), /循环/);
  assert.throws(() => validateProject(project(nodes, [edge('a', 'a')])), /循环/);
});

test('secrets, prototype keys, non-JSON values and recursive objects cannot be persisted', () => {
  for (const key of ['apiKey', 'api_key', 'token', 'authorization', 'access_token']) {
    const p = project(); p.nodes[0].data[key] = 'not-a-real-secret';
    assert.throws(() => serializeProject(p), /凭据/);
  }
  assert.throws(() => parseProject('{"__proto__":{}}'), /不安全/);
  const p = project(); p.nodes[0].data.self = p;
  assert.throws(() => validateProject(p), /循环引用/);
  const other = project(); other.nodes[0].data.callback = () => {};
  assert.throws(() => validateProject(other), /JSON/);
});

test('media URL must be portable and match node kind', () => {
  const image = 'data:image/png;base64,aGVsbG8=';
  assert.equal(validateMediaUrl(image, 'image'), image);
  assert.throws(() => validateMediaUrl('https://example.test/image.png', 'image'), /自包含/);
  assert.throws(() => validateMediaUrl('file:///C:/image.png', 'image'), /自包含/);
  assert.throws(() => validateMediaUrl(image, 'video'), /自包含/);
  assert.throws(() => validateMediaUrl('data:image/png;base64,!!!!!', 'image'), /base64/);
  assert.throws(() => validateProject(project([node('a', 'text', { mediaUrl: image })])), /只有/);
  assert.doesNotThrow(() => validateProject(project([node('a', 'image', { mediaUrl: image })])));
});

test('atomic saves replace the full project and clean temporary files', async (t) => {
  const dir = await temporary(t);
  const file = join(dir, 'nested', 'project.json');
  await writeProject(file, project());
  const changed = project([node('b')]); changed.name = '已保存';
  await writeProject(file, changed);
  assert.deepEqual(await readProject(file), changed);
  assert.deepEqual(await readdir(join(dir, 'nested')), ['project.json']);
  const invalid = project(); invalid.nodes[0].data.apiKey = 'must-not-save';
  await assert.rejects(writeProject(file, invalid), /凭据/);
  assert.deepEqual(await readProject(file), changed);
});

test('import media embeds data, verifies signatures and rejects oversized files', async (t) => {
  const dir = await temporary(t);
  const file = join(dir, 'image.png');
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1]);
  await writeFile(file, bytes);
  assert.deepEqual(await importMediaFile(file), { kind: 'image', name: 'image.png', url: `data:image/png;base64,${bytes.toString('base64')}` });
  await writeFile(file, 'not a PNG');
  await assert.rejects(importMediaFile(file), /扩展名不一致/);
  await assert.rejects(importMediaFile(join(dir, 'unknown.svg')), /不支持/);
  const large = await open(file, 'w'); await large.truncate(MAX_MEDIA_BYTES + 1); await large.close();
  await assert.rejects(importMediaFile(file), /20 MiB/);
});
