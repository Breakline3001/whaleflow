// WhaleFlow 项目操作核心。CLI、MCP server 与将来的本地服务共用这一份，
// 避免三处各写一套把规则写歪。所有函数都是纯操作，不做 I/O 以外的副作用。
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateProject, writeProject} from '../lib/project.mjs';
import {createCreativeDocument, validateCreativeDocument} from '../lib/creative-schema.mjs';

export const NODE_KINDS = ['text', 'image', 'video', 'audio', 'script', 'shots', 'director', 'clip', 'prompt', 'note', 'output', 'asset'];
export const DURATIONS = [4, 8, 12];

export const blankProject = name => ({
  version: 3,
  name,
  nodes: [],
  edges: [],
  viewport: {x: 0, y: 0, zoom: 1},
  workspace: {canvases: [{id: 'canvas-1', name: '画布 1', nodes: [], edges: [], viewport: {x: 0, y: 0, zoom: 1}}], activeCanvasId: 'canvas-1'},
});

export async function loadProject(file) {
  if (!existsSync(file)) throw Error(`找不到项目文件：${file}`);
  const project = JSON.parse(await readFile(file, 'utf8'));
  validateProject(project);
  return project;
}

export async function saveProject(file, project) {
  validateProject(project);
  await writeProject(file, project);
  return file;
}

export async function initProject(file, name = '未命名工作区') {
  if (existsSync(file)) throw Error(`文件已存在，拒绝覆盖：${file}`);
  const project = blankProject(name);
  await saveProject(file, project);
  return {file, name, version: project.version, nodes: 0};
}

function nextId(nodes, prefix) {
  let index = 1;
  const used = new Set(nodes.map(node => node.id));
  while (used.has(`${prefix}-${index}`)) index++;
  return `${prefix}-${index}`;
}

export function addNode(project, kind, data = {}, position) {
  if (!NODE_KINDS.includes(kind)) throw Error(`不支持的节点类型：${kind}（可用：${NODE_KINDS.join(', ')}）`);
  const id = nextId(project.nodes, kind);
  const wide = kind === 'image' || kind === 'video';
  const node = {
    id,
    type: 'workflow',
    position: position || {x: 80 + (project.nodes.length % 4) * 420, y: 100 + Math.floor(project.nodes.length / 4) * 420},
    width: wide ? 622 : 350,
    height: 350,
    data: {kind, title: data.title || kind, content: data.content || '', ...data},
  };
  project.nodes.push(node);
  return node;
}

export function studioNode(project, nodeId) {
  if (nodeId) {
    const found = project.nodes.find(node => node.id === nodeId);
    if (!found) throw Error(`没有节点：${nodeId}`);
    return found;
  }
  const found = project.nodes.find(node => node.data.creative);
  if (!found) throw Error('项目里没有带创作文档的节点，先用 wf_script 建一个');
  return found;
}

export function writeScript(project, {nodeId, title, script, synopsis, style, aspectRatio} = {}) {
  let node = nodeId ? project.nodes.find(item => item.id === nodeId) : null;
  if (nodeId && !node) throw Error(`没有节点：${nodeId}`);
  if (!node) node = addNode(project, 'script', {title: title || '脚本生成器'});
  const doc = createCreativeDocument({
    title: String(title || node.data.title || '剧本'),
    script: String(script || ''),
    synopsis: String(synopsis || ''),
    style: String(style || ''),
    ...(aspectRatio ? {aspectRatio: String(aspectRatio)} : {}),
  });
  node.data.creative = doc;
  project.version = 3;
  return {nodeId: node.id, revision: doc.revision};
}

export function addShot(project, {nodeId, title, prompt, description, duration, shotSize, camera, dialogue, sound} = {}) {
  const node = studioNode(project, nodeId);
  const doc = node.data.creative;
  if (!doc) throw Error('该节点没有分镜文档');
  const shot = {
    id: `shot-${doc.shots.length + 1}-${randomUUID().slice(0, 8)}`,
    title: String(title || `镜头 ${doc.shots.length + 1}`),
    description: String(description || ''),
    duration: DURATIONS.includes(Number(duration)) ? Number(duration) : 4,
    shotSize: String(shotSize || '中景'),
    camera: String(camera || '固定'),
    dialogue: String(dialogue || ''),
    sound: String(sound || ''),
    prompt: String(prompt || ''),
  };
  doc.shots.push(shot);
  doc.revision += 1;
  const check = validateCreativeDocument(doc);
  if (!check.valid) throw Error(check.errors.join('; '));
  return {nodeId: node.id, shot, revision: doc.revision, count: doc.shots.length};
}

