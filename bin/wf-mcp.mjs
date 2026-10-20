#!/usr/bin/env node
// WhaleFlow MCP server（stdio JSON-RPC 2.0），把 wf 的能力暴露成 agent 原生工具。
// 不依赖任何 SDK；只实现 MCP 必需的 initialize / tools/list / tools/call。
// 边界与 CLI 一致：不持有模型凭据，不做真实生成。
import {createInterface} from 'node:readline';
import path from 'node:path';
import * as core from './wf-core.mjs';

const DEFAULT_FILE = process.env.WF_PROJECT || 'whaleflow.project.json';
const fileOf = args => path.resolve(String(args?.file || DEFAULT_FILE));

const tools = [
  {
    name: 'wf_init',
    description: '新建一个 WhaleFlow 项目文件。已存在则报错，不会覆盖。',
    inputSchema: {type: 'object', properties: {name: {type: 'string', description: '项目名称'}, file: {type: 'string'}}, required: ['name']},
  },
  {
    name: 'wf_info',
    description: '读取项目概况：节点数、类型分布、分镜数与当前修订号。',
    inputSchema: {type: 'object', properties: {file: {type: 'string'}}},
  },
  {
    name: 'wf_list_nodes',
    description: '列出画布节点（id、类型、标题、坐标、是否已有生成结果）。',
    inputSchema: {type: 'object', properties: {kind: {type: 'string', enum: core.NODE_KINDS}, file: {type: 'string'}}},
  },
  {
    name: 'wf_add_node',
    description: '在画布上加一个节点。类型含 text/image/video/audio/script/shots/director。',
    inputSchema: {type: 'object', properties: {kind: {type: 'string', enum: core.NODE_KINDS}, title: {type: 'string'}, content: {type: 'string'}, file: {type: 'string'}}, required: ['kind']},
  },
  {
    name: 'wf_script',
    description: '写入剧本。没有脚本节点时会自动建一个。',
    inputSchema: {type: 'object', properties: {title: {type: 'string'}, script: {type: 'string'}, synopsis: {type: 'string'}, style: {type: 'string'}, nodeId: {type: 'string'}, file: {type: 'string'}}},
  },
  {
    name: 'wf_add_shot',
    description: '给分镜文档加一个镜头。时长只能是 4、8 或 12 秒。',
    inputSchema: {type: 'object', properties: {
      title: {type: 'string'}, prompt: {type: 'string'}, description: {type: 'string'},
      duration: {type: 'number', enum: [4, 8, 12]}, shotSize: {type: 'string'}, camera: {type: 'string'},
      dialogue: {type: 'string'}, sound: {type: 'string'}, nodeId: {type: 'string'}, file: {type: 'string'},
    }},
  },
  {
    name: 'wf_list_shots',
    description: '按顺序列出镜头（序号、标题、时长、提示词）。序号从 1 开始。',
    inputSchema: {type: 'object', properties: {nodeId: {type: 'string'}, file: {type: 'string'}}},
  },
  {
    name: 'wf_compile',
    description: '把镜头编译成待执行的图片或视频任务节点。注意：会追加节点，不会替换。',
    inputSchema: {type: 'object', properties: {
      shots: {type: 'array', items: {type: 'number'}, description: '镜头序号，省略则全部'},
      mode: {type: 'string', enum: ['image', 'video']}, nodeId: {type: 'string'}, file: {type: 'string'},
    }},
  },
  {
    name: 'wf_check',
    description: '校验项目结构并给出可读提示（例如镜头缺提示词、时长不合规）。',
    inputSchema: {type: 'object', properties: {file: {type: 'string'}}},
  },
  {
    name: 'wf_export',
    description: '导出项目副本到指定路径，带导出时间戳。',
    inputSchema: {type: 'object', properties: {out: {type: 'string'}, file: {type: 'string'}}, required: ['out']},
  },
];

