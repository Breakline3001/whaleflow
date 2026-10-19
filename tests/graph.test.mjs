import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NODE_KINDS, createProject, demoProject, cleanProject, validateClient,
  switchCanvas, addCanvas, deleteCanvas, renameCanvas,
  descendants, invalidate, canConnect, addConnection, removeSelection,
  duplicateSelection, absolutePosition, groupSelection, ungroupSelection,
  layoutProject, executionProject,
} from '../src/graph.mjs';

const node = (id, x = 0, y = 0, extra = {}) => ({ id, type: 'workflow', position: { x, y }, width: 100, height: 80, data: { kind: 'text', title: id, content: '', lastOutput: { text: `${id} result` } }, ...extra });
const group = (id, x, y, extra = {}) => node(id, x, y, { width: 600, height: 500, data: { kind: 'group', title: id, content: '' }, ...extra });
const edge = (source, target, extra = {}) => ({ id: `${source}-${target}`, source, target, ...extra });
const project = (nodes = [], edges = []) => ({ ...createProject(), nodes, edges });
const copy = value => JSON.parse(JSON.stringify(value));
function freeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; }
const at = (p, id) => absolutePosition(p.nodes, id);
const selected = (p, ids) => ({ ...p, nodes: p.nodes.map(item => ({ ...item, selected: ids.includes(item.id) })) });
function nested() {
  return project([
    group('outer', 100, 200),
    group('inner', 50, 60, { parentId: 'outer', extent: 'parent', width: 350, height: 300 }),
    node('a', 20, 30, { parentId: 'inner', extent: 'parent' }),
    node('b', 180, 40, { parentId: 'inner', extent: 'parent' }),
    node('c', 900, 250), node('d', 1200, 250), node('unrelated', -200, 0),
  ], [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')]);
}

test('createProject is empty, synchronized and independent on every call', () => {
  const p = createProject(), other = createProject();
  assert.equal(p.name, '未命名工作区'); assert.equal(p.version, 1);
  assert.deepEqual(p.viewport, { x: 0, y: 0, zoom: 1 });
  assert.equal(p.workspace.canvases.length, 1); assert.equal(p.workspace.canvases[0].name, '画布 1');
  assert.equal(p.workspace.activeCanvasId, p.workspace.canvases[0].id);
  p.workspace.canvases[0].nodes.push(node('x'));
  assert.equal(p.nodes.length, 0); assert.equal(other.workspace.canvases[0].nodes.length, 0);
});

test('demo matches the original five IDs and explicitly stays offline', () => {
  const p = validateClient(demoProject());
  assert.deepEqual(p.nodes.map(n => n.id), ['idea', 'writer', 'visual', 'result', 'memo']);
  assert.equal(p.edges.length, 3);
  for (const n of p.nodes) { assert.equal(n.type, 'workflow'); assert.match(n.data.content, /离线.*[Dd]emo/); }
  for (const n of p.nodes.filter(n => ['text', 'image'].includes(n.data.kind))) assert.equal(n.data.provider, 'demo');
});

test('cleanProject drops RF state and unknown fields, retains stable geometry/data/handles', () => {
  const p = nested();
  p.nodes[2] = { ...p.nodes[2], selected: true, dragging: true, measured: { width: 999 }, internals: {}, style: { opacity: 0 }, data: { ...p.nodes[2].data, optional: undefined, nested: { list: [1, { value: 'saved' }] } } };
  p.edges[0] = { ...p.edges[0], selected: true, animated: true, sourceHandle: 'out', targetHandle: 'in' };
  p.settings = { provider: 'demo' };
  p.viewport.runtime = 'discard'; p.nodes[2].position.runtime = 'discard';
  const before = copy(p), cleaned = cleanProject(freeze(p)), a = cleaned.nodes.find(n => n.id === 'a');
  assert.equal(Object.hasOwn(cleaned.viewport, 'runtime'), false); assert.equal(Object.hasOwn(a.position, 'runtime'), false);
  assert.deepEqual(copy(p), before);
  assert.deepEqual(Object.keys(cleaned).sort(), ['edges', 'name', 'nodes', 'version', 'viewport', 'workspace']);
  for (const key of ['selected', 'dragging', 'measured', 'internals', 'style']) assert.equal(Object.hasOwn(a, key), false);
  assert.equal(a.parentId, 'inner'); assert.equal(a.extent, 'parent'); assert.equal(a.width, 100); assert.equal(a.height, 80);
  assert.equal(a.data.lastOutput.text, 'a result'); assert.equal(Object.hasOwn(a.data, 'optional'), false);
  assert.deepEqual(cleaned.edges[0], edge('a', 'b', { sourceHandle: 'out', targetHandle: 'in' }));
  a.data.nested.list[1].value = 'changed';
  assert.equal(p.nodes[2].data.nested.list[1].value, 'saved');
  assert.equal(cleaned.workspace.canvases[0].nodes[2].data.nested.list[1].value, 'saved');
});

test('legacy first-version project migrates without losing outputs or geometry', () => {
  const old = { version: 1, name: 'first version', nodes: [node('legacy')], edges: [], viewport: { x: 9, y: -4, zoom: 0.8 } };
  const result = validateClient(freeze(old));
  assert.equal(result.workspace.canvases[0].name, '画布 1');
  assert.deepEqual(result.workspace.canvases[0].nodes, result.nodes);
  assert.deepEqual(result.viewport, old.viewport); assert.equal(result.nodes[0].data.lastOutput.text, 'legacy result');
});

test('validation accepts every supported kind and normalizes workflow type', () => {
  const p = project(NODE_KINDS.map((kind, i) => node(`kind-${i}`, i * 100, 0, { data: { kind, title: kind, content: '' } })));
  delete p.nodes[0].type;
  const result = validateClient(p);
  assert.ok(result.nodes.every(n => n.type === 'workflow'));
});

test('validation rejects malformed structures, strings, dimensions, extents and coordinates', () => {
  for (const mutate of [
    p => { p.version = 4; }, p => { p.name = 10; }, p => { p.nodes = {}; }, p => { p.edges = null; },
    p => { p.nodes[0].id = ''; }, p => { p.nodes.push(copy(p.nodes[0])); }, p => { p.nodes[0].data.kind = 'unknown'; },
    p => { p.nodes[0].data.content = null; }, p => { delete p.nodes[0].data.title; }, p => { p.nodes[0].type = 'group'; },
    p => { p.nodes[0].position.x = NaN; }, p => { p.nodes[0].position.y = Infinity; },
    p => { p.nodes[0].width = 0; }, p => { p.nodes[0].height = -1; }, p => { p.nodes[0].width = Infinity; },
    p => { p.nodes[0].width = '100'; }, p => { p.nodes[0].extent = 'parent'; }, p => { p.nodes[0].extent = [[3, 0], [2, 1]]; },
    p => { p.viewport.zoom = 0; }, p => { p.viewport.x = Infinity; }, p => { p.workspace.activeCanvasId = 'missing'; },
    p => { p.workspace.canvases = []; }, p => { p.workspace.canvases.push(copy(p.workspace.canvases[0])); },
  ]) {
    const p = project([node('a')]); mutate(p); assert.throws(() => validateClient(p));
  }
  assert.throws(() => validateClient(null));
  const rectangleExtent = project([node('a', 0, 0, { extent: [[-10, -10], [100, 100]] })]);
  assert.throws(() => validateClient(rectangleExtent), /extent/);
});

test('validation rejects invalid parents, parent cycles and non-finite world positions', () => {
  assert.throws(() => validateClient(project([node('a', 0, 0, { parentId: 'missing' })])));
  assert.throws(() => validateClient(project([node('a'), node('b', 0, 0, { parentId: 'a' })])));
  assert.throws(() => validateClient(project([group('a', 0, 0, { parentId: 'b' }), group('b', 0, 0, { parentId: 'a' })])));
  assert.throws(() => validateClient(project([group('a', 1.7e308, 0), node('b', 1.7e308, 0, { parentId: 'a' })])));
});

test('DAG validation rejects unknown, repeated, cyclic and structural group edges', () => {
  for (const edges of [[edge('a', 'missing')], [edge('a', 'a')], [edge('a', 'b'), edge('a', 'b', { id: 'other' })], [edge('a', 'b'), edge('b', 'a')], [edge('g', 'a')], [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')], [edge('a', 'b'), edge('b', 'c', { id: 'a-b' })]]) {
    assert.throws(() => validateClient(project([node('a'), node('b'), node('c'), group('g', 0, 0)], edges)));
  }
  assert.doesNotThrow(() => validateClient(project([node('a'), node('b'), node('c'), node('d')], [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')])));
});

test('workspace switching synchronizes current graph, viewport and inactive snapshots', () => {
  let p = project([node('first')]); p.viewport = { x: 12, y: 30, zoom: 1.5 };
  const firstId = p.workspace.activeCanvasId;
  p = addCanvas(freeze(p), '第二张');
  const secondId = p.workspace.activeCanvasId;
  assert.notEqual(firstId, secondId); assert.equal(p.nodes.length, 0);
  p.nodes.push(node('second')); p.viewport = { x: -90, y: 22, zoom: 0.4 };
  p = switchCanvas(freeze(p), firstId);
  assert.deepEqual(p.nodes.map(n => n.id), ['first']); assert.deepEqual(p.viewport, { x: 12, y: 30, zoom: 1.5 });
  p = renameCanvas(p, secondId, '素材');
  const cleaned = cleanProject(p);
  assert.equal(cleaned.workspace.canvases[1].name, '素材'); assert.equal(cleaned.workspace.canvases[1].nodes[0].id, 'second');
  p = switchCanvas(cleaned, secondId);
  assert.equal(p.nodes[0].id, 'second'); assert.deepEqual(p.viewport, { x: -90, y: 22, zoom: 0.4 });
  p.nodes[0].data.content = 'edited';
  assert.notEqual(cleaned.workspace.canvases[1].nodes[0].data.content, 'edited');
});

test('canvas deletion never empties workspace or leaves a dangling active ID', () => {
  let p = addCanvas(addCanvas(createProject(), 'B'), 'C');
  const [a, b, c] = p.workspace.canvases.map(n => n.id);
  p = deleteCanvas(p, b); assert.equal(p.workspace.activeCanvasId, c);
  p = deleteCanvas(p, c); assert.equal(p.workspace.activeCanvasId, a);
  p = deleteCanvas(p, a); assert.equal(p.workspace.canvases.length, 1);
  assert.deepEqual(deleteCanvas(p, 'missing'), p); assert.deepEqual(switchCanvas(p, 'missing'), p);
  assert.equal(addCanvas(p).workspace.canvases[1].name, '画布 2');
});

test('inactive canvas corruption is validated and inactive contents are never dropped by clean', () => {
  let p = addCanvas(project([node('saved')]), 'next');
  assert.equal(cleanProject(p).workspace.canvases[0].nodes[0].id, 'saved');
  p.workspace.canvases[0].nodes[0].position.x = Infinity;
  assert.throws(() => validateClient(p));
});

test('descendants is inclusive, follows dataflow only, and terminates even on malformed cycles', () => {
  const p = nested(); assert.deepEqual([...descendants(p, ['a'])], ['a', 'b', 'c', 'd']);
  assert.deepEqual([...descendants(p, ['inner'])], ['inner']);
  assert.deepEqual([...descendants({ edges: [edge('a', 'b'), edge('b', 'a')] }, ['a'])], ['a', 'b']);
});

test('invalidate clears only specified lastOutput values and deeply isolates the result', () => {
  const p = freeze(nested()), result = invalidate(p, ['a', 'c']);
  assert.equal(result.nodes.find(n => n.id === 'a').data.lastOutput, undefined);
  assert.equal(result.nodes.find(n => n.id === 'b').data.lastOutput.text, 'b result');
  result.nodes.find(n => n.id === 'b').data.lastOutput.text = 'changed';
  assert.equal(p.nodes.find(n => n.id === 'b').data.lastOutput.text, 'b result');
  assert.equal(result.workspace.canvases[0].nodes.find(n => n.id === 'c').data.lastOutput, undefined);
});

test('canConnect rejects self, duplicate, unknown, cycle and group endpoints', () => {
  const p = nested();
  for (const connection of [null, { source: 'a', target: 'a' }, { source: 'a', target: 'b' }, { source: 'd', target: 'a' }, { source: 'missing', target: 'a' }, { source: 'a', target: 'missing' }, { source: 'outer', target: 'a' }, { source: 'a', target: 'inner' }]) assert.equal(canConnect(p, connection), false);
  assert.equal(canConnect(p, { source: 'unrelated', target: 'a' }), true);
});

test('addConnection is immutable, preserves handles and invalidates target plus downstream', () => {
  const p = freeze(nested()), result = addConnection(p, { source: 'unrelated', target: 'b', sourceHandle: 'out', targetHandle: 'in' });
  assert.equal(result.edges.length, p.edges.length + 1); assert.equal(result.edges.at(-1).sourceHandle, 'out');
  for (const id of ['b', 'c', 'd']) assert.equal(result.nodes.find(n => n.id === id).data.lastOutput, undefined);
  assert.equal(result.nodes.find(n => n.id === 'a').data.lastOutput.text, 'a result');
  assert.ok(p.nodes.find(n => n.id === 'b').data.lastOutput);
  assert.equal(addConnection(p, { source: 'd', target: 'a' }).edges.length, p.edges.length);
  assert.doesNotThrow(() => validateClient(result));
});

test('absolutePosition resolves arbitrary-order nested groups and rejects missing/cyclic parents', () => {
  const p = nested(); assert.deepEqual(at(p, 'a'), { x: 170, y: 290 });
  assert.deepEqual(absolutePosition([...p.nodes].reverse(), p.nodes[2]), { x: 170, y: 290 });
  assert.throws(() => absolutePosition(p.nodes, 'missing'));
  assert.throws(() => absolutePosition([group('a', 0, 0, { parentId: 'a' })], 'a'));
});

test('groupSelection preserves leaf world positions, emits group first and encloses bbox with padding', () => {
  const p = selected(project([node('a', -10, 40), node('b', 240, 180), node('c', 700, 30)], [edge('a', 'b')]), ['a', 'b']);
  const before = copy(p), result = groupSelection(freeze(p), '镜头组'), g = result.nodes.find(n => n.data.kind === 'group');
  assert.deepEqual(copy(p), before); assert.deepEqual(at(result, 'a'), at(p, 'a')); assert.deepEqual(at(result, 'b'), at(p, 'b'));
  assert.deepEqual(g.position, { x: -42, y: 8 }); assert.equal(g.width, 414); assert.equal(g.height, 284);
  assert.equal(g.type, 'workflow'); assert.equal(g.data.title, '镜头组'); assert.equal(g.data.content, ''); assert.equal(g.selected, true);
  assert.ok(result.nodes.indexOf(g) < result.nodes.findIndex(n => n.id === 'a'));
  assert.deepEqual(result.edges.map(e => [e.source, e.target]), [['a', 'b']]);
  assert.doesNotThrow(() => validateClient(result));
});

test('grouping children inside a group uses their common parent and keeps unrelated nested structure', () => {
  const p = selected(nested(), ['a', 'b']), result = groupSelection(freeze(p));
  const g = result.nodes.find(n => n.selected);
  assert.equal(g.parentId, 'inner'); assert.equal(g.extent, 'parent');
  for (const id of ['a', 'b', 'c', 'inner', 'outer']) assert.deepEqual(at(result, id), at(p, id));
  assert.equal(result.nodes.find(n => n.id === 'inner').parentId, 'outer');
  assert.doesNotThrow(() => validateClient(result));
});

test('grouping an already selected group treats it as one root and preserves its nested children', () => {
  const p = selected(nested(), ['inner', 'a']), result = groupSelection(p);
  const wrapper = result.nodes.find(n => n.selected);
  assert.equal(wrapper.parentId, 'outer'); assert.equal(result.nodes.find(n => n.id === 'inner').parentId, wrapper.id);
  assert.equal(result.nodes.find(n => n.id === 'a').parentId, 'inner');
  for (const id of ['a', 'b', 'inner']) assert.deepEqual(at(result, id), at(p, id));
  assert.doesNotThrow(() => validateClient(result));
});

test('grouping roots from different parents reparents at their common ancestor without world jumps', () => {
  const p = selected(nested(), ['a', 'c']), result = groupSelection(p), g = result.nodes.find(n => n.selected);
  assert.equal(g.parentId, undefined); assert.equal(result.nodes.find(n => n.id === 'a').parentId, g.id);
  for (const id of ['a', 'b', 'c', 'inner']) assert.deepEqual(at(result, id), at(p, id));
});

test('ungroup releases direct children to the surviving parent without moving leaves or connections', () => {
  const p = selected(nested(), ['inner']), result = ungroupSelection(freeze(p));
  assert.equal(result.nodes.some(n => n.id === 'inner'), false);
  assert.equal(result.nodes.find(n => n.id === 'a').parentId, 'outer');
  for (const id of ['a', 'b', 'c', 'd']) assert.deepEqual(at(result, id), at(p, id));
  assert.deepEqual(result.edges, p.edges); assert.doesNotThrow(() => validateClient(result));
});

test('ungroup handles multiple selected nesting levels simultaneously and strips orphan parent extent', () => {
  const p = selected(nested(), ['outer', 'inner']), result = ungroupSelection(freeze(p));
  for (const id of ['a', 'b']) {
    const n = result.nodes.find(n => n.id === id);
    assert.equal(n.parentId, undefined); assert.equal(n.extent, undefined); assert.equal(n.selected, true);
    assert.deepEqual(at(result, id), at(p, id));
  }
  assert.deepEqual(result.edges, p.edges); assert.doesNotThrow(() => validateClient(result));
});

test('group/ungroup round trip preserves coordinates and immutable snapshots for undo', () => {
  const initial = freeze(selected(nested(), ['a', 'b'])), before = copy(initial);
  const grouped = groupSelection(initial), groupBefore = copy(grouped), restored = ungroupSelection(freeze(grouped));
  assert.deepEqual(copy(initial), before); assert.deepEqual(copy(grouped), groupBefore);
  for (const id of initial.nodes.map(n => n.id)) assert.deepEqual(at(restored, id), at(initial, id));
  assert.equal(restored.nodes.length, initial.nodes.length);
});

test('nested duplicate rewrites internal parent references and edges, offsets only copied roots', () => {
  const p = freeze(selected(nested(), ['inner', 'a'])), result = duplicateSelection(p), copies = result.nodes.filter(n => n.selected);
  assert.equal(copies.length, 3);
  const g = copies.find(n => n.data.kind === 'group'), a = copies.find(n => n.data.title === 'a'), b = copies.find(n => n.data.title === 'b');
  assert.equal(g.parentId, 'outer'); assert.equal(a.parentId, g.id); assert.equal(b.parentId, g.id);
  assert.deepEqual(g.position, { x: 86, y: 96 }); assert.deepEqual(a.position, p.nodes.find(n => n.id === 'a').position);
  assert.deepEqual(at(result, a.id), { x: at(p, 'a').x + 36, y: at(p, 'a').y + 36 });
  assert.equal(a.data.lastOutput, undefined); assert.equal(b.data.lastOutput, undefined);
  assert.equal(result.edges.filter(e => e.source === a.id && e.target === b.id).length, 1);
  assert.equal(result.edges.filter(e => e.source === b.id && e.target === 'c').length, 0);
  assert.ok(result.nodes.indexOf(g) < result.nodes.indexOf(a));
  assert.equal(result.nodes.find(n => n.id === 'inner').selected, false); assert.doesNotThrow(() => validateClient(result));
  a.data.title = 'changed'; assert.equal(p.nodes.find(n => n.id === 'a').data.title, 'a');
});

test('duplicate a complete nested group keeps all relative child coordinates and unique repeated IDs', () => {
  const p = selected(nested(), ['outer']), once = duplicateSelection(p, { x: -25, y: 12 }), twice = duplicateSelection(once);
  const copies = once.nodes.filter(n => n.selected), g = copies.find(n => n.data.title === 'outer'), inner = copies.find(n => n.data.title === 'inner');
  assert.equal(copies.length, 4); assert.deepEqual(g.position, { x: 75, y: 212 }); assert.equal(inner.parentId, g.id); assert.deepEqual(inner.position, { x: 50, y: 60 });
  assert.equal(new Set(twice.nodes.map(n => n.id)).size, twice.nodes.length);
  assert.equal(new Set(twice.edges.map(e => e.id)).size, twice.edges.length);
  assert.doesNotThrow(() => validateClient(twice));
  assert.throws(() => duplicateSelection(p, { x: Infinity, y: 0 }));
});

test('duplicate a nested leaf keeps its existing parent and shifts its world position', () => {
  const p = selected(nested(), ['a']), result = duplicateSelection(p), a = result.nodes.find(n => n.selected);
  assert.equal(a.parentId, 'inner'); assert.deepEqual(at(result, a.id), { x: 206, y: 326 });
  assert.equal(result.edges.length, p.edges.length);
});

test('removeSelection recursively deletes nested descendants and invalidates surviving downstream nodes', () => {
  const p = freeze(selected(nested(), ['inner'])), result = removeSelection(p);
  assert.deepEqual(result.nodes.map(n => n.id), ['outer', 'c', 'd', 'unrelated']);
  assert.deepEqual(result.edges.map(e => e.id), ['c-d']);
  for (const id of ['c', 'd']) assert.equal(result.nodes.find(n => n.id === id).data.lastOutput, undefined);
  assert.ok(result.nodes.find(n => n.id === 'unrelated').data.lastOutput);
  assert.equal(p.nodes.length, 7); assert.doesNotThrow(() => validateClient(result));
});

test('remove selected edge invalidates its target and downstream but leaves source/group intact', () => {
  const p = nested(); p.edges[0].selected = true;
  const result = removeSelection(freeze(p));
  assert.equal(result.nodes.length, p.nodes.length); assert.equal(result.edges.length, 2);
  assert.ok(result.nodes.find(n => n.id === 'a').data.lastOutput);
  for (const id of ['b', 'c', 'd']) assert.equal(result.nodes.find(n => n.id === id).data.lastOutput, undefined);
});

test('layout root rectangles never overlap and nested relative coordinates are unchanged', () => {
  const p = nested(); p.nodes.find(n => n.id === 'a').position = { x: -70, y: -90 };
  const result = layoutProject(freeze(p));
  for (const n of p.nodes.filter(n => n.parentId)) assert.deepEqual(result.nodes.find(item => item.id === n.id).position, n.position);
  const roots = result.nodes.filter(n => !n.parentId);
  for (const [i, a] of roots.entries()) for (const b of roots.slice(i + 1)) {
    assert.ok(a.position.x + a.width <= b.position.x || b.position.x + b.width <= a.position.x || a.position.y + a.height <= b.position.y || b.position.y + b.height <= a.position.y);
  }
  assert.ok(roots.every(n => Number.isFinite(n.position.x) && Number.isFinite(n.position.y)));
  assert.deepEqual(result.edges, p.edges); assert.doesNotThrow(() => validateClient(result));
});

test('layout is bounded when collapsing a valid leaf DAG creates a container-level cycle', () => {
  const p = project([group('ga', 0, 0), group('gb', 0, 0), node('a1', 0, 0, { parentId: 'ga' }), node('a2', 0, 100, { parentId: 'ga' }), node('b1', 0, 0, { parentId: 'gb' }), node('b2', 0, 100, { parentId: 'gb' })], [edge('a1', 'b1'), edge('b2', 'a2')]);
  const result = layoutProject(p);
  assert.ok(result.nodes.every(n => Math.abs(n.position.x) < 10000 && Math.abs(n.position.y) < 10000));
  assert.notDeepEqual(result.nodes[0].position, result.nodes[1].position); assert.doesNotThrow(() => validateClient(result));
});

test('execution selected leaf includes exactly selected and all required upstream, not downstream', () => {
  const p = freeze(nested()), run = executionProject(p, ['c']);
  assert.deepEqual(run.nodes.map(n => n.id), ['a', 'b', 'c']); assert.deepEqual(run.edges.map(e => e.id), ['a-b', 'b-c']);
  for (const n of run.nodes) { assert.equal(n.parentId, undefined); assert.equal(n.extent, undefined); assert.deepEqual(n.position, at(p, n.id)); }
  assert.equal(run.workspace.canvases[0].nodes.length, p.nodes.length);
  assert.equal(run.workspace.canvases[0].nodes.find(n => n.id === 'a').parentId, 'inner');
  run.workspace.canvases[0].nodes.find(n => n.id === 'a').data.title = 'changed';
  assert.equal(p.nodes.find(n => n.id === 'a').data.title, 'a');
});

test('execution selected group expands nested leaves, pulls external upstream and excludes siblings/downstream', () => {
  const p = nested(); p.edges.push(edge('unrelated', 'a'));
  const run = executionProject(p, ['inner']);
  assert.deepEqual(run.nodes.map(n => n.id), ['a', 'b', 'unrelated']);
  assert.deepEqual(run.edges.map(e => e.id), ['a-b', 'unrelated-a']);
  assert.ok(run.nodes.every(n => n.data.kind !== 'group'));
  assert.deepEqual(executionProject(p, []).nodes, []); assert.deepEqual(executionProject(p, ['missing']).nodes, []);
});

test('full execution omits every group, preserves world positions and all independent leaves', () => {
  const p = nested(), run = executionProject(p);
  assert.deepEqual(run.nodes.map(n => n.id), ['a', 'b', 'c', 'd', 'unrelated']);
  assert.deepEqual(run.edges, p.edges);
  for (const n of run.nodes) assert.deepEqual(n.position, at(p, n.id));
  assert.equal(run.workspace.canvases[0].nodes.length, 7);
});

test('execution upstream closure follows both branches of a diamond and never follows successors', () => {
  const p = project(['a', 'b', 'c', 'd', 'e', 'unrelated'].map(id => node(id)), [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd'), edge('d', 'e')]);
  const run = executionProject(freeze(p), new Set(['d']));
  assert.deepEqual(run.nodes.map(n => n.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(run.edges.map(e => e.id), ['a-b', 'a-c', 'b-d', 'c-d']);
});

test('duplicate strips transient RF measurements and drag state from new nodes', () => {
  const p = project([node('a', 5, 10, { selected: true, dragging: true, measured: { width: 444 }, internals: { absolutePosition: { x: 100, y: 200 } } })]);
  const result = duplicateSelection(freeze(p)), duplicate = result.nodes.find(n => n.selected);
  for (const field of ['dragging', 'measured', 'internals']) assert.equal(Object.hasOwn(duplicate, field), false);
  assert.equal(result.nodes[0].dragging, true);
  assert.deepEqual(duplicate.position, { x: 41, y: 46 });
});

test('empty graph helpers remain valid, independent and safe for undo snapshots', () => {
  const p = freeze(createProject());
  for (const operation of [q => groupSelection(q), q => ungroupSelection(q), q => duplicateSelection(q), q => removeSelection(q), q => layoutProject(q), q => invalidate(q, [])]) {
    const result = operation(p);
    assert.deepEqual(result, p); assert.notEqual(result, p); assert.notEqual(result.workspace, p.workspace);
    assert.doesNotThrow(() => validateClient(result));
  }
  assert.deepEqual(executionProject(p).nodes, []);
});

test('every operation preserves full inactive workspace and clean JSON values', () => {
  let p = addCanvas(project([node('inactive')]), 'active');
  p = { ...p, nodes: [node('a', 20, 50, { selected: true }), node('b', 300, 50)], edges: [] };
  const inactive = copy(p.workspace.canvases[0]);
  for (const operation of [q => invalidate(q, ['a']), q => addConnection(q, { source: 'a', target: 'b' }), q => duplicateSelection(q), q => groupSelection(q), q => ungroupSelection(q), q => removeSelection(q), q => layoutProject(q), q => executionProject(q, ['a'])]) {
    const result = operation(freeze(copy(p)));
    assert.deepEqual(result.workspace.canvases[0], inactive);
    assert.deepEqual(result, copy(result));
    if (result.nodes.length) { result.nodes[0].data.title = 'changed'; assert.equal(p.nodes[0].data.title, 'a'); }
  }
});
