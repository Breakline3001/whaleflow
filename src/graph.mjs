/** Immutable, JSON-only canvas operations. No browser or framework dependencies. */
import {assertJsonData, assertProjectSize, assertString, validateNodeData} from './schema.mjs';
import {remapCreativeReferences} from './reference-remap.mjs';
export const NODE_KINDS = Object.freeze(['prompt', 'text', 'image', 'video', 'note', 'output', 'audio', 'group', 'script', 'clip', 'director', 'shots', 'asset']);
const kinds = new Set(NODE_KINDS);
const defaultViewport = () => ({ x: 0, y: 0, zoom: 1 });
const clone = value => JSON.parse(JSON.stringify(value));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isFinite(value) && value > 0;
const fail = message => { throw new Error(message); };

// Local deterministic identifiers avoid crypto, clocks, and environment dependencies.
function freshId(items, prefix) {
  const ids = new Set(items.map(item => item.id));
  let index = 1;
  while (ids.has(`${prefix}-${index}`)) index++;
  return `${prefix}-${index}`;
}
function stableViewport(viewport = defaultViewport()) {
  return { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
}
function stableNode(node) {
  const result = { id: node.id, type: 'workflow', position: { x: node.position.x, y: node.position.y }, data: clone(node.data) };
  for (const key of ['width', 'height', 'parentId', 'extent']) {
    if (node[key] !== undefined) result[key] = clone(node[key]);
  }
  return result;
}
function stableEdge(edge) {
  const result = { id: edge.id, source: edge.source, target: edge.target };
  for (const key of ['sourceHandle', 'targetHandle']) {
    if (edge[key] !== undefined) result[key] = clone(edge[key]);
  }
  return result;
}
function snapshot(graph, id, name) {
  return { id, name, nodes: graph.nodes.map(stableNode), edges: graph.edges.map(stableEdge), viewport: stableViewport(graph.viewport ?? defaultViewport()) };
}

/** Persist only the public schema; the top-level graph is authoritative for its active canvas. */
export function cleanProject(project) {
  // Validate before JSON cloning/field pruning, which would otherwise hide secrets,
  // Infinity, functions and malformed inactive canvases from the persistence guard.
  validateInput(project);
  const result = {
    version: project.version, name: project.name,
    nodes: project.nodes.map(stableNode), edges: project.edges.map(stableEdge),
    viewport: stableViewport(project.viewport ?? defaultViewport()),
  };
  const saved = project.workspace;
  let canvases = Array.isArray(saved?.canvases) ? saved.canvases.map(canvas => snapshot(canvas, canvas.id, canvas.name)) : [];
  if (!canvases.length) canvases = [snapshot(result, 'canvas-1', '画布 1')];
  const activeCanvasId = canvases.some(canvas => canvas.id === saved?.activeCanvasId) ? saved.activeCanvasId : canvases[0].id;
  canvases = canvases.map(canvas => canvas.id === activeCanvasId ? snapshot(result, canvas.id, canvas.name) : canvas);
  result.workspace = { canvases, activeCanvasId };
  // Synchronizing the active snapshot duplicates the root graph. Apply the total
  // byte/depth limits to that final document too, not just the legacy input.
  assertJsonData(result);
  assertProjectSize(result);
  return clone(result);
}

export function createProject() {
  return cleanProject({ version: 1, name: '未命名工作区', nodes: [], edges: [], viewport: defaultViewport() });
}

/** An explicitly offline version of the original five-node example. */
export function demoProject() {
  const project = createProject();
  project.name = '月光来信 · 离线 Demo';
  project.nodes = [
    { id: 'idea', position: { x: 40, y: 100 }, data: { kind: 'prompt', title: '一个小小的灵感', content: '【离线 Demo，不访问网络】\n一只鲸鱼游过夜空，把星星的光带回海洋。\n\n风格：梦幻、安静、电影感。\n将这个想法变成一段视觉创作提示词。' } },
    { id: 'writer', position: { x: 420, y: 100 }, data: { kind: 'text', title: '把灵感变成画面', content: '【离线 Demo，不访问网络】\n你是一位视觉创意导演。结合上游创意，写出一段细致的画面描述，包含主体、光线、色彩与构图。只输出提示词。', provider: 'demo' } },
    { id: 'visual', position: { x: 810, y: 100 }, data: { kind: 'image', title: '月光下的海', content: '【离线 Demo，不访问网络】\n深蓝色与薄荷绿，柔和的光线，极简电影海报。', provider: 'demo' } },
    { id: 'result', position: { x: 1210, y: 100 }, data: { kind: 'output', title: '收集创作结果', content: '离线 Demo 结果预览，不访问网络。' } },
    { id: 'memo', position: { x: 40, y: 490 }, data: { kind: 'note', title: '留一点空间给想象', content: '这是离线 Demo，不实际联网，不生成真实 AI 内容。\n\n拖动端口连接节点；空格 + 拖动平移，滚轮平移，Ctrl + 滚轮缩放，Shift 框选。' } },
  ].map(node => ({ ...node, type: 'workflow' }));
  project.edges = [{ id: 'e1', source: 'idea', target: 'writer' }, { id: 'e2', source: 'writer', target: 'visual' }, { id: 'e3', source: 'visual', target: 'result' }];
  project.viewport.zoom = 0.8;
  return cleanProject(project);
}

function validateViewport(viewport) {
  if (viewport === undefined) return;
  if (!isObject(viewport) || !Number.isFinite(viewport.x) || !Number.isFinite(viewport.y) || !positive(viewport.zoom) || viewport.zoom > 10) fail('画布视口无效，zoom 必须在 (0, 10]。');
}
function validateGraph(graph, version = 1) {
  if (!Array.isArray(graph.nodes) || graph.nodes.length > 2000) fail('nodes 必须是数组且最多包含 2000 个节点。');
  if (!Array.isArray(graph.edges) || graph.edges.length > 10000) fail('edges 必须是数组且最多包含 10000 条连线。');
  validateViewport(graph.viewport);
  const nodes = new Map();
  for (const node of graph.nodes) {
    if (!isObject(node)) fail('节点必须是对象。');
    assertString(node.id, '节点 ID', 200);
    if (!node.id.trim() || nodes.has(node.id)) fail('节点 ID 无效或重复。');
    if (node.type !== undefined && node.type !== 'workflow') fail('节点 type 必须为 workflow。');
    if (!isObject(node.data) || !kinds.has(node.data.kind)) fail('节点 kind 无效。');
    validateNodeData(node.data, version);
    if (!isObject(node.position) || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) fail('节点坐标必须为有限数值。');
    for (const key of ['width', 'height']) if (node[key] !== undefined && (!positive(node[key]) || node[key] > 100000)) fail('节点尺寸必须在 (0, 100000]。');
    if (node.parentId !== undefined) {
      assertString(node.parentId, '父组 ID', 200);
      if (!node.parentId.trim()) fail('节点父组 ID 无效。');
    }
    if (node.extent !== undefined && (node.extent !== 'parent' || !node.parentId)) fail('extent 只支持带 parentId 的 parent。');
    nodes.set(node.id, node);
  }
  for (const node of graph.nodes) {
    if (node.parentId !== undefined && nodes.get(node.parentId)?.data.kind !== 'group') fail('父节点必须是存在的 group。');
    absolutePosition(graph.nodes, node);
  }
  const edgeIds = new Set(), pairs = new Set();
  const indegree = new Map(graph.nodes.map(node => [node.id, 0]));
  const outgoing = new Map(graph.nodes.map(node => [node.id, []]));
  for (const edge of graph.edges) {
    if (!isObject(edge)) fail('连线必须是对象。');
    assertString(edge.id, '连线 ID', 200);
    assertString(edge.source, '连线起点', 200);
    assertString(edge.target, '连线终点', 200);
    if (!edge.id.trim() || edgeIds.has(edge.id)) fail('连线 ID 无效或重复。');
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) fail('连线包含未知节点。');
    if (edge.source === edge.target || nodes.get(edge.source).data.kind === 'group' || nodes.get(edge.target).data.kind === 'group') fail('连线不能自环或连接结构分组。');
    const pair = JSON.stringify([edge.source, edge.target]);
    if (pairs.has(pair)) fail('项目包含重复连线。');
    for (const key of ['sourceHandle', 'targetHandle']) if (edge[key] !== undefined && edge[key] !== null && typeof edge[key] !== 'string') fail('连线端口无效。');
    edgeIds.add(edge.id); pairs.add(pair);
    outgoing.get(edge.source).push(edge.target);
    indegree.set(edge.target, indegree.get(edge.target) + 1);
  }
  const queue = graph.nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    for (const target of outgoing.get(queue[cursor])) {
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) queue.push(target);
    }
  }
  if (queue.length !== graph.nodes.length) fail('工作流必须是 DAG，不能包含循环。');
}

