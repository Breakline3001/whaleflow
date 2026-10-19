#!/usr/bin/env node
// wf render —— 用你显式提供的密钥跑一次真实生成，把结果写回项目。
//
// 与 wf 主命令的区别：这条会真的联网、真的花钱，所以默认只跑一个镜头，
// 而且密钥必须由调用者当场给出，绝不落盘、不读应用的 DPAPI 密文。
//
// 用法：
//   wf render --shot 1 --api-key sk-...                 # 直接传（会进命令历史，慎用）
//   wf render --shot 1 --key-file D:\key.txt            # 从文件读（推荐）
//   wf render --shot 1 --key-env MY_OPENAI_KEY          # 从指定环境变量读
//   wf render --shot 1 --demo                           # 不联网，走 DEMO 验证链路
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import * as core from './wf-core.mjs';
import {WorkflowEngine} from '../lib/workflow.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback = undefined) => {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : true;
};
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
const fail = message => { out({ok: false, error: message}); process.exit(1); };

if (args.includes('--help') || args.length === 0) {
  out({ok: true, usage: [
    'wf render --shot 1 --key-file 密钥文件 [--base-url https://api.openai.com/v1] [--model gpt-image-1] [--mode image|video]',
    'wf render --shot 1 --demo',
  ], note: '一次只渲染一个镜头；密钥只在内存里用完即弃'});
  process.exit(0);
}

const file = path.resolve(String(opt('file', 'whaleflow.project.json')));
const demo = args.includes('--demo');
const mode = String(opt('mode', 'image'));
if (!['image', 'video'].includes(mode)) fail('--mode 只能是 image 或 video');

async function readKey() {
  if (demo) return '';
  const direct = opt('api-key');
  if (direct && direct !== true) return String(direct);
  const keyFile = opt('key-file');
  if (keyFile && keyFile !== true) {
    const text = (await readFile(path.resolve(String(keyFile)), 'utf8')).trim();
    if (!text) throw Error('密钥文件是空的');
    return text;
  }
  const keyEnv = opt('key-env');
  if (keyEnv && keyEnv !== true) {
    const value = process.env[String(keyEnv)];
    if (!value) throw Error(`环境变量 ${keyEnv} 没有值`);
    return value;
  }
  throw Error('必须提供密钥：--api-key / --key-file / --key-env，或加 --demo');
}

try {
  const key = await readKey();
  const project = await core.loadProject(file);
  const studio = core.studioNode(project, opt('node'));
  const doc = studio.data.creative;
  if (!doc) fail('该节点没有分镜文档');

  const index = Number(opt('shot', 1));
  const shot = doc.shots[index - 1];
  if (!shot) fail(`没有第 ${index} 个镜头（共 ${doc.shots.length} 个）`);
  if (!shot.prompt && !shot.description) fail('这个镜头既没有提示词也没有描述，先生成不了');

  const model = String(opt('model', mode === 'image' ? 'gpt-image-1' : 'sora-2'));
  const baseUrl = String(opt('base-url', 'https://api.openai.com/v1'));
  const task = {
    id: 'render-target', type: 'workflow', position: {x: 0, y: 0}, width: 622, height: 350,
    data: {
      kind: mode,
      title: shot.title,
      content: shot.prompt || shot.description,
      ...(mode === 'image'
        ? {imageModel: model, imageSize: '1024x1024', imageAspectRatio: '1:1', batchSize: 1}
        : {videoModel: model, videoSeconds: 4, videoSize: '1280x720'}),
    },
  };
  const scratch = {...core.blankProject('render'), version: 3, nodes: [task]};

  const events = [];
  const engine = new WorkflowEngine({
    apiKey: key,
    fetchImpl: globalThis.fetch,
    onEvent: event => events.push({nodeId: event.nodeId, status: event.status}),
    onError: error => events.push({error: error.message}),
  });
  const config = demo
    ? {provider: 'demo'}
    : {provider: 'openai', baseUrl, model, imageModel: mode === 'image' ? model : undefined, videoModel: mode === 'video' ? model : undefined};
  const {runId} = await engine.run(scratch, config);
  const result = await engine.waitForIdle();

  if (result.status !== 'success') {
    out({ok: false, runId, status: result.status, events});
    process.exit(1);
  }
  const output = result.outputs['render-target'];
  const media = output?.image || output?.images?.[0] || output?.video;
  if (!media) { out({ok: false, runId, error: '执行成功但没有拿到媒体'}); process.exit(1); }

  // 把结果作为带结果的任务节点写回原项目，桌面打开即可见。
  const node = core.addNode(project, mode, {
    title: `${shot.title} · ${mode === 'image' ? '分镜图' : '首帧视频'}`,
    content: shot.prompt || shot.description,
    studioNodeId: studio.id,
    studioShotId: shot.id,
    studioRevision: doc.revision,
    lastOutput: output,
    ...(output.demo ? {demoRun: true} : {}),
  });
  await core.saveProject(file, project);

  const extra = opt('save');
  let saved = null;
  if (extra && extra !== true && /^data:image\//.test(media)) {
    const target = path.resolve(String(extra));
    await mkdir(path.dirname(target), {recursive: true});
    await writeFile(target, Buffer.from(media.split(',')[1], 'base64'));
    saved = target;
  }

  out({
    ok: true, runId, status: result.status, demo: Boolean(output.demo),
    node: node.id, shot: index, bytes: media.length, saved,
    note: output.demo ? 'DEMO 结果，不是真实模型产物' : '结果已写入项目',
  });
} catch (error) {
  fail(error.message);
}
