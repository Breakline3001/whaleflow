import { randomUUID, createHash } from 'node:crypto';
import { setImmediate as yieldImmediate, setTimeout as delay } from 'node:timers/promises';
import { imageParameters, validateGenerationOptions } from './generation-options.mjs';
import { containsKnownSecret } from './secret-safety.mjs';
import { createSecretRegistry, resolveRunBindings, validateRunSnapshot } from './model-settings.mjs';
import { validateProject, validateMediaUrl, PROVIDERS, MAX_MEDIA_BYTES } from './project.mjs';

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const CONFIG_KEYS = new Set(['provider', 'baseUrl', 'model', 'imageModel', 'audioModel', 'videoModel', 'voice', 'temperature', 'imageSize', 'imageAspectRatio', 'batchSize', 'videoSize', 'videoSeconds']);

export function validateConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('workflow config 必须是普通对象');
  for (const key of Object.keys(input)) if (!CONFIG_KEYS.has(key)) throw new Error(`不支持的配置字段：${key}；API token 只能通过主进程环境 WHALEFLOW_API_KEY 设置`);
  const provider = input.provider ?? 'demo';
  if (!PROVIDERS.includes(provider)) throw new Error('provider 必须是 demo、ollama 或 openai');
  for (const key of ['baseUrl', 'model', 'imageModel']) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 2000)) throw new Error(`${key} 必须是字符串且长度不超过 2000`);
  }
  if (input.temperature !== undefined && (typeof input.temperature !== 'number' || !Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2)) throw new Error('temperature 必须在 0 到 2 之间');
  const baseUrl = input.baseUrl?.trim() || (provider === 'ollama' ? 'http://127.0.0.1:11434' : provider === 'openai' ? 'https://api.openai.com/v1' : '');
  if (baseUrl) assertHttpUrl(baseUrl);
  validateGenerationOptions(input, { modelMax: 2000 });
  const optional = Object.fromEntries(Object.entries(input).filter(([key]) => !['provider', 'baseUrl', 'model'].includes(key)).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]));
  return { provider, baseUrl, model: input.model?.trim() || '', ...optional };
}

function assertHttpUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('baseUrl / 媒体 URL 无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('baseUrl 必须是无凭据、无查询参数的 HTTP(S) 地址');
  return url;
}

export function topologicalSort(project) {
  validateProject(project);
  const nodes = new Map(project.nodes.map((node) => [node.id, node]));
  const counts = new Map(project.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(project.nodes.map((node) => [node.id, []]));
  for (const edge of project.edges) {
    counts.set(edge.target, counts.get(edge.target) + 1);
    outgoing.get(edge.source).push(edge.target);
  }
  const order = project.nodes.filter((node) => counts.get(node.id) === 0).map((node) => node.id);
  for (let i = 0; i < order.length; i++) {
    for (const target of outgoing.get(order[i])) {
      counts.set(target, counts.get(target) - 1);
      if (counts.get(target) === 0) order.push(target);
    }
  }
  return order.map((id) => nodes.get(id));
}

function abortError() { return new DOMException('工作流已取消', 'AbortError'); }
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
// Only an explicit workflow abort is cancellation; transport timeouts remain node errors.
const isAbort = (_error, signal) => signal?.aborted === true;
function redact(error, secrets) {
  const message = error instanceof Error ? error.message : String(error);
  if (containsKnownSecret(message, secrets)) return '模型服务错误包含敏感凭据，详情已隐藏';
  return message.slice(0, 1000);
}

async function readResponse(response, maxBytes, signal) {
  const size = Number(response.headers?.get('content-length'));
  if (size > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error('模型响应超过大小限制');
  }
  if (!response.body?.getReader) throw new Error('模型响应缺少可读取的 body');
  const reader = response.body.getReader();
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      checkAbort(signal);
      const { done, value } = await reader.read();
      checkAbort(signal);
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error('模型响应超过大小限制');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { signal?.removeEventListener('abort', onAbort); reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

async function requestJson(url, body, context) {
  const { fetchImpl, apiKey, signal } = context;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = AbortSignal.any([signal, timeout]);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST', redirect: 'error', signal: combined,
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`模型服务请求失败：HTTP ${response.status}；请检查地址、模型和主进程环境凭据`);
    }
    const bytes = await readResponse(response, MAX_RESPONSE_BYTES, combined);
    if (context.knownSecrets().some((secret) => bytes.includes(Buffer.from(secret)))) throw new Error('模型响应包含敏感凭据，已阻止输出');
    try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error('模型服务返回了无效 JSON'); }
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (timeout.aborted) throw new Error('模型请求超过 120 秒，已中止');
    throw error;
  }
}

