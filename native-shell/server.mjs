import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat, unlink, mkdir, appendFile } from 'node:fs/promises';
import { appendFileSync, createReadStream, mkdirSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { atomicWrite, importMediaFile, MAX_PROJECT_BYTES, parseProject, readProject, serializeProject, validateProject, writeProject } from '../lib/project.mjs';
import { validateConfig, WorkflowEngine } from '../lib/workflow.mjs';
import { containsKnownSecret } from '../lib/secret-safety.mjs';
import {createDefaultModelSettings, validateModelSettings} from '../lib/model-settings-schema.mjs';
import {createSecretRegistry, assertNoKnownSecrets, ModelMetadataService} from '../lib/model-settings.mjs';

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
export const CSP = "default-src 'none';script-src 'self';style-src 'self' 'unsafe-inline';img-src 'self' data: blob:;media-src 'self' data: blob:;font-src 'self' data:;connect-src 'none';object-src 'none';frame-src 'none';base-uri 'none';form-action 'none';worker-src 'none'";

// This script contains only the public preload contract. The private HTTP credential
// never enters the WebView; the native host owns dialogs and the RPC allowlist.
export const NATIVE_BRIDGE = String.raw`'use strict';
(() => {
  const host = window.chrome && window.chrome.webview;
  if (!host) throw new Error('WhaleFlow native host unavailable');
  const pending = new Map();
  const listeners = new Set();
  let sequence = 0;
  const invoke = (method, args) => new Promise((resolve, reject) => {
    const id = String(++sequence);
    pending.set(id, { resolve, reject });
    try { host.postMessage({ id, method, args }); }
    catch (error) { pending.delete(id); reject(error); }
  });
  host.addEventListener('message', (ev) => {
    const message = ev.data;
    if (!message || typeof message !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(message, 'event')) {
      for (const callback of [...listeners]) {
        try { callback(message.event); }
        catch (error) { setTimeout(() => { throw error; }, 0); }
      }
      return;
    }
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error != null) {
      const detail = message.error;
      const error = new Error(typeof detail === 'string' ? detail : typeof detail?.message === 'string' ? detail.message : 'Native host request failed');
      if (detail && typeof detail === 'object') {
        if (typeof detail.code === 'string') error.code = detail.code;
        if (Number.isSafeInteger(detail.currentRevision)) error.currentRevision = detail.currentRevision;
      }
      call.reject(error);
    } else call.resolve(message.result);
  });
  Object.defineProperty(window, 'desktop', { configurable: false, writable: false, value: Object.freeze({
    openProject: () => invoke('openProject', []),
    saveProject: (project, saveAs = false) => invoke('saveProject', [project, saveAs]),
    autosave: (project) => invoke('autosave', [project]),
    restoreAutosave: () => invoke('restoreAutosave', []),
    importMedia: () => invoke('importMedia', []),
    runWorkflow: (project, config) => invoke('runWorkflow', [project, config]),
    cancelWorkflow: () => invoke('cancelWorkflow', []),
    getAppInfo: () => invoke('getAppInfo', []),
    getModelSettings: () => invoke('getModelSettings', []),
    saveModelSettings: (request) => invoke('saveModelSettings', [request]),
    configureModelCredential: (providerId, revision, action) => invoke('configureModelCredential', [providerId, revision, action]),
    listProviderModels: (request) => invoke('listProviderModels', [request]),
    cancelProviderModels: (requestId) => invoke('cancelProviderModels', [requestId]),
    onWorkflowEvent: (callback) => {
      if (typeof callback !== 'function') throw new TypeError('onWorkflowEvent callback 必须是函数');
      // Wrapping allows the same callback to be independently subscribed twice.
      const listener = (event) => callback(event);
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  }) });
})();
`;

const MIME = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.webm': 'video/webm' };
const METHODS = Object.freeze({ 'app.info': 0, 'project.open': 1, 'project.save': 2, 'project.autosave': 1, 'project.restore': 0, 'media.import': 1, 'workflow.run': 2, 'workflow.cancel': 0, 'workflow.runConfigured': 2, 'models.defaults': 0, 'models.validate': 1, 'models.registerSecrets': 1, 'models.list': 1, 'models.cancel': 1, 'host.shutdown': 0 });
const failure = (status, message) => Object.assign(new Error(message), { status });
function absolutePath(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 32767 || value.includes('\0') || !isAbsolute(value)) throw new Error(`${name} 必须是有效的绝对路径`);
  return value;
}
function within(root, path) {
  const rel = relative(root, path);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** Start a real loopback HTTP server. Importing this module has no side effects.
 * options only configure the native host; no renderer-provided transport settings.
 * close() cancels execution and flushes already accepted writes without exiting tests.
 */
export async function createNativeServer(options = {}) {
  const session = options.session ?? process.env.WHALEFLOW_HOST_SESSION;
  if (typeof session !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(session) || Buffer.from(session, 'base64').length !== 32 || Buffer.from(session, 'base64').toString('base64') !== session) throw new Error('WHALEFLOW_HOST_SESSION 必须是随机 32 字节的 base64 私有会话');
  const dataDir = absolutePath(options.dataDir ?? process.env.WHALEFLOW_HOST_DATA, 'WHALEFLOW_HOST_DATA');
  const readyPath = absolutePath(options.readyPath ?? process.env.WHALEFLOW_HOST_READY, 'WHALEFLOW_HOST_READY');
  const smoke = options.smoke ?? process.env.WHALEFLOW_SMOKE === '1';
  const apiKey = process.env.WHALEFLOW_API_KEY || '';
  const secretRegistry = createSecretRegistry([session, apiKey].filter(Boolean));
  const secretValues = () => secretRegistry.values();
  const redact = (text) => secretValues().sort((a,b) => b.length-a.length).reduce((value, secret) => value.split(secret).join('[REDACTED]'), String(text));
  const scrub = (value) => {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [redact(key), scrub(child)]));
    return value;
  };
  // Sanitize string values AND object keys without rewriting JSON punctuation.
  const safeJson = (value) => JSON.stringify(scrub(value));
  const cleanError = (error) => redact(error instanceof Error ? error.message : error).slice(0, 1500);
  const reportError = (error) => options.onError?.(new Error(cleanError(error)));
  const snapshot = (project) => {
    const text = serializeProject(project);
    if (containsKnownSecret(project, secretValues()) || secretValues().some((secret) => text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1)))) throw new Error('项目包含敏感凭据，已拒绝保存；请从项目内容中移除');
    return parseProject(text);
  };
  const subscribers = new Set();
  let stopping = false;
  let closePromise;
  let bodyReaders = 0;
  let rpcCount = 0;
  const rpcDrainWaiters = new Set();
  let projectQueue = Promise.resolve();
  let autosaveQueue = Promise.resolve();
  const pendingWrites = new Set();
  const queueWrite = (kind, action) => {
    const previous = kind === 'project' ? projectQueue : autosaveQueue;
    const next = previous.then(action);
    // Keep the queue usable after a failure, but return the original rejection to RPC.
    const tail = next.catch(() => {});
    if (kind === 'project') projectQueue = tail; else autosaveQueue = tail;
    pendingWrites.add(next);
    next.then(() => pendingWrites.delete(next), () => pendingWrites.delete(next));
    return next;
  };
  const metadata = new ModelMetadataService({secretRegistry, ...(smoke ? {fetchImpl: async () => { throw new Error('Smoke test 禁止真实模型网络'); }} : {})});
  const validatePublicSettings = (document) => {
    const result = validateModelSettings(document);
    assertNoKnownSecrets(result, secretRegistry);
    if (result.providers.some(provider => new URL(provider.baseUrl).origin === origin)) throw new Error('不能使用本程序私有地址作为模型服务');
    return result;
  };
  const engine = new WorkflowEngine({
    secretRegistry,
    apiKey: smoke ? '' : apiKey,
    ...(smoke ? { fetchImpl: async () => { throw new Error('Smoke test 禁止调用真实模型网络'); } } : {}),
    onEvent(event) {
      // Engine callbacks are synchronous, so each connection receives exactly the
      // engine's event order. Slow/disconnected subscribers cannot stall execution.
      const frame = `data: ${safeJson(event)}\n\n`;
      for (const response of subscribers) {
        if (response.destroyed || response.writableLength + Buffer.byteLength(frame) > 64 * 1024 * 1024) { subscribers.delete(response); response.destroy(); continue; }
        response.write(frame);
      }
    },
    onError: reportError,
  });
  const server = http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 30_000, headersTimeout: 10_000, keepAliveTimeout: 2000 }, (req, res) => {
    handle(req, res).catch((error) => {
      if (res.headersSent) { res.destroy(); return; }
      sendJson(res, Number.isInteger(error.status) ? error.status : 400, { error: cleanError(error) });
    });
  });
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 1000;
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  let port;
  let origin;
  function headers(res) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
  }
  function sendJson(res, status, value) {
    if (res.destroyed) return;
    headers(res);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...(status >= 400 ? { Connection: 'close' } : {}) });
    res.end(safeJson(value));
  }
  function authenticate(req) {
    const token = req.headers['x-whaleflow-session'];
    if (typeof token !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(session))) throw failure(401, '未授权的原生会话');
    // HttpClient sends neither Origin nor browser Fetch Metadata. A web page may
    // not use this transport, even if it could somehow learn the HTTP credential.
    if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) throw failure(403, '私有接口仅供原生宿主使用');
  }
  async function readRpc(req) {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) throw failure(415, 'RPC 必须使用 application/json');
    if (req.headers['content-encoding'] !== undefined) throw failure(415, 'RPC 不支持压缩请求');
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_PROJECT_BYTES)) throw failure(413, 'RPC 超过 100 MiB 限制');
    // At most one 100 MiB JSON document is buffered/parsed at once. Additional
    // authenticated requests receive explicit backpressure rather than huge heaps.
    if (bodyReaders >= 1) throw failure(429, 'RPC 请求体读取繁忙，请稍后重试');
    bodyReaders++;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > MAX_PROJECT_BYTES) throw failure(413, 'RPC 超过 100 MiB 限制');
        chunks.push(chunk);
      }
      let value;
      try { value = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); } catch { throw failure(400, 'RPC JSON 格式无效'); }
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['method', 'args'].includes(key)) || typeof value.method !== 'string' || !Object.hasOwn(METHODS, value.method) || !Array.isArray(value.args) || value.args.length !== METHODS[value.method]) throw failure(400, 'RPC 方法或参数数量无效');
      return value;
    } finally { bodyReaders--; }
  }
  async function dispatch(method, args) {
    switch (method) {
      case 'app.info': return { version: '0.5.0', platform: 'win32' };
      case 'project.open': {
        const path = absolutePath(args[0], '项目路径');
        return queueWrite('project', () => readProject(path));
      }
      case 'project.save': {
        const path = absolutePath(args[0], '项目路径');
        const data = snapshot(args[1]);
        return queueWrite('project', async () => { await writeProject(path, data); return { filePath: path }; });
      }
      case 'project.autosave': {
        const data = snapshot(args[0]);
        return queueWrite('autosave', () => writeProject(join(dataDir, 'autosave.json'), data));
      }
      case 'project.restore':
        await autosaveQueue;
        try { return await readProject(join(dataDir, 'autosave.json')); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        break;
      case 'media.import': return importMediaFile(absolutePath(args[0], '媒体路径'));
      case 'workflow.run': {
        const project = validateProject(args[0]);
        const config = validateConfig(args[1]);
        if (smoke && (config.provider !== 'demo' || project.nodes.some((node) => node.data.provider !== undefined && node.data.provider !== 'demo'))) throw new Error('Smoke test 只允许 demo provider');
        return engine.run(project, config);
      }
      case 'workflow.runConfigured': {
        const project = validateProject(args[0]);
        validatePublicSettings(args[1]?.document);
        // Snapshots remain private to the authenticated host; events expose node outputs only.
        return engine.runConfigured(project, args[1]);
      }
      case 'models.defaults': return createDefaultModelSettings();
      case 'models.validate': return validatePublicSettings(args[0]);
      case 'models.registerSecrets': secretRegistry.register(args[0]); return null;
      case 'models.list': return metadata.list(args[0]);
      case 'models.cancel': {
        if (typeof args[0] !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(args[0])) throw new Error('模型列表请求编号无效');
        metadata.cancel(args[0]); return null;
      }
      case 'workflow.cancel': return engine.cancel();
      case 'host.shutdown': return undefined;
      default: throw failure(400, '不支持的 RPC 方法');
    }
  }
  async function serveAsset(req, res, pathname) {
    const path = resolve(DIST, `.${pathname}`);
    if (!within(join(DIST, 'assets'), path)) throw failure(404, '资源不存在');
    let actual;
    try { actual = await realpath(path); }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw failure(404, '资源不存在'); throw error; }
    const root = await realpath(DIST);
    if (!within(root, actual)) throw failure(404, '资源不存在');
    const mime = MIME[extname(actual).toLowerCase()];
    if (!mime || !(await stat(actual)).isFile()) throw failure(404, '资源不存在');
    headers(res);
    res.writeHead(200, { 'Content-Type': mime });
    await pipeline(createReadStream(actual), res);
  }
  async function handle(req, res) {
    headers(res);
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== `127.0.0.1:${port}`) throw failure(403, '无效的本地 Host');
    // Do not URL-normalize traversal into a permitted route.
    if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('?') || req.url.includes('#')) throw failure(404, '资源不存在');
    let pathname;
    try { pathname = decodeURIComponent(req.url); } catch { throw failure(400, 'URL 编码无效'); }
    if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some((part) => part === '.' || part === '..')) throw failure(404, '资源不存在');
    if (stopping) throw failure(503, '原生服务正在关闭');
    if (pathname === '/rpc') {
      authenticate(req);
      if (req.method !== 'POST') throw failure(405, 'RPC 仅支持 POST');
      if (rpcCount >= 16) throw failure(429, 'RPC 并发请求过多');
      rpcCount++;
      try {
        const { method, args } = await readRpc(req);
        if (stopping) throw failure(503, '原生服务正在关闭');
        const result = await dispatch(method, args);
        if (method === 'host.shutdown') {
          stopping = true;
          res.once('finish', () => { close().then(() => options.onShutdown?.(), reportError); });
        }
        sendJson(res, 200, { result: result ?? null });
      } finally {
        rpcCount--;
        if (rpcCount === 0) { for (const done of rpcDrainWaiters) done(); rpcDrainWaiters.clear(); }
      }
      return;
    }
    if (pathname === '/events') {
      authenticate(req);
      if (req.method !== 'GET') throw failure(405, 'events 仅支持 GET');
      if (subscribers.size >= 8) throw failure(429, '事件订阅过多');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      subscribers.add(res);
      res.once('close', () => subscribers.delete(res));
      return;
    }
    if (req.method !== 'GET') throw failure(405, '静态资源仅支持 GET');
    if (req.headers.origin !== undefined && req.headers.origin !== origin) throw failure(403, '禁止跨域访问');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw failure(403, '禁止跨域访问');
    if (pathname === '/native-bridge.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(NATIVE_BRIDGE);
      return;
    }
    if (pathname === '/') {
      const html = await readFile(join(DIST, 'index.html'), 'utf8');
      // The first script (and therefore every module script) follows the bridge.
      const index = html.search(/<script\b/i);
      if (index < 0) throw new Error('dist/index.html 缺少模块脚本');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`${html.slice(0, index)}<script src="/native-bridge.js"></script>${html.slice(index)}`);
      return;
    }
    if (pathname.startsWith('/assets/')) return serveAsset(req, res, pathname);
    throw failure(404, '资源不存在');
  }
  async function close() {
    if (closePromise) return closePromise;
    stopping = true;
    closePromise = (async () => {
      metadata.cancelAll();
      const writes = [...pendingWrites];
      const drained = rpcCount === 0 ? Promise.resolve() : new Promise((done) => rpcDrainWaiters.add(done));
      const results = await Promise.allSettled([engine.cancel(), ...writes, projectQueue, autosaveQueue, drained]);
      for (const response of subscribers) response.end();
      subscribers.clear();
      await new Promise((resolveClose, reject) => {
        server.close((error) => error ? reject(error) : resolveClose());
        server.closeIdleConnections();
        const force = setTimeout(() => server.closeAllConnections(), 2000);
        force.unref();
        server.once('close', () => clearTimeout(force));
      });
      // Only remove the readiness record belonging to this instance.
      try { if ((await readFile(readyPath, 'utf8')) === JSON.stringify({ port })) await unlink(readyPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw new Error(cleanError(failed.reason));
    })();
    return closePromise;
  }
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolveListen(); });
  });
  port = server.address().port;
  origin = `http://127.0.0.1:${port}`;
  metadata.setForbiddenOrigins([origin]);
  server.on('error', reportError);
  try { await atomicWrite(readyPath, JSON.stringify({ port })); }
  catch (error) { await close(); throw new Error(cleanError(error)); }
  return Object.freeze({ port, origin, close });
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const logFailure = async (error) => {
    let message = error instanceof Error ? error.message : String(error);
    for (const value of [process.env.WHALEFLOW_HOST_SESSION, process.env.WHALEFLOW_API_KEY]) if (value) message = message.split(value).join('[REDACTED]');
    console.error(message);
    const directory = process.env.WHALEFLOW_HOST_DATA;
    if (!directory || !isAbsolute(directory)) return;
    try { await mkdir(directory, { recursive: true }); await appendFile(join(directory, 'native-startup.log'), `${new Date().toISOString()} ${message}\n`, 'utf8'); }
    catch { console.error('无法写入原生启动日志，请检查应用 Data 目录权限'); }
  };
  let native;
  const shutdown = async () => {
    try { await native?.close(); process.exitCode = 0; }
    catch (error) { await logFailure(error); process.exitCode = 1; }
  };
  try {
    native = await createNativeServer({ onShutdown: () => { process.exitCode = 0; }, onError: (error) => { void logFailure(error); process.exitCode = 1; } });
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    // Fatal diagnostics remain visible even without an attached console.
    await logFailure(error);
    process.exitCode = 1;
  }
}
