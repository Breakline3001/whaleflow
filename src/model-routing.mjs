import {validateModelSelection} from '../lib/model-settings-schema.mjs';

const MEDIA_ROLES = ['image', 'video', 'audio'];
const PASSIVE_KINDS = ['prompt', 'note', 'output', 'group', 'asset'];
const LEGACY_MODELS = ['model', 'imageModel', 'audioModel', 'videoModel'];
const selectionValue = selection => JSON.stringify({providerId: selection.providerId, modelId: selection.modelId});
const roleFor = kind => PASSIVE_KINDS.includes(kind) ? null : MEDIA_ROLES.includes(kind) ? kind : 'text';

function imageConstraints(protocol, model) {
  if (protocol !== 'openai' || !model) return null;
  const name = model.trim();
  if (/^gpt-image-/.test(name)) return {ratios: ['1:1', '3:2', '2:3'], sizes: ['auto', '1024x1024', '1536x1024', '1024x1536'], hint: 'GPT Image 支持方形、3:2 横向和 2:3 竖向；不支持精确 16:9。'};
  if (name === 'dall-e-3') return {ratios: ['1:1', '16:9', '9:16'], sizes: ['1024x1024', '1792x1024', '1024x1792'], maxBatch: 1, hint: 'DALL-E 3 仅支持 1024 方形及 1792×1024 / 1024×1792，横竖比例是 16:9 / 9:16 的近似，单次仅 1 张。'};
  if (name === 'dall-e-2') return {ratios: ['1:1'], sizes: ['256x256', '512x512', '1024x1024'], hint: 'DALL-E 2 仅支持 256、512、1024 的方形尺寸。'};
  return null;
}

/** Public catalog options only. JSON tuple encoding preserves arbitrary valid model IDs. */
export function nodeModelOptions(snapshot, kind = 'text') {
  const role = roleFor(kind);
  if (!role) return [];
  return (snapshot?.document?.providers || []).flatMap(provider => provider.models
    .filter(model => model.roles.includes(role))
    .map(model => ({
      value: selectionValue({providerId: provider.id, modelId: model.id}),
      label: `${provider.name} · ${model.name}${model.name !== model.id ? ` (${model.id})` : ''}`,
      providerId: provider.id, modelId: model.id, providerName: provider.name, modelName: model.name, protocol: provider.protocol,
    })));
}

/**
 * Renderer projection of resolveRunBindings. Public credentials are metadata, not proof
 * of authentication. Never repair missing refs or legacy overrides while reading a node.
 * Project-version validation remains the parent's/backend's responsibility.
 */
export function nodeModelState(data = {}, snapshot) {
  const kind = data.kind || 'text';
  const role = roleFor(kind);
  const passive = !role || kind === 'text' && (data.manual === true || data.textMode === 'manual') || MEDIA_ROLES.includes(kind) && Boolean(data.mediaUrl);
  const hasRef = data.modelRef !== undefined && data.modelRef !== null;
  const mode = data.provider === 'demo' ? 'demo' : hasRef ? 'ref' : 'inherit';
  const value = mode === 'ref' ? selectionValue(data.modelRef) : mode;
  const state = {role, passive: Boolean(passive), mode, value, label: '', description: '', status: '', selection: null, provider: null, model: null, protocol: null, selectedModel: null, error: '', imageRules: null};
  const finish = (status, label, description = label, error = '') => ({...state, status, label, description, error});
  if (passive) return finish('passive', kind === 'text' ? '手写文本' : data.mediaUrl ? '已导入素材' : '内容透传', kind === 'text' ? '手写文本直接透传，不调用模型；选择生成模型才会切换为生成。' : '当前节点不调用模型服务，运行直接透传内容。');
  if (mode === 'demo') { state.protocol = 'demo'; return finish('demo', 'DEMO · 演示', 'DEMO · 本地确定性演示，非真实 AI；不会使用已保存的模型服务。'); }
  if (!snapshot?.document) return finish('loading', '模型设置未载入', '模型设置尚未载入，不会使用旧全局服务地址。');
  let selection;
  try { selection = hasRef ? validateModelSelection(data.modelRef) : snapshot.document.defaults[role]; }
  catch { return finish('invalid-ref', '模型引用无效', '已保留原引用；请明确重新选择模型。', '模型选择字段无效'); }
  state.selection = selection ? {...selection} : null;
  if (!selection) {
    if (!snapshot.document.providers.length && !hasRef) { state.protocol = 'demo'; return finish('demo', 'DEMO · 演示', '未配置任何提供商，继承本地 DEMO；非真实 AI。'); }
    const error = `节点缺少 ${role} 默认模型选择`;
    return finish('unconfigured', '未配置默认模型', `${error}；请设置默认值或明确选择模型，运行预检将报错。`, error);
  }
  const provider = snapshot.document.providers.find(item => item.id === selection.providerId);
  if (!provider) return finish('missing-provider', '提供商已缺失', `保留引用：${selection.providerId} / ${selection.modelId}；请重新选择。`, '节点引用的提供商不存在');
  state.provider = provider;
  state.protocol = provider.protocol;
  if (data.provider && data.provider !== provider.protocol) return finish('protocol-mismatch', '旧服务协议不匹配', '旧节点服务协议与所选提供商不同；请明确重新应用模型或继承默认。', '旧节点 provider 协议与所选提供商不匹配');
  const legacyField = role === 'text' ? 'model' : `${role}Model`;
  const modelId = hasRef ? selection.modelId : data[legacyField]?.trim() || selection.modelId;
  const model = provider.models.find(item => item.id === modelId);
  if (!model || !model.roles.includes(role)) return finish('missing-model', '模型已缺失或角色不匹配', `保留选择：${provider.name} / ${modelId}；请重新选择所需角色的目录模型。`, '节点模型不存在或未声明所需 role');
  state.model = model;
  state.selectedModel = model.id;
  state.imageRules = role === 'image' ? imageConstraints(provider.protocol, model.id) : null;
  const name = `${provider.name} · ${model.name}`;
  const source = hasRef ? '明确选择' : data[legacyField]?.trim() ? '继承提供商 · 保留旧模型覆盖' : '继承默认';
  if (provider.auth === 'required' && snapshot.credentials?.[provider.id]?.configured !== true) return finish('missing-credential', name, `${source}：${name}；未保存凭据，运行预检将报错。`, '提供商缺少已绑定凭据；不会使用环境变量回退');
  return finish('ready', name, `${source}：${name} · ${provider.protocol === 'ollama' ? 'Ollama' : 'OpenAI 兼容'}${provider.auth === 'required' ? ' · 凭据已保存（未经服务认证）' : ' · 无认证配置'}`);
}

/** Only call on an intentional user choice; inheritance must never activate manual text. */
export function nodeModelPatch(value) {
  const cleared = Object.fromEntries(LEGACY_MODELS.map(key => [key, undefined]));
  if (value === 'inherit') return {...cleared, provider: undefined, modelRef: null};
  if (value === 'demo') return {...cleared, provider: 'demo', modelRef: null, manual: undefined, textMode: undefined};
  let selection;
  try { selection = validateModelSelection(JSON.parse(value)); } catch { throw new Error('模型选择无效'); }
  if (!selection) throw new Error('模型选择无效');
  return {...cleared, provider: undefined, modelRef: selection, manual: undefined, textMode: undefined};
}