const handlers = {
  async wf_init(args) { return core.initProject(fileOf(args), args.name); },
  async wf_info(args) { return core.describe(await core.loadProject(fileOf(args))); },
  async wf_list_nodes(args) { return {nodes: core.listNodes(await core.loadProject(fileOf(args)), args.kind)}; },
  async wf_add_node(args) {
    const file = fileOf(args);
    const project = await core.loadProject(file);
    const node = core.addNode(project, args.kind, {title: args.title, content: args.content});
    await core.saveProject(file, project);
    return {id: node.id, kind: node.data.kind, title: node.data.title};
  },
  async wf_script(args) {
    const file = fileOf(args);
    const project = await core.loadProject(file);
    const result = core.writeScript(project, {nodeId: args.nodeId, title: args.title, script: args.script, synopsis: args.synopsis, style: args.style});
    await core.saveProject(file, project);
    return result;
  },
  async wf_add_shot(args) {
    const file = fileOf(args);
    const project = await core.loadProject(file);
    const result = core.addShot(project, {nodeId: args.nodeId, title: args.title, prompt: args.prompt, description: args.description, duration: args.duration, shotSize: args.shotSize, camera: args.camera, dialogue: args.dialogue, sound: args.sound});
    await core.saveProject(file, project);
    return result;
  },
  async wf_list_shots(args) { return core.listShots(await core.loadProject(fileOf(args)), args.nodeId); },
  async wf_compile(args) {
    const file = fileOf(args);
    const project = await core.loadProject(file);
    const result = core.compileShots(project, {nodeId: args.nodeId, shots: args.shots, mode: args.mode || 'image'});
    await core.saveProject(file, project);
    return result;
  },
  async wf_check(args) { return core.checkProject(await core.loadProject(fileOf(args))); },
  async wf_export(args) { return core.exportProject(fileOf(args), args.out); },
};

const respond = message => process.stdout.write(JSON.stringify(message) + '\n');
const ok = (id, result) => respond({jsonrpc: '2.0', id, result});
const error = (id, code, message) => respond({jsonrpc: '2.0', id, error: {code, message}});

async function dispatch(request) {
  const {id, method, params} = request;
  if (method === 'initialize') {
    ok(id, {
      protocolVersion: '2024-11-05',
      capabilities: {tools: {}},
      serverInfo: {name: 'whaleflow', version: '0.5.0'},
      instructions: 'WhaleFlow 项目编排工具。它不持有模型凭据，不执行真实生成：把剧本和镜头组织好、编译成任务节点，最后由桌面程序执行。',
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'tools/list') { ok(id, {tools}); return; }
  if (method === 'tools/call') {
    const name = params?.name;
    const handler = handlers[name];
    if (!handler) { error(id, -32602, `未知工具：${name}`); return; }
    try {
      const result = await handler(params.arguments || {});
      ok(id, {content: [{type: 'text', text: JSON.stringify(result)}], isError: false});
    } catch (failure) {
      ok(id, {content: [{type: 'text', text: JSON.stringify({ok: false, error: failure.message})}], isError: true});
    }
    return;
  }
  if (method === 'ping') { ok(id, {}); return; }
  error(id, -32601, `不支持的方法：${method}`);
}

const handle = async line => {
  const text = line.trim();
  if (!text) return;
  let request;
  try { request = JSON.parse(text); } catch { error(null, -32700, 'JSON 解析失败'); return; }
  try { await dispatch(request); } catch (failure) { error(request.id ?? null, -32603, failure.message); }
};
const reader = createInterface({input: process.stdin, crlfDelay: Infinity});
// 严格串行：MCP 客户端可能连发多条，并发写同一个项目文件会互相踩。
let chain = Promise.resolve();
reader.on('line', line => { chain = chain.then(() => handle(line)); });
// 等队列排空再退出，否则管道一次性输入时会把还在跑的异步操作掐断。
reader.on('close', () => { chain.then(() => process.exit(0), () => process.exit(1)); });
