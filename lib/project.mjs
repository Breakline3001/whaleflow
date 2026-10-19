import { open, readFile, rename, unlink, mkdir, stat } from 'node:fs/promises';
import { dirname, basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateGenerationOptions } from './generation-options.mjs';
import { validateModelSelection } from './model-settings-schema.mjs';
import { validateCreativeDocument } from './creative-schema.mjs';
import { validateDirectorStage } from './director-stage.mjs';

export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
export const MAX_PROJECT_BYTES = 100 * 1024 * 1024;
export const NODE_KINDS = Object.freeze(['prompt', 'text', 'image', 'video', 'note', 'output', 'audio', 'group', 'script', 'clip', 'director', 'shots', 'asset']);
export const MAX_CANVASES = 32;
export const PROVIDERS = Object.freeze(['demo', 'ollama', 'openai']);
const SECRET_KEY = /(?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|authorization|password|secret|token)$/i;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const fail = (message) => { throw new Error(message); };
const string = (value, field, max = 1_000_000) => {
  if (typeof value !== 'string' || value.length > max) fail(`${field} 必须是长度不超过 ${max} 的字符串`);
};

// Only JSON data is accepted. Secrets and dangerous object keys never enter a project file.
function assertJson(value, depth = 0, seen = new Set()) {
  if (depth > 40) fail('项目嵌套层级过深');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') fail('项目只能包含 JSON 数据');
  if (seen.has(value)) fail('项目包含循环引用');
  seen.add(value);
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('项目对象必须是普通 JSON 对象');
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key) || /^(?:credentialRef|credentials|vault|encryptedCredentials|modelSettings)$/i.test(key)) fail('项目不允许保存凭据或模型服务配置；请使用本机设置');
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('项目包含不安全的对象字段');
    // Optional JS object fields may be undefined over IPC; JSON persistence omits them.
    if (child === undefined && !Array.isArray(value)) continue;
    assertJson(child, depth + 1, seen);
  }
  seen.delete(value);
}

export function validateMediaUrl(value, kind) {
  string(value, 'mediaUrl', MAX_MEDIA_BYTES * 2);
  const match = /^data:(image\/(?:png|jpeg|webp|gif|avif|bmp|svg\+xml)|video\/(?:mp4|webm|quicktime|ogg)|audio\/(?:mpeg|mp3|wav|x-wav|ogg|mp4|x-m4a|flac|x-flac))(;charset=utf-8)?(;base64)?,([\s\S]*)$/i.exec(value);
  if (!match || !match[1].toLowerCase().startsWith(`${kind}/`)) fail(`${kind} 媒体必须是自包含 data URL，不能使用本地路径或远程链接`);
  let bytes;
  if (match[3]) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(match[4]) || match[4].length % 4 !== 0) fail('媒体 base64 数据无效');
    bytes = Buffer.byteLength(match[4], 'base64');
  } else {
    try { bytes = Buffer.byteLength(decodeURIComponent(match[4])); } catch { fail('媒体 data URL 编码无效'); }
  }
  if (bytes > MAX_MEDIA_BYTES) fail('单个媒体超过 20 MiB，请压缩后重新导入');
  if (kind === 'audio') {
    if (!match[3]) fail('音频必须使用 base64 data URL');
    assertAudioSignature(Buffer.from(match[4], 'base64'), match[1].toLowerCase());
  }
  return value;
}