function validateInput(project) {
  assertJsonData(project);
  if (!isObject(project) || ![1, 2, 3].includes(project.version)) fail('这不是支持的 WhaleFlow 项目。');
  assertString(project.name, '项目名称', 200);
  validateGraph(project, project.version);
  if (project.workspace !== undefined) {
    const workspace = project.workspace;
    if (!isObject(workspace) || !Array.isArray(workspace.canvases) || !workspace.canvases.length || workspace.canvases.length > 32) fail('工作区必须包含 1 到 32 张画布。');
    const ids = new Set();
    for (const canvas of workspace.canvases) {
      if (!isObject(canvas)) fail('画布必须是对象。');
      assertString(canvas.id, '画布 ID', 200);
      assertString(canvas.name, '画布名称', 200);
      if (!canvas.id.trim() || ids.has(canvas.id)) fail('工作区画布 ID 无效或重复。');
      ids.add(canvas.id); validateGraph(canvas, project.version);
    }
    if (typeof workspace.activeCanvasId !== 'string' || !ids.has(workspace.activeCanvasId)) fail('工作区活动画布不存在。');
  }
  assertProjectSize(project);
}

/** Validate before JSON normalization so NaN/Infinity cannot silently become null. */
export function validateClient(project) {
  return cleanProject(project);
}

