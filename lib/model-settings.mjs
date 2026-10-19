import { validateModelSettings, validateProvider, validateModelSelection } from './model-settings-schema.mjs';
import { validateProject } from './project.mjs';
import { containsKnownSecret } from './secret-safety.mjs';

const fail = (message) => { throw new Error(message); };
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function exactObject(value, keys, label) {
  if (!isObject(value)) fail(`${label} 必须是普通对象`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => !keys.includes(key))) fail(`${label} 字段无效`);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail(`${label} 只能包含 JSON 数据字段`);
  }
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('settings revision 无效');
  return value;
}

/** Add-only session registry; callers must never expose this object through renderer IPC. */
export function createSecretRegistry(initial = []) {
  const secrets = new Set();
  const registry = {
    register(values) {
      if (!Array.isArray(values) || values.length > 4096 || values.some((value) => typeof value !== 'string' || !value || value.length > 16384)) fail('secret registry 输入无效');
      for (const value of values) secrets.add(value);
    },
    values() { return [...secrets]; },
  };
  registry.register(initial);
  return Object.freeze(registry);
}

export function assertNoKnownSecrets(value, secretRegistry) {
  if (containsKnownSecret(value, secretRegistry?.values() ?? [])) fail('数据包含敏感凭据，已阻止操作');
  return value;
}

export function validateCredential(provider, value) {
  if (value === undefined || value === null) {
    if (provider.auth === 'required') fail('提供商缺少已绑定凭据；不会使用环境变量回退');
    return null;
  }
  exactObject(value, ['protocol', 'baseUrl', 'value'], 'credential');
  if (provider.auth === 'none') fail('无认证提供商不能携带凭据');
  if (value.protocol !== provider.protocol || value.baseUrl !== provider.baseUrl) fail('凭据绑定的协议或地址已改变，请重新配置');
  if (typeof value.value !== 'string' || !value.value.trim() || value.value.length > 8192 || /[\u0000-\u0020\u007f-\uffff]/.test(value.value)) fail('credential value 无效');
  return { protocol: value.protocol, baseUrl: value.baseUrl, value: value.value };
}

