// This module is intentionally platform-neutral: the renderer and private host use one contract.
export const MODEL_ROLES = Object.freeze(['text', 'image', 'video', 'audio']);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const fail = (message) => { throw new Error(message); };

function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} 必须是普通对象`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) fail(`${label} 包含不支持的字段`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !own(descriptor, 'value')) fail(`${label} 只能包含 JSON 数据字段`);
  }
  for (const key of keys) if (!own(value, key)) fail(`${label} 缺少字段 ${key}`);
}

function array(value, max, label, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${label} 数量超出限制`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) fail(`${label} 必须是无额外字段的连续 JSON 数组`);
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !own(descriptor, 'value')) fail(`${label} 只能包含 JSON 数据字段`);
  }
}

function string(value, label, max, { empty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label} 必须是有效字符串且长度不超过 ${max}`);
  return value.trim();
}

function providerId(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value)) fail('provider ID 无效');
  return value;
}

function ipv6Words(host) {
  const parts = host.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts[1] ? parts[1].split(':') : [];
  const words = [...left, ...Array(parts.length === 2 ? Math.max(0, 8 - left.length - right.length) : 0).fill('0'), ...right];
  return words.length === 8 && words.every((part) => /^[0-9a-f]{1,4}$/i.test(part)) ? words.map((part) => parseInt(part, 16)) : null;
}

function inspectHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return { loopback: true };
  if (['metadata', 'metadata.google.internal', 'metadata.goog', 'instance-data', 'instance-data.ec2.internal'].includes(host) || host.endsWith('.metadata.google.internal')) fail('baseUrl 不允许访问云 metadata 地址');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 0 || (a === 169 && b === 254) || ['100.100.100.200', '168.63.129.16'].includes(host)) fail('baseUrl 不允许 metadata、link-local 或 unspecified IP');
    return { loopback: a === 127 };
  }
  if (host.includes(':')) {
    const words = ipv6Words(host);
    if (!words) fail('baseUrl IPv6 无效');
    if (words.every((word) => word === 0) || (words[0] & 0xffc0) === 0xfe80) fail('baseUrl 不允许 link-local 或 unspecified IP');
    if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
      return inspectHost(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
    }
    return { loopback: words.slice(0, 7).every((word) => word === 0) && words[7] === 1 };
  }
  return { loopback: false };
}

export function normalizeModelBaseUrl(value) {
  const input = string(value, 'baseUrl', 2000);
  let url;
  try { url = new URL(input); } catch { fail('baseUrl 无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || input.includes('?') || input.includes('#')) fail('baseUrl 必须是无凭据、query、hash 的 HTTP(S) 地址');
  inspectHost(url.hostname);
  return url.href.replace(/\/+$/, '');
}

export function validateModelSelection(value) {
  if (value === null) return null;
  object(value, ['providerId', 'modelId'], '模型选择');
  return { providerId: providerId(value.providerId), modelId: string(value.modelId, 'model ID', 200) };
}

export function validateProvider(value) {
  object(value, ['id', 'name', 'protocol', 'baseUrl', 'auth', 'allowInsecureHttpAuth', 'models'], 'provider');
  const id = providerId(value.id);
  const name = string(value.name, 'provider name', 100);
  if (!['openai', 'ollama'].includes(value.protocol)) fail('protocol 只支持 openai 或 ollama');
  if (!['none', 'required'].includes(value.auth)) fail('auth 必须是 none 或 required');
  if (typeof value.allowInsecureHttpAuth !== 'boolean') fail('allowInsecureHttpAuth 必须是 boolean');
  const baseUrl = normalizeModelBaseUrl(value.baseUrl);
  const url = new URL(baseUrl);
  if (value.auth === 'required' && url.protocol === 'http:' && !inspectHost(url.hostname).loopback && !value.allowInsecureHttpAuth) fail('非 loopback HTTP 凭据必须显式允许 allowInsecureHttpAuth');
  array(value.models, 256, 'provider models');
  const ids = new Set();
  const models = value.models.map((model) => {
    object(model, ['id', 'name', 'roles'], 'model');
    const modelId = string(model.id, 'model ID', 200);
    if (ids.has(modelId)) fail('model ID 重复');
    ids.add(modelId);
    array(model.roles, 4, 'model roles', 1);
    if (new Set(model.roles).size !== model.roles.length || model.roles.some((role) => !MODEL_ROLES.includes(role))) fail('model roles 无效');
    if (value.protocol === 'ollama' && model.roles.some((role) => role !== 'text')) fail('Ollama 仅支持 text role');
    return { id: modelId, name: string(model.name, 'model name', 100), roles: [...model.roles] };
  });
  return { id, name, protocol: value.protocol, baseUrl, auth: value.auth, allowInsecureHttpAuth: value.allowInsecureHttpAuth, models };
}

export function createDefaultModelSettings() {
  return { version: 1, providers: [], defaults: { text: null, image: null, video: null, audio: null }, general: { temperature: 0.7, voice: 'alloy', restoreLastProject: true } };
}

export function validateModelSettings(value) {
  object(value, ['version', 'providers', 'defaults', 'general'], 'model settings');
  if (value.version !== 1) fail('model settings version 必须为 1');
  array(value.providers, 32, 'providers');
  const providers = value.providers.map(validateProvider);
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  if (byId.size !== providers.length) fail('provider ID 重复');
  if (providers.reduce((count, provider) => count + provider.models.length, 0) > 512) fail('模型总数不能超过 512');
  object(value.defaults, MODEL_ROLES, 'defaults');
  const defaults = {};
  for (const role of MODEL_ROLES) {
    const selection = validateModelSelection(value.defaults[role]);
    if (selection && !byId.get(selection.providerId)?.models.some((model) => model.id === selection.modelId && model.roles.includes(role))) fail(`默认 ${role} 选择不存在或未声明该 role`);
    defaults[role] = selection;
  }
  object(value.general, ['temperature', 'voice', 'restoreLastProject'], 'general');
  if (typeof value.general.temperature !== 'number' || !Number.isFinite(value.general.temperature) || value.general.temperature < 0 || value.general.temperature > 2) fail('temperature 必须在 0 到 2 之间');
  if (typeof value.general.restoreLastProject !== 'boolean') fail('restoreLastProject 必须是 boolean');
  const general = { temperature: value.general.temperature, voice: string(value.general.voice, 'voice', 200), restoreLastProject: value.general.restoreLastProject };
  return { version: 1, providers, defaults, general };
}