export function compileShots(project, {nodeId, shots, mode = 'image'} = {}) {
  const node = studioNode(project, nodeId);
  const doc = node.data.creative;
  if (!doc) throw Error('该节点没有分镜文档');
  if (!['image', 'video'].includes(mode)) throw Error('mode 只能是 image 或 video');
  const picked = Array.isArray(shots) ? shots : String(shots || '').split(',').map(value => Number(String(value).trim())).filter(value => Number.isInteger(value) && value > 0);
  const chosen = picked.length ? doc.shots.filter((shot, index) => picked.includes(index + 1)) : doc.shots;
  if (!chosen.length) throw Error('没有选中任何镜头');
  const created = [];
  for (const shot of chosen) {
    const task = addNode(project, mode, {
      title: `${shot.title} · ${mode === 'image' ? '分镜图' : '首帧视频'}`,
      content: shot.prompt || shot.description,
      studioNodeId: node.id,
      studioShotId: shot.id,
      studioRevision: doc.revision,
      ...(mode === 'image'
        ? {imageSize: '1024x1024', imageAspectRatio: '1:1', batchSize: 1}
        : {videoSeconds: 4, videoSize: '1280x720'}),
    });
    created.push({id: task.id, shot: shot.title, kind: mode});
  }
  return {created, note: '任务节点已写入项目，在桌面程序里打开该项目即可执行生成'};
}

export function describe(project) {
  const kinds = {};
  for (const node of project.nodes) kinds[node.data.kind] = (kinds[node.data.kind] || 0) + 1;
  const studio = project.nodes.find(node => node.data.creative);
  return {
    name: project.name,
    version: project.version,
    nodes: project.nodes.length,
    kinds,
    storyboard: studio ? {nodeId: studio.id, revision: studio.data.creative.revision, shots: studio.data.creative.shots.length} : null,
  };
}

export function listNodes(project, kind) {
  return project.nodes
    .filter(node => !kind || node.data.kind === kind)
    .map(node => ({
      id: node.id,
      kind: node.data.kind,
      title: node.data.title,
      x: Math.round(node.position.x),
      y: Math.round(node.position.y),
      hasOutput: Boolean(node.data.lastOutput),
      shots: node.data.creative?.shots?.length,
    }));
}

export function listShots(project, nodeId) {
  const node = studioNode(project, nodeId);
  const doc = node.data.creative;
  return {
    nodeId: node.id,
    revision: doc?.revision,
    shots: (doc?.shots || []).map((shot, index) => ({
      index: index + 1, id: shot.id, title: shot.title, duration: shot.duration, prompt: shot.prompt,
    })),
  };
}

export function checkProject(project) {
  const warnings = [];
  const studio = project.nodes.find(node => node.data.creative);
  if (studio) {
    const doc = studio.data.creative;
    if (!doc.shots.length) warnings.push('分镜文档里没有镜头');
    const blank = doc.shots.filter(shot => !shot.prompt && !shot.description);
    if (blank.length) warnings.push(`${blank.length} 个镜头既没有提示词也没有描述`);
    const long = doc.shots.filter(shot => !DURATIONS.includes(shot.duration));
    if (long.length) warnings.push(`${long.length} 个镜头时长不是 4/8/12，生成时会被夹到 4`);
  }
  return {valid: true, warnings, nodes: project.nodes.length, version: project.version};
}

export async function exportProject(file, out) {
  const project = await loadProject(file);
  const payload = {...project, exportedAt: new Date().toISOString(), generatedBy: 'wf-cli'};
  validateProject(payload);
  const target = path.resolve(out);
  await mkdir(path.dirname(target), {recursive: true});
  await writeFile(target, JSON.stringify(payload, null, 2));
  return {out: target, bytes: Buffer.byteLength(JSON.stringify(payload))};
}