function endpoint(config, path, provider) {
  const base = config.baseUrl || (provider === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1');
  return `${base.replace(/\/+$/, '')}${path}`;
}

function aggregate(node, upstream) {
  const context = upstream.map(({ node: source, output }) => {
    const content = [output.text, output.image ? '[上游含图像]' : '', output.video ? '[上游含视频：仅素材引用，未解析画面或声音]' : '', output.audio ? '[上游含音频：仅素材引用，未转录]' : ''].filter(Boolean).join('\n');
    return content ? `【${source.data.title || source.id}】\n${content}` : '';
  }).filter(Boolean).join('\n\n');
  const prompt = [context, node.data.content.trim()].filter(Boolean).join('\n\n');
  if (Buffer.byteLength(prompt) > 2 * 1024 * 1024) throw new Error('汇总提示词超过 2 MiB，请减少上游内容');
  return prompt;
}

function demoImage(prompt) {
  const hash = createHash('sha256').update(prompt).digest('hex');
  const escape = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const title = escape(prompt.replace(/\s+/g, ' ').slice(0, 64) || 'WhaleFlow local preview');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="640" viewBox="0 0 1024 640"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#${hash.slice(0, 6)}"/><stop offset="1" stop-color="#${hash.slice(6, 12)}"/></linearGradient></defs><rect width="1024" height="640" fill="#111827"/><rect x="28" y="28" width="968" height="584" rx="32" fill="url(#g)"/><circle cx="790" cy="240" r="115" fill="white" opacity=".17"/><path d="M28 440 Q270 260 510 450 T996 380 V612 H28Z" fill="#071422" opacity=".5"/><text x="66" y="100" fill="white" font-family="sans-serif" font-size="24">DEMO · LOCAL SVG · NOT AI GENERATED</text><text x="66" y="520" fill="white" font-family="sans-serif" font-size="22">${title}</text><text x="66" y="568" fill="white" font-family="monospace" font-size="16">deterministic preview / ${hash.slice(0, 12)}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

async function remoteImageToDataUrl(rawUrl, context) {
  // Never forward the API token to an image CDN. Query strings (signed URLs) are supported.
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('图像服务返回的图像 URL 无效'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('图像 URL 必须是 HTTP(S) 地址');
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  const response = await context.fetchImpl(url.toString(), { redirect: 'error', signal });
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`下载生成图像失败：HTTP ${response.status}`); }
  const mime = response.headers.get('content-type')?.split(';')[0].toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp'].includes(mime)) {
    await response.body?.cancel().catch(() => {});
    throw new Error('生成图像响应不是受支持的图片格式');
  }
  const bytes = await readResponse(response, MAX_MEDIA_BYTES, signal);
  const data = `data:${mime};base64,${bytes.toString('base64')}`;
  return validateMediaUrl(data, 'image');
}

function demoAudio(prompt) {
  const bytes = Buffer.alloc(44 + 16000);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(16000, 40);
  const frequency = 220 + createHash('sha256').update(prompt).digest()[0];
  for (let i = 0; i < 8000; i++) bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * i / 8000) * 4000 * Math.sin(Math.PI * i / 8000)), 44 + i * 2);
  return `data:audio/wav;base64,${bytes.toString('base64')}`;
}