export function validateProject(project) {
  assertJson(project);
  if (!isObject(project) || ![1, 2, 3].includes(project.version)) fail('不支持的项目版本，必须是 version: 1、2 或 3');
  string(project.name, '项目名称', 200);
  validateGraph(project, project.version);
  if (project.workspace !== undefined) {
    const workspace = project.workspace;
    if (!isObject(workspace) || !Array.isArray(workspace.canvases) || workspace.canvases.length < 1 || workspace.canvases.length > MAX_CANVASES) fail('workspace.canvases 必须包含 1 到 32 个画布');
    const ids = new Set();
    for (const canvas of workspace.canvases) {
      if (!isObject(canvas)) fail('画布必须是对象');
      string(canvas.id, '画布 ID', 200); string(canvas.name, '画布名称', 200);
      if (!canvas.id.trim() || ids.has(canvas.id)) fail('画布 ID 为空或重复');
      ids.add(canvas.id);
      validateGraph(canvas, project.version);
    }
    if (typeof workspace.activeCanvasId !== 'string' || !ids.has(workspace.activeCanvasId)) fail('activeCanvasId 必须指向存在的画布');
  }
  if (Buffer.byteLength(JSON.stringify(project)) > MAX_PROJECT_BYTES) fail('项目超过 100 MiB 限制');
  return project;
}

function validateGraph(project, version = 1) {
  if (!Array.isArray(project.nodes) || project.nodes.length > 2000) fail('nodes 必须是数组且最多包含 2000 个节点');
  if (!Array.isArray(project.edges) || project.edges.length > 10000) fail('edges 必须是数组且最多包含 10000 条连线');
  const ids = new Set();
  for (const node of project.nodes) {
    if (!isObject(node)) fail('节点必须是对象');
    string(node.id, '节点 ID', 200);
    if (!node.id.trim() || ids.has(node.id)) fail(`节点 ID 为空或重复：${node.id}`);
    ids.add(node.id);
    if (node.type !== 'workflow') fail(`节点 ${node.id} 的 type 必须为 workflow`);
    if (!isObject(node.position) || !finite(node.position.x) || !finite(node.position.y)) fail(`节点 ${node.id} 坐标无效`);
    const data = node.data;
    if (!isObject(data) || !NODE_KINDS.includes(data.kind)) fail(`节点 ${node.id} kind 无效`);
    string(data.title, '节点标题', 500);
    string(data.content, '节点内容');
    if (data.model !== undefined) string(data.model, '节点模型', 200);
    if (data.provider !== undefined && !PROVIDERS.includes(data.provider)) fail('节点 provider 无效');
    if (data.modelRef !== undefined) {
      if (version < 2 && data.modelRef !== null) fail('模型引用需要 version: 2 项目，旧版不能静默执行新语义');
      validateModelSelection(data.modelRef);
    }
    if (data.creative !== undefined) {
      if (version !== 3 || !['script', 'shots'].includes(data.kind)) fail('创作文档需要 version: 3 的 script 或 shots 节点');
      const result = validateCreativeDocument(data.creative);
      if (!result.valid) fail(`creative 无效：${result.errors.join('；')}`);
    }
    if (data.directorStage !== undefined) {
      if (version !== 3 || data.kind !== 'director') fail('三维场景需要 version: 3 的 director 节点');
      const result = validateDirectorStage(data.directorStage);
      if (!result.valid) fail(`directorStage 无效：${result.errors.join('；')}`);
    }
    if (data.referenceImage !== undefined) {
      if (!['image', 'video'].includes(data.kind)) fail('referenceImage 只允许 image/video 节点');
      validateMediaUrl(data.referenceImage, 'image');
      if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(data.referenceImage)) fail('referenceImage 必须为 PNG/JPEG/WebP base64 素材');
    }
    validateGenerationOptions(data);
    for (const key of ['width', 'height']) if (node[key] !== undefined && (!finite(node[key]) || node[key] <= 0 || node[key] > 100000)) fail(`节点 ${key} 必须为 (0, 100000] 的有限尺寸`);
    if (node.parentId !== undefined) { string(node.parentId, 'parentId', 200); if (!node.parentId.trim()) fail('parentId 不能为空'); }
    if (node.extent !== undefined && (node.extent !== 'parent' || !node.parentId)) fail('extent 只支持带 parentId 的 parent');
    if (data.mediaUrl !== undefined && data.mediaUrl !== '') {
      if (!['image', 'video', 'audio', 'asset'].includes(data.kind)) fail('只有 image/video/audio/asset 节点可包含 mediaUrl');
      const kind = data.kind === 'asset' ? /^data:(image|video|audio)\//i.exec(data.mediaUrl)?.[1]?.toLowerCase() : data.kind;
      if (!kind) fail('asset 素材类型无效');
      validateMediaUrl(data.mediaUrl, kind);
    }
    if (data.lastOutput !== undefined) validateOutput(data.lastOutput);
  }
  const byId = new Map(project.nodes.map((n) => [n.id, n]));
  for (const node of project.nodes) {
    const ancestors = new Set([node.id]);
    let current = node;
    while (current.parentId !== undefined) {
      const parent = byId.get(current.parentId);
      if (!parent || parent.data.kind !== 'group') fail('parentId 必须指向本画布存在的 group');
      if (ancestors.has(parent.id)) fail('节点亲子关系存在循环');
      ancestors.add(parent.id); current = parent;
    }
  }
  const edgeIds = new Set();
  const pairs = new Set();
  const outgoing = new Map([...ids].map((id) => [id, []]));
  const incoming = new Map([...ids].map((id) => [id, 0]));
  for (const edge of project.edges) {
    if (!isObject(edge)) fail('连线必须是对象');
    string(edge.id, '连线 ID', 200);
    string(edge.source, '连线起点', 200);
    string(edge.target, '连线终点', 200);
    if (!edge.id.trim() || edgeIds.has(edge.id)) fail(`连线 ID 为空或重复：${edge.id}`);
    edgeIds.add(edge.id);
    const pair = JSON.stringify([edge.source, edge.target]);
    if (pairs.has(pair)) fail(`重复连线：${edge.source} → ${edge.target}`);
    pairs.add(pair);
    if (!ids.has(edge.source) || !ids.has(edge.target)) fail(`悬空连线：${edge.id}`);
    outgoing.get(edge.source).push(edge.target);
    incoming.set(edge.target, incoming.get(edge.target) + 1);
  }
  // Kahn's algorithm also detects self-loops. Keep author order for independent nodes.
  const queue = project.nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
  for (let i = 0; i < queue.length; i++) {
    for (const id of outgoing.get(queue[i])) {
      incoming.set(id, incoming.get(id) - 1);
      if (incoming.get(id) === 0) queue.push(id);
    }
  }
  if (queue.length !== project.nodes.length) fail('工作流存在循环，请先移除环路');
  const v = project.viewport;
  if (!isObject(v) || !finite(v.x) || !finite(v.y) || !finite(v.zoom) || v.zoom <= 0 || v.zoom > 10) fail('viewport 无效，zoom 必须在 (0, 10]');
  if (Buffer.byteLength(JSON.stringify(project)) > MAX_PROJECT_BYTES) fail('项目超过 100 MiB 限制');
  return project;
}