// Runtime selection remains on the editable graph, never on persisted canvas snapshots.
function copyProject(project) {
  const result = clone(project);
  result.workspace = cleanProject(project).workspace;
  return result;
}
function finish(project) {
  project.workspace = cleanProject(project).workspace;
  return clone(project);
}
function activate(project, id) {
  const canvas = project.workspace.canvases.find(item => item.id === id);
  if (!canvas) return project;
  project.workspace.activeCanvasId = id;
  project.nodes = clone(canvas.nodes); project.edges = clone(canvas.edges); project.viewport = clone(canvas.viewport);
  return project;
}
export function switchCanvas(project, id) {
  return finish(activate(copyProject(project), id));
}
export function addCanvas(project, name) {
  const result = copyProject(project), canvases = result.workspace.canvases;
  const id = freshId(canvases, 'canvas');
  canvases.push(snapshot({ nodes: [], edges: [], viewport: defaultViewport() }, id, typeof name === 'string' ? name : `画布 ${canvases.length + 1}`));
  return finish(activate(result, id));
}
export function deleteCanvas(project, id) {
  const result = copyProject(project), canvases = result.workspace.canvases;
  const index = canvases.findIndex(canvas => canvas.id === id);
  if (index < 0 || canvases.length === 1) return finish(result);
  canvases.splice(index, 1);
  if (result.workspace.activeCanvasId === id) activate(result, canvases[Math.min(index, canvases.length - 1)].id);
  return finish(result);
}
export function renameCanvas(project, id, name) {
  const result = copyProject(project);
  const canvas = result.workspace.canvases.find(item => item.id === id);
  if (canvas && typeof name === 'string') canvas.name = name;
  return finish(result);
}