async function mediaRequest(url, options, context, binaryMime) {
  checkAbort(context.signal);
  const response = await context.fetchImpl(url, { ...options, redirect: 'error', signal: context.signal,
    headers: { ...(context.apiKey ? { Authorization: `Bearer ${context.apiKey}` } : {}), ...options.headers } });
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`模型服务请求失败：HTTP ${response.status}；请检查地址、模型和主进程环境凭据`); }
  if (binaryMime) {
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const accepted = binaryMime === 'audio/wav' ? ['audio/wav', 'audio/x-wav', 'application/octet-stream'] : ['video/mp4', 'application/octet-stream'];
    if (!accepted.includes(mime)) { await response.body?.cancel().catch(() => {}); throw new Error('生成媒体响应类型不正确'); }
  }
  const bytes = await readResponse(response, binaryMime ? MAX_MEDIA_BYTES : MAX_RESPONSE_BYTES, context.signal);
  if (context.knownSecrets().some((secret) => bytes.includes(Buffer.from(secret)))) throw new Error('模型响应包含敏感凭据，已阻止输出');
  if (!binaryMime) { try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error('模型服务返回了无效 JSON'); } }
  if (binaryMime === 'video/mp4' && (bytes.length < 16 || bytes.toString('ascii', 4, 8) !== 'ftyp')) throw new Error('生成视频不是有效 MP4');
  return validateMediaUrl(`data:${binaryMime};base64,${bytes.toString('base64')}`, binaryMime.split('/')[0]);
}

async function generateVideo(node, upstream, prompt, config, context, provider) {
  if (provider !== 'openai') throw new Error('未配置视频生成模型；视频生成只支持 OpenAI 兼容 /videos，demo 不会伪造 AI 视频');
  const model = context.selectedModel ?? (node.data.videoModel?.trim() || config.videoModel);
  if (!model) throw new Error('未配置 videoModel 视频生成模型');
  if (!prompt) throw new Error('请填写视频生成提示词');
  const form = new FormData();
  form.set('model', model); form.set('prompt', prompt);
  form.set('size', node.data.videoSize ?? config.videoSize ?? '1280x720');
  form.set('seconds', String(node.data.videoSeconds ?? config.videoSeconds ?? 4));
  const reference = node.data.referenceImage || upstream.map((item) => item.output.image).filter(Boolean).at(-1);
  if (reference) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/i.exec(reference);
    if (!match) throw new Error('视频参考图必须为 PNG/JPEG/WebP base64 素材；DEMO SVG 不能作为真实视频参考图');
    form.set('input_reference', new Blob([Buffer.from(match[2], 'base64')], { type: match[1] }), `reference.${match[1].split('/')[1]}`);
  }
  let job = await mediaRequest(endpoint(config, '/videos', provider), { method: 'POST', body: form }, context);
  if (typeof job.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(job.id)) throw new Error('视频服务返回的 job ID 无效');
  const id = job.id;
  while (true) {
    checkAbort(context.signal);
    if (job.status === 'completed') break;
    if (['failed', 'cancelled', 'canceled', 'expired'].includes(job.status)) throw new Error(`视频任务失败：${job.status}；服务错误详情已隐藏`);
    if (!['queued', 'in_progress'].includes(job.status)) throw new Error('视频任务状态无效');
    await delay(context.videoPollIntervalMs, undefined, { signal: context.signal });
    job = await mediaRequest(endpoint(config, `/videos/${encodeURIComponent(id)}`, provider), { method: 'GET' }, context);
    if (job.id !== undefined && job.id !== id) throw new Error('视频任务 ID 不匹配');
  }
  const video = await mediaRequest(endpoint(config, `/videos/${encodeURIComponent(id)}/content`, provider), { method: 'GET' }, context, 'video/mp4');
  return { video, text: prompt, demo: false };
}

const PLAN_KINDS = new Set(['script', 'director', 'shots', 'clip']);
function planOutput(raw, kind, demo) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.title !== 'string' || raw.title.length > 500 || !Array.isArray(raw.items) || raw.items.length > 500) throw new Error('文本服务没有返回有效的结构化方案 JSON');
  const items = raw.items.map((item) => {
    if (!item || typeof item !== 'object' || typeof item.description !== 'string' || item.description.length > 4000) throw new Error('方案条目 description 无效');
    const result = { description: item.description };
    if (item.sourceId !== undefined) { if (typeof item.sourceId !== 'string' || item.sourceId.length > 200) throw new Error('方案 sourceId 无效'); result.sourceId = item.sourceId; }
    for (const key of ['startSeconds', 'endSeconds']) if (item[key] !== undefined) { if (typeof item[key] !== 'number' || !Number.isFinite(item[key]) || item[key] < 0 || item[key] > 86400) throw new Error('EDL 时间无效'); result[key] = item[key]; }
    if (kind === 'clip' && (result.startSeconds === undefined || result.endSeconds === undefined || result.endSeconds <= result.startSeconds)) throw new Error('EDL 必须包含递增的起止时间');
    return result;
  });
  const plan = { version: 1, kind, title: raw.title, items, rendered: false, mediaUnderstanding: false };
  return { plan, text: `${demo ? '[DEMO · 本地确定性方案，非真实 AI]\n' : ''}[结构化方案 / EDL；未渲染、未理解或分析视频素材]\n${JSON.stringify(plan, null, 2)}`, demo };
}