function validateOutput(output) {
  if (!isObject(output)) fail('lastOutput 必须是对象');
  for (const kind of ['image', 'video', 'audio']) if (output[kind] !== undefined) validateMediaUrl(output[kind], kind);
  if (output.images !== undefined) {
    if (!Array.isArray(output.images) || output.images.length > 4) fail('lastOutput.images 最多包含 4 张图片');
    for (const image of output.images) validateMediaUrl(image, 'image');
  }
}

function assertAudioSignature(bytes, mime) {
  const ascii = (start, end) => bytes.toString('ascii', start, end);
  const mp3 = bytes.length >= 3 && (ascii(0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0 && (bytes[2] & 0xf0) !== 0xf0 && (bytes[2] & 0x0c) !== 0x0c));
  const checks = {
    'audio/mpeg': mp3, 'audio/mp3': mp3,
    'audio/wav': bytes.length >= 44 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE',
    'audio/ogg': bytes.length >= 27 && ascii(0, 4) === 'OggS' && bytes[4] === 0,
    'audio/mp4': bytes.length >= 16 && ascii(4, 8) === 'ftyp' && /M4A |M4B |isom|iso2|mp4[12]/.test(ascii(8, 32)),
    'audio/flac': bytes.length >= 8 && ascii(0, 4) === 'fLaC',
  };
  const canonical = { 'audio/x-wav': 'audio/wav', 'audio/x-m4a': 'audio/mp4', 'audio/x-flac': 'audio/flac' }[mime] || mime;
  if (!checks[canonical]) fail('音频内容与格式不一致或文件已损坏');
}