/** Inclusive downstream closure, matching the original application's invalidation semantics. */
export function descendants(project, startIds) {
  const result = new Set(startIds ?? []), outgoing = new Map();
  for (const edge of project.edges) {
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
    outgoing.get(edge.source).push(edge.target);
  }
  const queue = [...result];
  for (let cursor = 0; cursor < queue.length; cursor++) for (const target of outgoing.get(queue[cursor]) ?? []) {
    if (!result.has(target)) { result.add(target); queue.push(target); }
  }
  return result;
}
function clearOutputs(project, ids) {
  for (const node of project.nodes) if (ids.has(node.id)) delete node.data.lastOutput;
  return project;
}
export function invalidate(project, ids) {
  return finish(clearOutputs(copyProject(project), new Set(ids ?? [])));
}
export function canConnect(project, connection) {
  if (!connection || connection.source === connection.target) return false;
  const { source, target } = connection;
  const sourceNode = project.nodes.find(node => node.id === source), targetNode = project.nodes.find(node => node.id === target);
  if (!sourceNode || !targetNode || sourceNode.data.kind === 'group' || targetNode.data.kind === 'group') return false;
  if (project.edges.some(edge => edge.source === source && edge.target === target)) return false;
  return !descendants(project, [target]).has(source);
}
export function addConnection(project, connection) {
  const result = copyProject(project);
  if (!canConnect(project, connection)) return finish(result);
  const edge = { id: typeof connection.id === 'string' && connection.id && !result.edges.some(item => item.id === connection.id) ? connection.id : freshId(result.edges, 'edge'), source: connection.source, target: connection.target };
  for (const key of ['sourceHandle', 'targetHandle']) if (connection[key] !== undefined) edge[key] = clone(connection[key]);
  result.edges.push(edge);
  return finish(clearOutputs(result, descendants(result, [connection.target])));
}
function treeClosure(nodes, starts) {
  const result = new Set(starts), children = new Map();
  for (const node of nodes) if (node.parentId) {
    if (!children.has(node.parentId)) children.set(node.parentId, []);
    children.get(node.parentId).push(node.id);
  }
  const queue = [...result];
  for (let cursor = 0; cursor < queue.length; cursor++) for (const id of children.get(queue[cursor]) ?? []) {
    if (!result.has(id)) { result.add(id); queue.push(id); }
  }
  return result;
}
export function removeSelection(project) {
  const result = copyProject(project);
  const removed = treeClosure(result.nodes, result.nodes.filter(node => node.selected).map(node => node.id));
  const targets = result.edges.filter(edge => edge.selected || removed.has(edge.source) || removed.has(edge.target)).map(edge => edge.target);
  clearOutputs(result, descendants(result, targets));
  result.nodes = result.nodes.filter(node => !removed.has(node.id));
  result.edges = result.edges.filter(edge => !edge.selected && !removed.has(edge.source) && !removed.has(edge.target));
  return finish(result);
}