async function executeNode(node, upstream, config, context) {
  const kind = node.data.kind;
  let prompt = aggregate(node, upstream);
  if (kind === 'prompt' || kind === 'note' || (kind === 'text' && (node.data.manual === true || node.data.textMode === 'manual'))) return { text: prompt, demo: upstream.some((item) => item.output.demo === true) };
  if (['output', 'group', 'asset'].includes(kind)) {
    const media = {};
    for (const key of ['image', 'images', 'video', 'audio', 'plan']) {
      const value = upstream.map((item) => item.output[key]).filter(Boolean).at(-1);
      if (value) media[key] = value;
    }
    if (kind === 'asset' && node.data.mediaUrl) {
      const mediaKind = /^data:(image|video|audio)\//i.exec(node.data.mediaUrl)[1].toLowerCase();
      media[mediaKind] = node.data.mediaUrl;
    }
    return { text: prompt, ...media, demo: upstream.some((item) => item.output.demo === true) };
  }
  if (['image', 'video', 'audio'].includes(kind) && node.data.mediaUrl) return { [kind]: node.data.mediaUrl, text: node.data.content, demo: false };
  const provider = context.provider ?? node.data.provider ?? config.provider;
  if (kind === 'video') return generateVideo(node, upstream, prompt, config, context, provider);
  if (provider === 'demo') {
    if (kind === 'image' && node.data.referenceImage) throw new Error('DEMO 不支持参考图编辑；请选择真实图像模型');
    if (kind === 'audio') return { audio: demoAudio(prompt), text: `[DEMO · 本地确定性测试音，非语音合成、非真实 AI]\n${prompt}`, demo: true };
    if (PLAN_KINDS.has(kind)) return planOutput({ title: `DEMO ${kind}`, items: [{ description: prompt.slice(0, 4000), ...(kind === 'clip' ? { startSeconds: 0, endSeconds: 4 } : {}) }] }, kind, true);
    if (kind === 'image') return { image: demoImage(prompt), text: `[DEMO · 本地 SVG 预览，非真实 AI 图像]\n${prompt}`, demo: true };
    const digest = createHash('sha256').update(prompt).digest('hex').slice(0, 10);
    return { text: `[DEMO · 本地确定性文本，非真实 AI]\n预览编号：${digest}\n${prompt || '请连接提示词节点或填写内容。'}`, demo: true };
  }
  if (!prompt) throw new Error('请填写内容或连接包含提示词的上游节点');
  if (kind === 'image') {
    if (provider !== 'openai') throw new Error('图像生成只支持 OpenAI 兼容 /images/generations；请选择 openai 或明确的 demo 模式');
    const model = context.selectedModel ?? (node.data.imageModel?.trim() || config.imageModel);
    if (!model) throw new Error('未配置 imageModel，请设置真实图像模型名称');
    const parameters = imageParameters(config, context.selectedModel ? { ...node.data, imageModel: context.selectedModel } : node.data);
    if (node.data.referenceImage) {
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/i.exec(node.data.referenceImage);
      if (!match) throw new Error('图像参考必须为 PNG/JPEG/WebP base64 素材');
      const form = new FormData();
      form.set('model', model); form.set('prompt', prompt); form.set('n', String(parameters.n));
      if (parameters.size) form.set('size', parameters.size);
      form.set('image', new Blob([Buffer.from(match[2], 'base64')], { type: match[1] }), `reference.${match[1].split('/')[1]}`);
      const response = await mediaRequest(endpoint(config, '/images/edits', provider), { method: 'POST', body: form }, context);
      if (!Array.isArray(response.data) || response.data.length !== parameters.n) throw new Error('图像编辑服务没有返回请求数量的有效图像');
      const images = [];
      for (const image of response.data) {
        if (typeof image?.b64_json === 'string' && image.b64_json) images.push(validateMediaUrl(`data:image/png;base64,${image.b64_json}`, 'image'));
        else if (typeof image?.url === 'string' && image.url) images.push(await remoteImageToDataUrl(image.url, context));
        else throw new Error('图像编辑服务没有返回有效图像');
      }
      return { image: images[0], ...(images.length > 1 ? { images } : {}), text: prompt, demo: false };
    }
    const response = await requestJson(endpoint(config, '/images/generations', provider), { model, prompt, ...parameters }, context);
    if (!Array.isArray(response.data) || response.data.length !== parameters.n) throw new Error('图像服务没有返回请求数量的有效图像');
    const images = [];
    for (const image of response.data) {
      if (typeof image?.b64_json === 'string' && image.b64_json) images.push(validateMediaUrl(`data:image/png;base64,${image.b64_json}`, 'image'));
      else if (typeof image?.url === 'string' && image.url) images.push(await remoteImageToDataUrl(image.url, context));
      else throw new Error('图像服务没有返回有效图像');
    }
    return { image: images[0], ...(images.length > 1 ? { images } : {}), text: typeof response.data[0].revised_prompt === 'string' ? response.data[0].revised_prompt : prompt, demo: false };
  }
  if (kind === 'audio') {
    if (provider !== 'openai') throw new Error('音频合成只支持 OpenAI 兼容 /audio/speech');
    const model = context.selectedModel ?? (node.data.audioModel?.trim() || config.audioModel);
    const voice = node.data.voice?.trim() || config.voice;
    if (!model || !voice) throw new Error('请配置 audioModel 和 voice');
    const audio = await mediaRequest(endpoint(config, '/audio/speech', provider), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, voice, input: prompt, response_format: 'wav' }) }, context, 'audio/wav');
    return { audio, text: prompt, demo: false };
  }
  if (PLAN_KINDS.has(kind)) prompt = `Generate only a JSON object with title (string), items (array, max 500) for a ${kind} production plan. Each item: description (string), optional sourceId (string), startSeconds/endSeconds (nonnegative seconds, required increasing for clip EDL). Do not claim to render, watch, hear or understand media. This is a proposal based only on supplied text and asset references.\n${prompt}`;
  const model = context.selectedModel ?? (node.data.model?.trim() || config.model);
  if (!model) throw new Error('未配置文本模型，请填写 model');
  let response;
  const messages = [{ role: 'user', content: prompt }];
  if (provider === 'ollama') {
    response = await requestJson(endpoint(config, '/api/chat', provider), {
      model, messages, stream: false,
      ...(config.temperature !== undefined ? { options: { temperature: config.temperature } } : {}),
    }, context);
  } else {
    response = await requestJson(endpoint(config, '/chat/completions', provider), {
      model, messages, stream: false, ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    }, context);
  }
  const text = provider === 'ollama' ? response.message?.content : response.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('模型服务未返回有效文本');
  if (PLAN_KINDS.has(kind)) {
    let plan;
    try { plan = JSON.parse(text); } catch { throw new Error('文本服务没有返回有效的结构化方案 JSON'); }
    return planOutput(plan, kind, false);
  }
  return { text, demo: false };
}

