#!/usr/bin/env node
// WhaleFlow CLI —— 给人和 AI 代理用的项目编排接口。
//
// 设计边界：凭据在 C# 宿主的 DPAPI 密文里，CLI 拿不到，所以这里不做真实生成。
// CLI 负责「结构」：建项目、加节点、写剧本与分镜、编译任务、校验、导出。
// 真正的生成仍在桌面程序里执行，CLI 生成的任务节点打开即用。
//
// 所有命令默认输出 JSON，便于代理解析；加 --pretty 输出缩进版。
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateProject, writeProject} from '../lib/project.mjs';
import {createCreativeDocument, validateCreativeDocument} from '../lib/creative-schema.mjs';

const DEFAULT_FILE = 'whaleflow.project.json';
const args = process.argv.slice(2);
const pretty = args.includes('--pretty');
const json = value => process.stdout.write(JSON.stringify(value, null, pretty ? 2 : 0) + '\n');
const fail = (message, code = 1) => { process.stdout.write(JSON.stringify({ok: false, error: message}) + '\n'); process.exit(code); };
const flag = name => args.includes(`--${name}`);
const opt = (name, fallback = undefined) => {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : true;
};
const positional = args.filter((value, index) => !value.startsWith('--') && !(index > 0 && args[index - 1].startsWith('--')));
const file = path.resolve(String(opt('file', DEFAULT_FILE)));

async function load() {
  if (!existsSync(file)) fail(`找不到项目文件：${file}（先跑 wf init）`);
  const text = await readFile(file, 'utf8');
  const data = JSON.parse(text);
  validateProject(data);
  return data;
}
const save = async project => { validateProject(project); await writeProject(file, project); };
const now = () => new Date().toISOString();
const nextId = (nodes, prefix) => {
  let index = 1;
  const used = new Set(nodes.map(node => node.id));
  while (used.has(`${prefix}-${index}`)) index++;
  return `${prefix}-${index}`;
};
const blankProject = () => ({version: 3, name: '未命名工作区', nodes: [], edges: [], viewport: {x: 0, y: 0, zoom: 1}, workspace: {canvases: [{id: 'canvas-1', name: '画布 1', nodes: [], edges: [], viewport: {x: 0, y: 0, zoom: 1}}], activeCanvasId: 'canvas-1'}});
const KINDS = new Set(['prompt', 'text', 'image', 'video', 'note', 'output', 'audio', 'group', 'script', 'clip', 'director', 'shots', 'asset']);

function addNodeTo(project, kind, data, position) {
  if (!KINDS.has(kind)) fail(`不支持的节点类型：${kind}（可用：${[...KINDS].join(', ')}）`);
  const id = nextId(project.nodes, kind);
  const node = {
    id, type: 'workflow',
    position: position || {x: 80 + (project.nodes.length % 4) * 420, y: 100 + Math.floor(project.nodes.length / 4) * 420},
    width: kind === 'image' || kind === 'video' ? 622 : 350,
    height: kind === 'image' || kind === 'video' ? 350 : 350,
    data: {kind, title: data.title || kind, content: data.content || '', ...data},
  };
  delete node.data.kindData;
  project.nodes.push(node);
  return node;
}