/** Resolve relative parent coordinates without recursion or dependence on array order. */
export function absolutePosition(nodes, nodeOrId) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  let node = typeof nodeOrId === 'string' ? byId.get(nodeOrId) : nodeOrId;
  if (!node) fail('找不到节点。');
  const seen = new Set();
  let x = 0, y = 0;
  while (node) {
    if (seen.has(node.id)) fail('分组父关系不能循环。');
    seen.add(node.id);
    if (!Number.isFinite(node.position?.x) || !Number.isFinite(node.position?.y)) fail('节点坐标必须为有限数值。');
    x += node.position.x; y += node.position.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) fail('节点世界坐标超出有限范围。');
    if (!node.parentId) break;
    node = byId.get(node.parentId);
    if (!node) fail('找不到父分组。');
  }
  return { x, y };
}
function selectedRoots(nodes) {
  const selected = new Set(nodes.filter(node => node.selected).map(node => node.id)), byId = new Map(nodes.map(node => [node.id, node]));
  return nodes.filter(node => {
    if (!selected.has(node.id)) return false;
    for (let parent = node.parentId; parent; parent = byId.get(parent)?.parentId) if (selected.has(parent)) return false;
    return true;
  });
}
function parentFirst(nodes) {
  const byId = new Map(nodes.map(node => [node.id, node])), ordered = [], emitted = new Set();
  for (const node of nodes) {
    const pending = [], seen = new Set();
    let current = node;
    while (current && !emitted.has(current.id)) {
      if (seen.has(current.id)) fail('分组父关系不能循环。');
      seen.add(current.id); pending.push(current); current = byId.get(current.parentId);
    }
    while (pending.length) { const item = pending.pop(); emitted.add(item.id); ordered.push(item); }
  }
  return ordered;
}
export function duplicateSelection(project, offset = { x: 36, y: 36 }) {
  if (!Number.isFinite(offset?.x) || !Number.isFinite(offset?.y)) fail('复制偏移必须为有限坐标。');
  const result = copyProject(project), roots = selectedRoots(result.nodes);
  const included = treeClosure(result.nodes, roots.map(node => node.id)), rootIds = new Set(roots.map(node => node.id)), ids = new Map();
  const copies = [];
  for (const node of parentFirst(result.nodes.filter(item => included.has(item.id)))) {
    const copy = stableNode(node); copy.id = freshId([...result.nodes, ...copies], 'node'); ids.set(node.id, copy.id);
    delete copy.data.lastOutput; copy.selected = true;
    if (rootIds.has(node.id)) copy.position = { x: node.position.x + offset.x, y: node.position.y + offset.y };
    copies.push(copy);
  }
  for (const copy of copies) {if (ids.has(copy.parentId)) copy.parentId = ids.get(copy.parentId);copy.data=remapCreativeReferences(copy.data,ids);}
  const edges = result.edges.filter(edge => included.has(edge.source) && included.has(edge.target)).map(edge => {
    const copy = stableEdge(edge); copy.source = ids.get(edge.source); copy.target = ids.get(edge.target); copy.selected = true;
    return copy;
  });
  for (const edge of edges) { edge.id = freshId(result.edges, 'edge'); result.edges.push(edge); }
  for (const node of result.nodes) node.selected = false;
  for (const edge of result.edges) if (!edges.includes(edge)) edge.selected = false;
  result.nodes = parentFirst([...result.nodes, ...copies]);
  return finish(result);
}
function size(node) {
  return { width: positive(node.width) ? node.width : 300, height: positive(node.height) ? node.height : 220 };
}
function commonParent(nodes, roots) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const chains = roots.map(node => {
    const chain = [];
    for (let id = node.parentId; id; id = byId.get(id)?.parentId) chain.push(id);
    return chain;
  });
  return chains[0]?.find(id => chains.every(chain => chain.includes(id)));
}
export function groupSelection(project, title = '分组') {
  const result = copyProject(project), roots = selectedRoots(result.nodes);
  if (!roots.length) return finish(result);
  const parentId = commonParent(result.nodes, roots), parentPosition = parentId ? absolutePosition(result.nodes, parentId) : { x: 0, y: 0 };
  const members = treeClosure(result.nodes, roots.map(node => node.id));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of result.nodes.filter(item => members.has(item.id))) {
    const position = absolutePosition(result.nodes, node), dimensions = size(node);
    minX = Math.min(minX, position.x); minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x + dimensions.width); maxY = Math.max(maxY, position.y + dimensions.height);
  }
  const world = { x: minX - 32, y: minY - 32 };
  const group = { id: freshId(result.nodes, 'group'), type: 'workflow', position: { x: world.x - parentPosition.x, y: world.y - parentPosition.y }, width: maxX - minX + 64, height: maxY - minY + 64, selected: true, data: { kind: 'group', title: typeof title === 'string' ? title : '分组', content: '' } };
  if (!positive(group.width) || !positive(group.height) || !Number.isFinite(world.x) || !Number.isFinite(world.y)) fail('分组范围超出有限坐标。');
  if (parentId) { group.parentId = parentId; group.extent = 'parent'; }
  const positions = new Map(roots.map(node => [node.id, absolutePosition(result.nodes, node)]));
  for (const node of result.nodes) {
    node.selected = false;
    if (positions.has(node.id)) {
      const position = positions.get(node.id);
      node.parentId = group.id; node.extent = 'parent'; node.position = { x: position.x - world.x, y: position.y - world.y };
    }
  }
  for (const edge of result.edges) edge.selected = false;
  result.nodes = parentFirst([group, ...result.nodes]);
  return finish(result);
}
export function ungroupSelection(project) {
  const result = copyProject(project), byId = new Map(result.nodes.map(node => [node.id, node]));
  const removed = new Set(result.nodes.filter(node => node.selected && node.data.kind === 'group').map(node => node.id));
  const positions = new Map(result.nodes.map(node => [node.id, absolutePosition(result.nodes, node)]));
  for (const node of result.nodes) if (!removed.has(node.id) && removed.has(node.parentId)) {
    let parentId = node.parentId;
    while (removed.has(parentId)) parentId = byId.get(parentId)?.parentId;
    const parentPosition = parentId ? positions.get(parentId) : { x: 0, y: 0 }, world = positions.get(node.id);
    node.position = { x: world.x - parentPosition.x, y: world.y - parentPosition.y };
    if (parentId) node.parentId = parentId;
    else { delete node.parentId; if (node.extent === 'parent') delete node.extent; }
    node.selected = true;
  }
  result.nodes = parentFirst(result.nodes.filter(node => !removed.has(node.id)));
  result.edges = result.edges.filter(edge => !removed.has(edge.source) && !removed.has(edge.target));
  return finish(result);
}