/** Execute once. Input/config errors reject; node failures return status:error and stop all subsequent nodes. */
export async function executeWorkflow(project, config = {}, options = {}) {
  const secretRegistry = options.secretRegistry ?? createSecretRegistry();
  if (options.apiKey) secretRegistry.register([options.apiKey]);
  const snapshot = structuredClone(validateProject(project));
  const settings = validateConfig(config);
  const order = topologicalSort(snapshot);
  if (order.length === 0) throw new Error('工作流没有节点，请先添加节点');
  const runId = options.runId ?? randomUUID();
  const signal = options.signal ?? new AbortController().signal;
  const context = { signal, fetchImpl: options.fetchImpl ?? globalThis.fetch, apiKey: options.apiKey ?? '', knownSecrets: () => secretRegistry.values(), videoPollIntervalMs: options.videoPollIntervalMs ?? 1000 };
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > REQUEST_TIMEOUT_MS) throw new Error('内部请求总时限无效');
  if (!Number.isInteger(context.videoPollIntervalMs) || context.videoPollIntervalMs < 0 || context.videoPollIntervalMs > 10000) throw new Error('内部视频轮询间隔无效');
  const outputs = new Map();
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const incoming = new Map(snapshot.nodes.map((node) => [node.id, []]));
  for (const edge of snapshot.edges) incoming.get(edge.target).push(edge.source);
  const emit = (event) => options.onEvent?.({ runId, ...event });
  for (let index = 0; index < order.length; index++) {
    const node = order[index];
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      checkAbort(signal);
      emit({ nodeId: node.id, status: 'running' });
      await yieldImmediate(); // Permit cancellation even during entirely local demo workflows.
      checkAbort(signal);
      const upstream = incoming.get(node.id).map((id) => ({ node: byId.get(id), output: outputs.get(id) }));
      const binding = options.nodeBindings?.get(node.id);
      const nodeContext = { ...context, ...(binding ? { apiKey: binding.apiKey, provider: binding.config.provider, selectedModel: binding.selectedModel } : {}), signal: AbortSignal.any([signal, timeout]) };
      const output = await executeNode(node, upstream, binding?.config ?? settings, nodeContext);
      if (timeout.aborted) throw new Error('模型节点执行超过总时限，已中止');
      checkAbort(signal);
      if (containsKnownSecret(output, context.knownSecrets())) throw new Error('模型响应包含敏感凭据，已阻止输出');
      outputs.set(node.id, output);
      emit({ nodeId: node.id, status: 'success', output });
    } catch (error) {
      const cancelled = isAbort(error, signal);
      emit({ nodeId: node.id, status: cancelled ? 'cancelled' : 'error', error: cancelled ? '工作流已取消' : timeout.aborted ? '模型节点执行超过总时限，已中止' : redact(error, context.knownSecrets()) });
      if (cancelled) for (const pending of order.slice(index + 1)) emit({ nodeId: pending.id, status: 'cancelled', error: '工作流已取消，节点未执行' });
      return { runId, status: cancelled ? 'cancelled' : 'error', outputs: Object.fromEntries(outputs) };
    }
  }
  return { runId, status: 'success', outputs: Object.fromEntries(outputs) };
}

