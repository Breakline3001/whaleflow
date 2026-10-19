// Browser-safe counterpart of the public persistence schema. No environment or host keys.
import {validateGenerationOptions} from '../lib/generation-options.mjs';
import {validateModelSelection} from '../lib/model-settings-schema.mjs';
import {validateCreativeDocument} from '../lib/creative-schema.mjs';
import {validateDirectorStage} from '../lib/director-stage.mjs';

export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
export const MAX_PROJECT_BYTES = 100 * 1024 * 1024;
const SECRET_KEY = /(?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|authorization|password|secret|token)$/i;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };
const encoder = new TextEncoder();
export function assertString(value, field, max) {
  if (typeof value !== 'string' || value.length > max) fail(`${field} 必须是长度不超过 ${max} 的字符串。`);
}

export function assertJsonData(value, depth = 0, seen = new Set()) {
  if (depth > 40) fail('项目嵌套层级过深。');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') fail('项目只能包含 JSON 数据。');
  if (seen.has(value)) fail('项目包含循环引用。');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('项目对象必须是普通 JSON 对象。');
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key) || /^(?:credentialRef|credentials|vault|encryptedCredentials|modelSettings)$/i.test(key)) fail('项目不允许保存凭据或模型服务配置；请使用本机设置。');
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('项目包含不安全的对象字段。');
    if (child === undefined && !Array.isArray(value)) continue;
    assertJsonData(child, depth + 1, seen);
  }
  seen.delete(value);
}

export function assertProjectSize(project) {
  if (encoder.encode(JSON.stringify(project)).byteLength > MAX_PROJECT_BYTES) fail('项目超过 100 MiB 限制。');
}

function assertAudioSignature(prefix, length, mime) {
  const ascii = (start, end) => Array.from(prefix.slice(start, end), byte => String.fromCharCode(byte & 127)).join('');
  const mp3 = length >= 3 && (ascii(0, 3) === 'ID3' || (prefix[0] === 0xff && (prefix[1] & 0xe0) === 0xe0 && (prefix[1] & 0x06) !== 0 && (prefix[2] & 0xf0) !== 0xf0 && (prefix[2] & 0x0c) !== 0x0c));
  const checks = {
    'audio/mpeg': mp3, 'audio/mp3': mp3,
    'audio/wav': length >= 44 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE',
    'audio/ogg': length >= 27 && ascii(0, 4) === 'OggS' && prefix[4] === 0,
    'audio/mp4': length >= 16 && ascii(4, 8) === 'ftyp' && /M4A |M4B |isom|iso2|mp4[12]/.test(ascii(8, 32)),
    'audio/flac': length >= 8 && ascii(0, 4) === 'fLaC',
  };
  const canonical = {'audio/x-wav': 'audio/wav', 'audio/x-m4a': 'audio/mp4', 'audio/x-flac': 'audio/flac'}[mime] || mime;
  if (!checks[canonical]) fail('音频内容与格式不一致或文件已损坏。');
}

export function validateMediaUrl(value, kind) {
  assertString(value, 'mediaUrl', MAX_MEDIA_BYTES * 2);
  const match = /^data:(image\/(?:png|jpeg|webp|gif|avif|bmp|svg\+xml)|video\/(?:mp4|webm|quicktime|ogg)|audio\/(?:mpeg|mp3|wav|x-wav|ogg|mp4|x-m4a|flac|x-flac))(;charset=utf-8)?(;base64)?,([\s\S]*)$/i.exec(value);
  if (!match || !match[1].toLowerCase().startsWith(`${kind}/`)) fail(`${kind} 媒体必须是自包含 data URL。`);
  let bytes;
  if (match[3]) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(match[4]) || match[4].length % 4 !== 0) fail('媒体 base64 数据无效。');
    bytes = match[4].length / 4 * 3 - (match[4].endsWith('==') ? 2 : match[4].endsWith('=') ? 1 : 0);
  } else {
    try { bytes = encoder.encode(decodeURIComponent(match[4])).byteLength; } catch { fail('媒体 data URL 编码无效。'); }
  }
  if (bytes > MAX_MEDIA_BYTES) fail('单个媒体超过 20 MiB。');
  if (kind === 'audio') {
    if (!match[3]) fail('音频必须使用 base64 data URL。');
    // Only the signature prefix is decoded; do not allocate another 20 MiB buffer.
    const prefix = Uint8Array.from(atob(match[4].slice(0, 64)), character => character.charCodeAt(0));
    assertAudioSignature(prefix, bytes, match[1].toLowerCase());
  }
  return value;
}

export function validateNodeData(data, version = 1) {
  assertString(data.title, '节点标题', 500);
  assertString(data.content, '节点内容', 1_000_000);
  if (data.modelRef !== undefined) {
    if (version < 2 && data.modelRef !== null) fail('模型引用需要 version: 2 项目，旧版不能静默执行新语义。');
    validateModelSelection(data.modelRef);
  }
  if (data.model !== undefined) assertString(data.model, '节点模型', 200);
  if (data.provider !== undefined && !['demo', 'ollama', 'openai'].includes(data.provider)) fail('节点 provider 无效。');
  if (data.creative !== undefined) {
    if(version !== 3 || !['script','shots'].includes(data.kind)) fail('创作文档需要 version:3 的脚本或分镜节点');
    const result=validateCreativeDocument(data.creative);if(!result.valid)fail(result.errors.join('；'));
  }
  if(data.directorStage !== undefined){
    if(version !== 3 || data.kind !== 'director') fail('三维场景需要 version:3 的导演节点');
    const result=validateDirectorStage(data.directorStage);if(!result.valid)fail(result.errors.join('；'));
  }
  if(data.referenceImage!==undefined){if(version!==3||!['image','video'].includes(data.kind))fail('参考图需要 version:3 的图片或视频节点');validateMediaUrl(data.referenceImage,'image');if(!/^data:image\/(?:png|jpeg|webp);base64,/i.test(data.referenceImage))fail('参考图只支持 PNG/JPEG/WebP base64');}
  validateGenerationOptions(data);
  if (data.mediaUrl !== undefined && data.mediaUrl !== '') {
    if (!['image', 'video', 'audio', 'asset'].includes(data.kind)) fail('只有 image/video/audio/asset 节点可包含 mediaUrl。');
    const kind = data.kind === 'asset' ? /^data:(image|video|audio)\//i.exec(data.mediaUrl)?.[1]?.toLowerCase() : data.kind;
    if (!kind) fail('asset 素材类型无效。');
    validateMediaUrl(data.mediaUrl, kind);
  }
  if (data.lastOutput !== undefined) {
    const output = data.lastOutput;
    if (!isObject(output)) fail('lastOutput 必须是对象。');
    for (const kind of ['image', 'video', 'audio']) if (output[kind] !== undefined) validateMediaUrl(output[kind], kind);
    if (output.images !== undefined) {
      if (!Array.isArray(output.images) || output.images.length > 4) fail('lastOutput.images 最多包含 4 张图片。');
      for (const image of output.images) validateMediaUrl(image, 'image');
    }
  }
}