/** Validate and copy the private host snapshot, never the public credential-status snapshot. */
export function validateRunSnapshot(value, { secretRegistry } = {}) {
  exactObject(value, ['revision', 'document', 'credentials'], 'run snapshot');
  const document = validateModelSettings(value.document);
  assertNoKnownSecrets(document, secretRegistry);
  if (!isObject(value.credentials)) fail('run credentials 必须是普通对象');
  const byId = new Map(document.providers.map((provider) => [provider.id, provider]));
  const credentials = {};
  for (const key of Reflect.ownKeys(value.credentials)) {
    const descriptor = Object.getOwnPropertyDescriptor(value.credentials, key);
    if (typeof key !== 'string' || !byId.has(key) || !descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail('run credentials 包含未知提供商或无效字段');
    const credential = validateCredential(byId.get(key), descriptor.value);
    if (!credential) fail('run credentials 记录不能为空');
    Object.defineProperty(credentials, key, { value: credential, enumerable: true, writable: true, configurable: true });
  }
  if (containsKnownSecret(document, Object.values(credentials).map((credential) => credential.value))) fail('公开配置包含敏感凭据');
  // Missing credentials are permitted in a stored snapshot, but never for an executed node.
  return { revision: revision(value.revision), document, credentials };
}

function nodeRole(node) {
  const { kind, mediaUrl } = node.data;
  if (['prompt', 'note', 'output', 'group', 'asset'].includes(kind) || (kind === 'text' && (node.data.manual === true || node.data.textMode === 'manual')) || (['image', 'video', 'audio'].includes(kind) && mediaUrl)) return null;
  return ['image', 'video', 'audio'].includes(kind) ? kind : 'text';
}

/** Resolve every executable node before any fetch, event, or asynchronous work. */
export function resolveRunBindings(project, runSnapshot, options = {}) {
  const snapshot = validateRunSnapshot(runSnapshot, options);
  const secrets = [...Object.values(snapshot.credentials).map((credential) => credential.value), ...(options.secretRegistry?.values() ?? [])];
  if (containsKnownSecret(project, secrets)) fail('项目包含敏感凭据，已阻止操作');
  const graph = structuredClone(validateProject(project));
  const { document, credentials } = snapshot;
  const byId = new Map(document.providers.map((provider) => [provider.id, provider]));
  const bindings = new Map();
  for (const node of graph.nodes) {
    const role = nodeRole(node);
    const config = { provider: 'demo', temperature: document.general.temperature, voice: document.general.voice };
    if (!role || node.data.provider === 'demo') {
      bindings.set(node.id, { config, apiKey: '', selectedModel: null });
      continue;
    }
    const hasRef = node.data.modelRef !== undefined && node.data.modelRef !== null;
    if (hasRef && graph.version < 2) fail('modelRef 只能在 version 2 或更新项目中执行');
    const selection = hasRef ? validateModelSelection(node.data.modelRef) : document.defaults[role];
    if (hasRef && !selection) fail('节点 modelRef 不能为空');
    if (!selection) {
      if (byId.size === 0 && !hasRef) {
        bindings.set(node.id, { config, apiKey: '', selectedModel: null });
        continue;
      }
      fail(`节点缺少 ${role} 默认模型选择`);
    }
    const provider = byId.get(selection.providerId);
    if (!provider) fail('节点引用的提供商不存在');
    if (node.data.provider && node.data.provider !== provider.protocol) fail('旧节点 provider 协议与所选提供商不匹配');
    const legacyField = role === 'text' ? 'model' : `${role}Model`;
    const modelId = hasRef ? selection.modelId : node.data[legacyField]?.trim() || selection.modelId;
    const model = provider.models.find((item) => item.id === modelId);
    if (!model || !model.roles.includes(role)) fail('节点模型不存在或未声明所需 role');
    const credential = validateCredential(provider, Object.prototype.hasOwnProperty.call(credentials, provider.id) ? credentials[provider.id] : undefined);
    bindings.set(node.id, {
      config: { ...config, provider: provider.protocol, baseUrl: provider.baseUrl, model: model.id, imageModel: model.id, audioModel: model.id, videoModel: model.id },
      apiKey: credential?.value ?? '', selectedModel: model.id,
    });
  }
  return { project: graph, snapshot, bindings };
}

/** Metadata only: no model generation or model downloads, and no credential redirects. */
export class ModelMetadataService {
  #fetch;
  #registry;
  #requests = new Map();
  #timeout;
  #maxBytes;
  #forbiddenOrigins = new Set();
  constructor({ fetchImpl = globalThis.fetch, secretRegistry = createSecretRegistry(), timeoutMs = 10_000, maxBodyBytes = 1024 * 1024, forbiddenOrigins = [] } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000 || !Number.isInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 1024 * 1024) fail('metadata 请求限制无效');
    this.#fetch = fetchImpl; this.#registry = secretRegistry; this.#timeout = timeoutMs; this.#maxBytes = maxBodyBytes;
    this.setForbiddenOrigins(forbiddenOrigins);
  }
  setForbiddenOrigins(origins) {
    if (!Array.isArray(origins)) fail('禁止访问的 origin 列表无效');
    this.#forbiddenOrigins = new Set(origins.map((origin) => new URL(origin).origin));
  }
  registerSecrets(values) { this.#registry.register(values); }
  cancel(requestId) { this.#requests.get(requestId)?.abort(); }
  cancelAll() {
    for (const controller of this.#requests.values()) controller.abort();
  }
  async list(input) {
    exactObject(input, ['provider', 'credential', 'requestId'], 'metadata request');
    const provider = validateProvider(input.provider);
    const { requestId } = input;
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(requestId)) fail('metadata requestId 无效');
    if (this.#requests.has(requestId)) fail('metadata requestId 正在使用');
    const credential = validateCredential(provider, input.credential);
    if (credential) this.#registry.register([credential.value]);
    assertNoKnownSecrets(provider, this.#registry);
    if (this.#forbiddenOrigins.has(new URL(provider.baseUrl).origin)) fail('metadata 不能访问本程序私有 origin');
    const controller = new AbortController();
    this.#requests.set(requestId, controller);
    let timedOut = false;
    let reader;
    // Race the entire operation as well as passing a signal: a non-cooperative fetch/body
    // implementation cannot hold the public promise beyond cancellation or the total deadline.
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeout);
    const signal = controller.signal;
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => {
        void reader?.cancel().catch(() => {});
        reject(new Error(timedOut ? 'metadata 请求超过总时限，已中止' : 'metadata 请求已取消'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const operation = async () => {
      const response = await this.#fetch(`${provider.baseUrl}${provider.protocol === 'ollama' ? '/api/tags' : '/models'}`, {
        method: 'GET', redirect: 'error', signal,
        headers: credential ? { Authorization: `Bearer ${credential.value}` } : {},
      });
      if (signal.aborted) { void response.body?.cancel().catch(() => {}); fail('metadata 请求已中止'); }
      if (!response.ok) { void response.body?.cancel().catch(() => {}); fail('metadata 服务返回失败状态'); }
      if (Number(response.headers?.get('content-length')) > this.#maxBytes) { void response.body?.cancel().catch(() => {}); fail('metadata 响应超过大小限制'); }
      if (!response.body?.getReader) fail('metadata 响应缺少 body');
      reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (signal.aborted) fail('metadata 请求已中止');
          if (done) break;
          size += value.byteLength;
          if (size > this.#maxBytes) fail('metadata 响应超过大小限制');
          chunks.push(Buffer.from(value));
        }
      } finally {
        if (signal.aborted || size > this.#maxBytes) void reader.cancel().catch(() => {});
        reader.releaseLock(); reader = undefined;
      }
      const bytes = Buffer.concat(chunks, size);
      if (this.#registry.values().some((secret) => bytes.includes(Buffer.from(secret)))) fail('metadata 响应包含敏感凭据');
      let data;
      try { data = JSON.parse(bytes.toString('utf8')); } catch { fail('metadata 响应不是有效 JSON'); }
      const items = provider.protocol === 'ollama' ? data?.models : data?.data;
      if (!Array.isArray(items) || items.length > 512) fail('metadata 列表无效或超过 512 项');
      const ids = new Set();
      const models = items.map((item) => {
        const id = provider.protocol === 'ollama' ? item?.model ?? item?.name : item?.id;
        const name = item?.name ?? (typeof id === 'string' ? id.slice(0, 100) : id);
        if (typeof id !== 'string' || !id.trim() || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id) || typeof name !== 'string' || !name.trim() || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) fail('metadata 模型条目无效');
        if (ids.has(id.trim())) fail('metadata model ID 重复');
        ids.add(id.trim());
        return { id: id.trim(), name: name.trim() };
      });
      const result = { requestId, providerId: provider.id, models, source: 'metadata' };
      assertNoKnownSecrets(result, this.#registry);
      return result;
    };
    try { return await Promise.race([operation(), aborted]); }
    catch (error) {
      // External error messages can contain credentials, URLs, or reflected response data.
      if (signal.aborted) throw new Error(timedOut ? 'metadata 请求超过总时限，已中止' : 'metadata 请求已取消');
      throw new Error('无法读取模型 metadata；请检查地址、凭据和列表格式');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (this.#requests.get(requestId) === controller) this.#requests.delete(requestId);
    }
  }
}