/** One active run per engine. Do not expose options.apiKey or the engine to the renderer. */
export class WorkflowEngine {
  #active = null;
  #options;
  constructor(options = {}) {
    this.#options = { ...options, secretRegistry: options.secretRegistry ?? createSecretRegistry() };
    if (options.apiKey) this.#options.secretRegistry.register([options.apiKey]);
  }
  get running() { return this.#active !== null; }
  run(project, config = {}) {
    if (this.#active) throw new Error('工作流正在运行，请先取消或等待完成');
    const snapshot = structuredClone(validateProject(project));
    if (snapshot.nodes.length === 0) throw new Error('工作流没有节点，请先添加节点');
    const settings = validateConfig(config);
    return this.#start(snapshot, settings);
  }
  runConfigured(project, runSnapshot) {
    if (this.#active) throw new Error('工作流正在运行，请先取消或等待完成');
    const snapshot = validateRunSnapshot(runSnapshot, this.#options);
    this.#options.secretRegistry.register(Object.values(snapshot.credentials).map((credential) => credential.value));
    const prepared = resolveRunBindings(project, snapshot, this.#options);
    for (const node of prepared.project.nodes) {
      if (node.data.referenceImage && prepared.bindings.get(node.id)?.config.provider === 'demo') throw new Error('DEMO 不支持参考图编辑；请选择真实图像或视频模型');
    }
    if (prepared.project.nodes.length === 0) throw new Error('工作流没有节点，请先添加节点');
    return this.#start(prepared.project, { provider: 'demo' }, { nodeBindings: prepared.bindings, apiKey: '' });
  }
  #start(snapshot, settings, overrides = {}) {
    const runId = randomUUID();
    const controller = new AbortController();
    const active = { runId, controller, promise: null };
    this.#active = active;
    active.promise = yieldImmediate().then(() => executeWorkflow(snapshot, settings, { ...this.#options, ...overrides, runId, signal: controller.signal })).finally(() => { if (this.#active === active) this.#active = null; });
    // A host callback failure must not create an unhandled rejection in the main process.
    active.promise.catch((error) => this.#options.onError?.(error));
    return { runId };
  }
  async cancel() {
    const active = this.#active;
    if (!active) return;
    active.controller.abort();
    await active.promise;
  }
  async waitForIdle() { return this.#active ? this.#active.promise : undefined; }
}