/** Lay out only root containers. Internal coordinates and nested group structure stay untouched. */
export function layoutProject(project) {
  const result = copyProject(project), byId = new Map(result.nodes.map(node => [node.id, node]));
  const roots = result.nodes.filter(node => !node.parentId), rootFor = new Map();
  for (const node of result.nodes) {
    let current = node;
    const seen = new Set();
    while (current.parentId && byId.has(current.parentId)) {
      if (seen.has(current.id)) fail('分组父关系不能循环。');
      seen.add(current.id); current = byId.get(current.parentId);
    }
    rootFor.set(node.id, current.id);
  }
  const incoming = new Map(roots.map(node => [node.id, 0])), outgoing = new Map(roots.map(node => [node.id, new Set()]));
  for (const edge of result.edges) {
    const source = rootFor.get(edge.source), target = rootFor.get(edge.target);
    if (source !== target && outgoing.has(source) && incoming.has(target) && !outgoing.get(source).has(target)) {
      outgoing.get(source).add(target); incoming.set(target, incoming.get(target) + 1);
    }
  }
  const queue = roots.filter(node => incoming.get(node.id) === 0).map(node => node.id), levels = new Map(roots.map(node => [node.id, 0]));
  for (let cursor = 0; cursor < queue.length; cursor++) for (const target of outgoing.get(queue[cursor])) {
    levels.set(target, Math.max(levels.get(target), levels.get(queue[cursor]) + 1));
    incoming.set(target, incoming.get(target) - 1);
    if (incoming.get(target) === 0) queue.push(target);
  }
  // Collapsing a valid leaf DAG into containers can introduce cycles; keep those roots in a bounded fallback column.
  for (const root of roots) if (incoming.get(root.id) > 0) levels.set(root.id, 0);
  const boxes = new Map();
  for (const root of roots) boxes.set(root.id, { minX: 0, minY: 0, maxX: size(root).width, maxY: size(root).height });
  for (const node of result.nodes) {
    const root = byId.get(rootFor.get(node.id)), world = absolutePosition(result.nodes, node), box = boxes.get(root.id), dimensions = size(node);
    const x = world.x - root.position.x, y = world.y - root.position.y;
    box.minX = Math.min(box.minX, x); box.minY = Math.min(box.minY, y);
    box.maxX = Math.max(box.maxX, x + dimensions.width); box.maxY = Math.max(box.maxY, y + dimensions.height);
  }
  const columns = new Map();
  for (const root of roots) { const level = levels.get(root.id); if (!columns.has(level)) columns.set(level, []); columns.get(level).push(root); }
  let x = 40;
  for (const [, column] of [...columns].sort(([a], [b]) => a - b)) {
    let y = 40, columnWidth = 0;
    for (const root of column) {
      const box = boxes.get(root.id), width = box.maxX - box.minX, height = box.maxY - box.minY;
      root.position = { x: x - box.minX, y: y - box.minY }; y += height + 80; columnWidth = Math.max(columnWidth, width);
    }
    x += columnWidth + 100;
  }
  return finish(result);
}

/** Build a leaf execution graph, while retaining the complete editor workspace as a snapshot. */
export function executionProject(project, selectedIds = null) {
  const result = cleanProject(project), byId = new Map(result.nodes.map(node => [node.id, node]));
  let included;
  if (selectedIds === null) included = new Set(result.nodes.filter(node => node.data.kind !== 'group').map(node => node.id));
  else {
    included = treeClosure(result.nodes, selectedIds);
    for (const id of [...included]) if (!byId.has(id) || byId.get(id).data.kind === 'group') included.delete(id);
    const incoming = new Map();
    for (const edge of result.edges) { if (!incoming.has(edge.target)) incoming.set(edge.target, []); incoming.get(edge.target).push(edge.source); }
    const queue = [...included];
    for (let cursor = 0; cursor < queue.length; cursor++) for (const source of incoming.get(queue[cursor]) ?? []) {
      if (byId.get(source)?.data.kind !== 'group' && byId.has(source) && !included.has(source)) { included.add(source); queue.push(source); }
    }
  }
  result.nodes = result.nodes.filter(node => included.has(node.id) && node.data.kind !== 'group' && !node.data.creative && !node.data.directorStage).map(node => {
    const copy = clone(node); copy.position = absolutePosition(project.nodes, node.id); delete copy.parentId; delete copy.extent; return copy;
  });
  const executableIds=new Set(result.nodes.map(node=>node.id));
  result.edges = result.edges.filter(edge => executableIds.has(edge.source) && executableIds.has(edge.target));
  // Do not re-clean: execution nodes intentionally differ from the active editor canvas.
  return clone(result);
}