export function serializeProject(project) {
  validateProject(project);
  const serialized = JSON.stringify(project, null, 2);
  if (Buffer.byteLength(serialized) + 1 > MAX_PROJECT_BYTES) fail('项目超过 100 MiB 限制');
  return `${serialized}\n`;
}

export function parseProject(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_PROJECT_BYTES) fail('项目超过 100 MiB 限制或格式无效');
  let project;
  try { project = JSON.parse(text); } catch { fail('项目 JSON 格式无效'); }
  return validateProject(project);
}

export async function readProject(filePath) {
  if ((await stat(filePath)).size > MAX_PROJECT_BYTES) fail('项目超过 100 MiB 限制');
  return parseProject(await readFile(filePath, 'utf8'));
}

// Same-directory exclusive temporary file + fsync + rename: old file stays intact on failure.
export async function atomicWrite(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function writeProject(filePath, project) {
  await atomicWrite(filePath, serializeProject(project));
}

const MEDIA_TYPES = {
  '.png': ['image', 'image/png'], '.jpg': ['image', 'image/jpeg'], '.jpeg': ['image', 'image/jpeg'],
  '.webp': ['image', 'image/webp'], '.gif': ['image', 'image/gif'], '.avif': ['image', 'image/avif'], '.bmp': ['image', 'image/bmp'],
  '.mp4': ['video', 'video/mp4'], '.webm': ['video', 'video/webm'], '.mov': ['video', 'video/quicktime'], '.ogv': ['video', 'video/ogg'],
  '.mp3': ['audio', 'audio/mpeg'], '.wav': ['audio', 'audio/wav'], '.ogg': ['audio', 'audio/ogg'], '.m4a': ['audio', 'audio/mp4'], '.flac': ['audio', 'audio/flac'],
};

export async function importMediaFile(filePath) {
  const type = MEDIA_TYPES[extname(filePath).toLowerCase()];
  if (!type) fail('不支持的媒体格式。图片支持 PNG/JPEG/WebP/GIF/AVIF/BMP；视频支持 MP4/WebM/MOV/OGV；音频支持 MP3/WAV/OGG/M4A/FLAC');
  const info = await stat(filePath);
  if (!info.isFile() || info.size === 0) fail('请选择有效的非空媒体文件');
  if (info.size > MAX_MEDIA_BYTES) fail('单个媒体超过 20 MiB，请压缩后重新导入');
  const bytes = await readFile(filePath);
  if (bytes.length > MAX_MEDIA_BYTES) fail('单个媒体超过 20 MiB，请压缩后重新导入');
  const signatures = {
    'image/png': () => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'image/jpeg': () => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
    'image/gif': () => /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii')),
    'image/webp': () => bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP',
    'image/bmp': () => bytes.toString('ascii', 0, 2) === 'BM',
    'image/avif': () => bytes.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(bytes.toString('ascii', 8, 32)),
    'video/mp4': () => bytes.toString('ascii', 4, 8) === 'ftyp',
    'video/quicktime': () => ['ftyp', 'moov', 'mdat', 'wide'].includes(bytes.toString('ascii', 4, 8)),
    'video/webm': () => bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
    'video/ogg': () => bytes.toString('ascii', 0, 4) === 'OggS',
  };
  if (type[0] === 'audio') assertAudioSignature(bytes, type[1]);
  else if (!signatures[type[1]]()) fail('媒体内容与扩展名不一致或文件已损坏');
  return { kind: type[0], url: `data:${type[1]};base64,${bytes.toString('base64')}`, name: basename(filePath) };
}