const commands = {
  // wf init [--name 名称] [--file 路径]
  async init() {
    if (existsSync(file)) fail(`文件已存在，拒绝覆盖：${file}`);
    const project = blankProject();
    project.name = String(opt('name', '未命名工作区'));
    await save(project);
    json({ok: true, file, project: {name: project.name, version: project.version, nodes: 0}});
  },

  // wf info
  async info() {
    const project = await load();
    const counts = {};
    for (const node of project.nodes) counts[node.data.kind] = (counts[node.data.kind] || 0) + 1;
    const studio = project.nodes.find(node => node.data.creative);
    json({ok: true, file, name: project.name, version: project.version, nodes: project.nodes.length, kinds: counts,
      storyboard: studio ? {nodeId: studio.id, revision: studio.data.creative.revision, shots: studio.data.creative.shots.length} : null});
  },

  // wf ls [--kind image]
  async ls() {
    const project = await load();
    const kind = opt('kind');
    const nodes = project.nodes.filter(node => !kind || node.data.kind === kind)
      .map(node => ({id: node.id, kind: node.data.kind, title: node.data.title, x: Math.round(node.position.x), y: Math.round(node.position.y),
        hasOutput: Boolean(node.data.lastOutput), shots: node.data.creative?.shots?.length}));
    json({ok: true, count: nodes.length, nodes});
  },

  // wf add <kind> --title T --content C [--x N --y N]
  async add() {
    const kind = positional[1];
    if (!kind) fail('用法：wf add <节点类型> --title 标题 --content 内容');
    const project = await load();
    const title = String(opt('title', kind));
    const content = String(opt('content', ''));
    const x = opt('x'), y = opt('y');
    const position = x !== undefined && y !== undefined ? {x: Number(x), y: Number(y)} : undefined;
    const node = addNodeTo(project, kind, {title, content}, position);
    await save(project);
    json({ok: true, node: {id: node.id, kind, title}});
  },

  // wf text <id> --content 新内容（改节点正文）
  async text() {
    const id = positional[1];
    if (!id) fail('用法：wf text <节点id> --content 新内容');
    const project = await load();
    const node = project.nodes.find(item => item.id === id);
    if (!node) fail(`没有节点：${id}`);
    const content = opt('content');
    if (content !== undefined) node.data.content = String(content);
    await save(project);
    json({ok: true, node: {id, contentLength: node.data.content.length}});
  },

  // wf script create --node <脚本节点id> --title T --script 正文
  async script() {
    const sub = positional[1];
    if (sub !== 'create') fail('用法：wf script create --node <id> --title 标题 --script 正文');
    const project = await load();
    const nodeId = String(opt('node', ''));
    let node = project.nodes.find(item => item.id === nodeId);
    if (!node) {
      node = addNodeTo(project, 'script', {title: String(opt('title', '脚本生成器'))});
    }
    const doc = createCreativeDocument({
      title: String(opt('title', node.data.title || '剧本')),
      script: String(opt('script', '')),
      synopsis: String(opt('synopsis', '')),
      style: String(opt('style', '')),
    });
    node.data.creative = doc;
    project.version = 3;
    await save(project);
    json({ok: true, node: node.id, revision: doc.revision});
  },

  // wf shots add --title T --prompt P --duration 4 [--node <id>]
  async shots() {
    const sub = positional[1];
    const project = await load();
    const studio = project.nodes.find(node => node.data.creative && (!opt('node') || node.id === opt('node')));
    if (!studio) fail('项目里没有带创作文档的节点，先跑 wf script create');
    const doc = studio.data.creative;
    if (sub === 'ls') {
      json({ok: true, node: studio.id, revision: doc.revision, shots: doc.shots.map((shot, index) => ({index: index + 1, id: shot.id, title: shot.title, duration: shot.duration, prompt: shot.prompt}))});
      return;
    }
    if (sub === 'add') {
      const shot = {
        id: String(opt('id', `shot-${doc.shots.length + 1}-${randomUUID().slice(0, 8)}`)),
        title: String(opt('title', `镜头 ${doc.shots.length + 1}`)),
        description: String(opt('description', '')),
        duration: [4, 8, 12].includes(Number(opt('duration'))) ? Number(opt('duration')) : 4,
        shotSize: String(opt('shot-size', '中景')),
        camera: String(opt('camera', '固定')),
        dialogue: String(opt('dialogue', '')),
        sound: String(opt('sound', '')),
        prompt: String(opt('prompt', '')),
      };
      doc.shots.push(shot);
      doc.revision += 1;
      const check = validateCreativeDocument(doc);
      if (!check.valid) fail(check.errors.join('; '));
      await save(project);
      json({ok: true, node: studio.id, shot, revision: doc.revision, count: doc.shots.length});
      return;
    }
    fail('用法：wf shots ls | wf shots add --title ... --prompt ...');
  },

  // wf compile --shots 1,2 --mode image [--node <id>] —— 生成待执行的任务节点
  async compile() {
    const project = await load();
    const studio = project.nodes.find(node => node.data.creative && (!opt('node') || node.id === opt('node')));
    if (!studio) fail('项目里没有带创作文档的节点');
    const doc = studio.data.creative;
    const mode = String(opt('mode', 'image'));
    if (!['image', 'video'].includes(mode)) fail('--mode 只能是 image 或 video');
    const picked = String(opt('shots', '')).split(',').map(value => Number(value.trim())).filter(value => Number.isInteger(value) && value > 0);
    const chosen = picked.length ? doc.shots.filter((shot, index) => picked.includes(index + 1)) : doc.shots;
    if (!chosen.length) fail('没有选中任何镜头');
    const created = [];
    for (const shot of chosen) {
      const node = addNodeTo(project, mode, {
        title: `${shot.title} · ${mode === 'image' ? '分镜图' : '首帧视频'}`,
        content: shot.prompt || shot.description,
        studioNodeId: studio.id,
        studioShotId: shot.id,
        studioRevision: doc.revision,
        ...(mode === 'image' ? {imageSize: '1024x1024', imageAspectRatio: '1:1', batchSize: 1} : {videoSeconds: 4, videoSize: '1280x720'}),
      });
      created.push({id: node.id, shot: shot.title, kind: mode});
    }
    await save(project);
    json({ok: true, created, note: '任务节点已写入项目，在桌面程序里打开该项目即可执行生成'});
  },

  // wf check
  async check() {
    const project = await load();
    const studio = project.nodes.find(node => node.data.creative);
    const warnings = [];
    if (studio) {
      const doc = studio.data.creative;
      if (!doc.shots.length) warnings.push('分镜文档里没有镜头');
      const missingPrompt = doc.shots.filter(shot => !shot.prompt && !shot.description);
      if (missingPrompt.length) warnings.push(`${missingPrompt.length} 个镜头既没有提示词也没有描述`);
    }
    json({ok: true, valid: true, warnings, nodes: project.nodes.length, version: project.version});
  },

  // wf export --out 路径
  async export() {
    const project = await load();
    const out = path.resolve(String(opt('out', 'whaleflow.export.json')));
    const payload = {...project, exportedAt: now(), generatedBy: 'wf-cli'};
    validateProject(payload);
    await mkdir(path.dirname(out), {recursive: true});
    await writeFile(out, JSON.stringify(payload, null, 2));
    json({ok: true, out, bytes: Buffer.byteLength(JSON.stringify(payload))});
  },

  help() {
    json({ok: true, usage: {
      'wf init --name <名称> [--file 路径]': '新建项目',
      'wf info': '项目概况（节点数、分镜数、修订号）',
      'wf ls [--kind image]': '列出节点',
      'wf add <类型> --title T --content C': '加节点，类型含 text/image/video/script/director/audio/shots',
      'wf text <id> --content C': '改节点正文',
      'wf script create --node <id> --title T --script 正文': '写入剧本',
      'wf shots ls': '列镜头',
      'wf shots add --title T --prompt P [--duration 4|8|12]': '加镜头',
      'wf compile --shots 1,2 --mode image': '编译成待执行任务节点',
      'wf check': '校验与提示',
      'wf export --out 路径': '导出项目',
    }, flags: ['--pretty 缩进输出', '--file 指定项目文件'], boundary: 'CLI 不持有模型凭据，不做真实生成'});
  },
};

const name = positional[0] || 'help';
const command = commands[name];
if (!command) { json({ok: false, error: `未知命令：${name}`, hint: 'wf help'}); process.exit(1); }
try { await command(); }
catch (error) { fail(error.message); }
