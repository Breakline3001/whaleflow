import React, {useEffect, useId, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {X, ChevronDown, ChevronRight, Plus, Trash2, Settings2, Server, SlidersHorizontal, Info, KeyRound, RefreshCw} from 'lucide-react';
import {validateModelSettings} from '../lib/model-settings-schema.mjs';
import './model-settings.css';

const ROLES = [['text', '文本'], ['image', '图像'], ['video', '视频'], ['audio', '音频']];
const SECTIONS = [['general', '通用', Settings2], ['providers', '模型服务', Server], ['defaults', '默认模型', SlidersHorizontal], ['about', '关于', Info]];
const clone = value => JSON.parse(JSON.stringify(value));
const signature = value => JSON.stringify(value);
const bridge = () => window.desktop;
const supported = method => typeof bridge()?.[method] === 'function';
let requestSerial = 0;

function publicSnapshot(value) {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 || !value.document) throw new Error('INVALID_SNAPSHOT');
  const document = validateModelSettings(value.document);
  const credentials = Object.fromEntries(document.providers.map(provider => [provider.id, {
    configured: value.credentials?.[provider.id]?.configured === true,
    source: value.credentials?.[provider.id]?.configured === true ? 'saved' : 'none',
  }]));
  return {revision: value.revision, document, credentials};
}

function isConflict(error) {
  return error?.code === 'REVISION_CONFLICT' || /\bREVISION_CONFLICT\b/.test(String(error?.message || ''));
}

// Never render an untrusted bridge error: native/provider diagnostics may contain URLs or secrets.
function failureMessage(error, operation) {
  if (isConflict(error)) return '设置已被其他窗口修改。草稿完整保留；请重新读取后再编辑，不能覆盖新版本。';
  const messages = {
    INVALID_SNAPSHOT: '宿主返回的设置快照无效，未替换当前草稿。',
    METHOD_UNAVAILABLE: '当前宿主尚未提供此设置接口，请使用已集成的桌面版本。',
    MISSING_CREDENTIAL: '此服务尚未配置凭据，请先打开原生凭据对话框。',
    CREDENTIAL_REQUIRED: '此服务尚未配置凭据，请先打开原生凭据对话框。',
    TIMEOUT: '获取模型列表超时；手填目录和现有草稿不受影响。',
    CANCELLED: '模型列表请求已取消，目录未改变。',
  };
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = typeof error?.message === 'string' ? error.message : '';
  return (Object.hasOwn(messages, code) && messages[code]) || (Object.hasOwn(messages, message) && messages[message]) || `${operation}失败。当前草稿未丢失，请检查配置后重试。`;
}

function clearInvalidDefaults(document) {
  for (const [role] of ROLES) {
    const selection = document.defaults[role];
    if (selection && !document.providers.some(provider => provider.id === selection.providerId && provider.models.some(model => model.id === selection.modelId && model.roles.includes(role)))) document.defaults[role] = null;
  }
  return document;
}

function RoleChecks({roles, protocol, onChange, disabled, prefix, candidate = false}) {
  return <div className="ms-roles" role="group" aria-label={candidate ? '候选模型角色声明' : '模型角色声明'}>
    {ROLES.map(([role, label]) => <label key={role}><input type="checkbox" data-testid={`${prefix}-role-${role}`} checked={roles.includes(role)} disabled={disabled || (protocol === 'ollama' && role !== 'text')} onChange={event => onChange(event.target.checked ? [...roles, role] : roles.filter(item => item !== role))}/>{label}</label>)}
  </div>;
}

/** Public settings only. Credentials are configured exclusively in the C# native dialog. */
export function ModelSettings({snapshot, onSnapshot, onClose, running = false}) {
  const uid = useId();
  const initial = useRef(null);
  if (!initial.current && snapshot) {
    try { initial.current = publicSnapshot(snapshot); } catch { /* The loading path reports invalid snapshots without replacing them. */ }
  }
  const [base, setBase] = useState(initial.current);
  const [draft, setDraft] = useState(() => initial.current ? clone(initial.current.document) : null);
  const [section, setSection] = useState('general');
  const [editing, setEditing] = useState(null);
  const [preset, setPreset] = useState('openai');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(!initial.current);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [metadata, setMetadata] = useState(null);
  const [fetching, setFetching] = useState(false);
  const [query, setQuery] = useState('');
  const panelRef = useRef(null);
  const confirmRef = useRef(null);
  const mounted = useRef(true);
  const requestRef = useRef(null);
  const busyRef = useRef('');
  const loadSerial = useRef(0);
  const latestRevision = useRef(initial.current?.revision ?? 0);
  // Separate row identity from editable IDs so a new duplicate ID never becomes a saved row.
  const origins = useRef(initial.current?.document.providers.map(provider => provider.id) || []);
  const callbacks = useRef({onSnapshot, onClose});
  callbacks.current = {onSnapshot, onClose};
  const dirty = Boolean(base && draft && signature(base.document) !== signature(draft));
  const pendingCandidates = Boolean(metadata?.models.some(model => model.selected));
  const stateRef = useRef(null);
  stateRef.current = {base, draft, dirty, conflict, confirm, section, editing, pendingCandidates, running};
  const actionsRef = useRef({});
  const locked = Boolean(busy || loading);

  function cancelMetadata(clear = true) {
    const request = requestRef.current;
    requestRef.current = null;
    if (mounted.current) {
      setFetching(false);
      if (clear) { setMetadata(null); setQuery(''); }
    }
    if (request && supported('cancelProviderModels')) {
      try { Promise.resolve(bridge().cancelProviderModels(request.requestId)).catch(() => {}); } catch { /* Invalidated locally even if native cancellation fails. */ }
    }
  }

  function accept(value, notifyParent = true) {
    const next = publicSnapshot(value);
    if (next.revision < latestRevision.current) {
      const failure = new Error('REVISION_CONFLICT');
      failure.code = 'REVISION_CONFLICT';
      throw failure;
    }
    latestRevision.current = next.revision;
    cancelMetadata();
    origins.current = next.document.providers.map(provider => provider.id);
    setBase(next);
    setDraft(clone(next.document));
    setConflict(false);
    setError('');
    if (notifyParent) callbacks.current.onSnapshot?.(next);
    return next;
  }

  function report(errorValue, operation) {
    if (!mounted.current) return;
    setError(failureMessage(errorValue, operation));
    setNotice('');
    if (isConflict(errorValue)) { setConflict(true); cancelMetadata(); }
  }

  async function readSettings() {
    if (busyRef.current) return;
    const serial = ++loadSerial.current;
    busyRef.current = 'load';
    setBusy('load');
    setLoading(true);
    setError('');
    cancelMetadata();
    try {
      if (!supported('getModelSettings')) throw new Error('METHOD_UNAVAILABLE');
      const answer = await bridge().getModelSettings();
      if (!mounted.current || serial !== loadSerial.current) return;
      accept(answer);
      setNotice('已读取本机保存的设置。');
      setEditing(null);
    } catch (failure) { if (serial === loadSerial.current) report(failure, '读取设置'); }
    finally {
      if (mounted.current && serial === loadSerial.current) { busyRef.current = ''; setBusy(''); setLoading(false); }
    }
  }

  function mutate(change) {
    if (busyRef.current || !stateRef.current.draft) return;
    cancelMetadata();
    setDraft(previous => clearInvalidDefaults(change(clone(previous))));
    setNotice('');
    if (!stateRef.current.conflict) setError('');
  }

  function updateProvider(index, change) {
    mutate(document => { document.providers[index] = change(document.providers[index], document); return document; });
  }

  async function save() {
    const current = stateRef.current;
    if (busyRef.current || !current.base || !current.dirty || current.conflict) return;
    let document;
    try { document = validateModelSettings(current.draft); }
    catch {
      setError('设置校验未通过。请检查服务 ID/地址、重复模型、角色及默认选择；每个模型至少声明一个角色。草稿已保留。');
      setNotice('');
      return;
    }
    busyRef.current = 'save';
    setBusy('save');
    setError('');
    cancelMetadata();
    try {
      if (!supported('saveModelSettings')) throw new Error('METHOD_UNAVAILABLE');
      const answer = await bridge().saveModelSettings({expectedRevision: current.base.revision, document});
      if (!mounted.current) return;
      accept(answer);
      setNotice('设置已保存。凭据状态不代表供应商认证或额度已验证。');
    } catch (failure) { report(failure, '保存设置'); }
    finally { if (mounted.current) { busyRef.current = ''; setBusy(''); } }
  }

  async function configureCredential(providerId, action) {
    const current = stateRef.current;
    if (busyRef.current || !current.base || current.dirty || current.conflict) return;
    busyRef.current = 'credential';
    setBusy('credential');
    setError('');
    cancelMetadata();
    try {
      if (!supported('configureModelCredential')) throw new Error('METHOD_UNAVAILABLE');
      const answer = await bridge().configureModelCredential(providerId, current.base.revision, action);
      if (!mounted.current) return;
      accept(answer);
      setNotice(answer.cancelled ? '已取消原生凭据对话框，设置未改变。' : action === 'clear' ? '已清除本程序保存的凭据。' : '原生凭据操作已完成；未验证供应商连接或额度。');
    } catch (failure) { report(failure, '凭据操作'); }
    finally { if (mounted.current) { busyRef.current = ''; setBusy(''); } }
  }

  function requestClose() {
    if (busyRef.current) { setNotice('正在处理设置操作，请等待完成后关闭。'); return; }
    const current = stateRef.current;
    if (current.dirty || current.pendingCandidates) setConfirm({type: 'close', title: '放弃未保存的修改？', text: '服务、目录、默认模型及通用设置中的草稿将被丢弃。已完成的原生凭据操作不会撤销。', action: '放弃并关闭'});
    else { cancelMetadata(); callbacks.current.onClose?.(); }
  }

  function requestReload() {
    if (busyRef.current) return;
    if (stateRef.current.dirty || stateRef.current.pendingCandidates) setConfirm({type: 'reload', title: '丢弃草稿并重新读取？', text: '将读取宿主当前版本。未保存的编辑和候选选择会丢失；读取失败时仍保留现有草稿。', action: '重新读取'});
    else readSettings();
  }

  function confirmAction() {
    const value = stateRef.current.confirm;
    if (!value) return;
    setConfirm(null);
    if (value.type === 'close') { cancelMetadata(); callbacks.current.onClose?.(); }
    else if (value.type === 'reload') readSettings();
    else if (value.type === 'credential-clear') configureCredential(value.providerId, 'clear');
    else if (value.type === 'remove-provider') {
      origins.current.splice(value.index, 1);
      mutate(document => { document.providers.splice(value.index, 1); return document; });
      setEditing(null);
    } else if (value.type === 'remove-model') {
      updateProvider(value.index, provider => ({...provider, models: provider.models.filter((_, at) => at !== value.modelIndex)}));
    } else if (value.type === 'ollama') updateProvider(value.index, provider => ({...provider, protocol: 'ollama', models: provider.models.map(model => ({...model, roles: ['text']}))}));
  }

  actionsRef.current = {requestClose, save};

  useEffect(() => {
    mounted.current = true;
    const oldFocus = document.activeElement;
    const root = document.getElementById('root');
    const wasInert = root?.hasAttribute('inert');
    root?.setAttribute('inert', '');
    panelRef.current?.querySelector('[data-ms-nav="general"]')?.focus();
    const keydown = event => {
      const state = stateRef.current;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (state.confirm) setConfirm(null);
        else if (!event.repeat) actionsRef.current.requestClose();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && ['enter', 's', 'o', 'n'].includes(event.key.toLowerCase())) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.key.toLowerCase() === 's' && !event.repeat && !state.confirm) actionsRef.current.save();
        return;
      }
      if (event.key === 'Tab') {
        const scope = state.confirm ? confirmRef.current : panelRef.current;
        const elements = [...(scope?.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]') || [])].filter(element => element.getClientRects().length > 0);
        if (!elements.length) { event.preventDefault(); scope?.focus(); }
        else {
          const index = elements.indexOf(document.activeElement);
          if (index < 0 || (!event.shiftKey && index === elements.length - 1) || (event.shiftKey && index === 0)) {
            event.preventDefault(); (event.shiftKey ? elements[elements.length - 1] : elements[0]).focus();
          }
        }
      }
      // React stops bubbling inside the portal. Also shield stray focus outside it.
      if (!panelRef.current?.contains(event.target)) event.stopImmediatePropagation();
    };
    const keyup = event => { if (!panelRef.current?.contains(event.target) || event.key === 'Escape') event.stopImmediatePropagation(); };
    const beforeUnload = event => {
      if (stateRef.current.dirty || stateRef.current.pendingCandidates || busyRef.current) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('keyup', keyup, true);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      mounted.current = false;
      ++loadSerial.current;
      busyRef.current = '';
      cancelMetadata();
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('keyup', keyup, true);
      window.removeEventListener('beforeunload', beforeUnload);
      if (!wasInert) root?.removeAttribute('inert');
      if (oldFocus?.isConnected) oldFocus.focus();
    };
  }, []);

  useEffect(() => {
    if (!snapshot) {
      if (!stateRef.current.base && !busyRef.current) readSettings();
      return;
    }
    let incoming;
    try { incoming = publicSnapshot(snapshot); }
    catch {
      report(new Error('INVALID_SNAPSHOT'), '读取设置');
      if (!stateRef.current.base && !busyRef.current) setLoading(false);
      return;
    }
    const current = stateRef.current;
    latestRevision.current = Math.max(latestRevision.current, incoming.revision);
    if (current.base && incoming.revision <= current.base.revision) return;
    if (current.dirty || busyRef.current) {
      setConflict(true);
      setError('宿主设置版本已改变。当前草稿已保留；请重新读取，不能覆盖较新的版本。');
      cancelMetadata();
    } else accept(incoming, false);
  }, [snapshot]);

  useEffect(() => {
    if (!confirm) return;
    const previous = document.activeElement;
    confirmRef.current?.querySelector('[data-testid="settings-confirm-cancel"]')?.focus();
    return () => { if (previous?.isConnected && !previous.disabled) previous.focus(); };
  }, [confirm]);

  function addProvider() {
    if (!draft || locked || draft.providers.length >= 32) return;
    const stem = preset === 'ollama' ? 'ollama' : preset === 'custom' ? 'custom' : 'openai';
    let serial = 1;
    while (draft.providers.some(provider => provider.id === `${stem}-${serial}`)) serial++;
    const index = draft.providers.length;
    origins.current.push(null);
    mutate(document => {
      document.providers.push({id: `${stem}-${serial}`, name: preset === 'ollama' ? 'Ollama' : preset === 'custom' ? '自定义服务' : 'OpenAI 兼容', protocol: preset === 'ollama' ? 'ollama' : 'openai', baseUrl: preset === 'ollama' ? 'http://127.0.0.1:11434' : preset === 'custom' ? '' : 'https://api.openai.com/v1', auth: preset === 'ollama' ? 'none' : 'required', allowInsecureHttpAuth: false, models: []});
      return document;
    });
    setEditing(index);
    setTimeout(() => panelRef.current?.querySelector(`[data-testid="provider-name-${index}"]`)?.focus(), 0);
  }

  function changeSection(value) {
    if (value !== section) { cancelMetadata(); setSection(value); }
  }

  function toggleProvider(index) {
    cancelMetadata();
    setEditing(editing === index ? null : index);
  }

  async function listModels(index) {
    const current = stateRef.current;
    const provider = current.draft?.providers[index];
    const saved = current.base?.document.providers.find(item => item.id === origins.current[index]);
    if (busyRef.current || current.conflict || !provider || !saved || signature(provider) !== signature(saved)) return;
    cancelMetadata();
    if (!supported('listProviderModels')) { report(new Error('METHOD_UNAVAILABLE'), '获取模型列表'); return; }
    const request = {requestId: `settings-${Date.now()}-${++requestSerial}`, providerId: provider.id, revision: current.base.revision, providerSignature: signature(provider), index};
    requestRef.current = request;
    setFetching(true);
    setError('');
    setNotice('');
    try {
      const answer = await bridge().listProviderModels({providerId: provider.id, expectedRevision: request.revision, requestId: request.requestId});
      if (!mounted.current || requestRef.current !== request) return;
      const now = stateRef.current;
      if (now.base?.revision !== request.revision || now.section !== 'providers' || now.editing !== index || signature(now.draft.providers[index]) !== request.providerSignature || answer?.requestId !== request.requestId || answer?.settingsRevision !== request.revision || answer?.providerId !== request.providerId) {
        setNotice('已忽略过期的模型列表结果，目录未改变。');
        return;
      }
      if (answer.source !== 'metadata' || !Array.isArray(answer.models) || answer.models.length > 512) throw new Error('INVALID_METADATA');
      const unique = new Set();
      const models = answer.models.filter(model => model && typeof model.id === 'string' && model.id.trim() && model.id.length <= 200 && !unique.has(model.id) && unique.add(model.id)).map(model => ({id: model.id, name: typeof model.name === 'string' && model.name.trim() && model.name.length <= 100 ? model.name : model.id.slice(0, 100), selected: false, roles: []}));
      setMetadata({providerId: provider.id, revision: request.revision, index, models});
      setNotice(models.length ? '候选仅包含 ID 和名称。请自行声明角色并加入草稿；不会修改已有手填模型。' : '服务返回的模型列表为空；仍可手填模型目录。');
    } catch (failure) { if (requestRef.current === request) report(failure, '获取模型列表'); }
    finally { if (mounted.current && requestRef.current === request) { requestRef.current = null; setFetching(false); } }
  }

  function addCandidates() {
    if (!metadata || !draft || locked || conflict || metadata.revision !== base?.revision) return;
    const provider = draft.providers[metadata.index];
    if (!provider || provider.id !== metadata.providerId) return;
    const selected = metadata.models.filter(model => model.selected && !provider.models.some(existing => existing.id === model.id));
    if (!selected.length || selected.some(model => !model.roles.length)) return;
    const total = draft.providers.reduce((sum, item) => sum + item.models.length, 0);
    if (provider.models.length + selected.length > 256 || total + selected.length > 512) { setError('目录超出上限：每服务最多 256 个模型，全部服务合计最多 512 个。请减少候选选择。'); return; }
    updateProvider(metadata.index, item => ({...item, models: [...item.models, ...selected.map(({id, name, roles}) => ({id, name, roles}))]}));
    setNotice('所选候选已加入草稿，已有模型未覆盖。请保存设置使其生效。');
  }

  function renderCandidates(provider, index) {
    if (!metadata || metadata.index !== index || metadata.providerId !== provider.id) return null;
    const selected = metadata.models.filter(model => model.selected);
    const filtered = metadata.models.filter(model => `${model.id} ${model.name}`.toLowerCase().includes(query.toLowerCase()));
    return <section className="ms-candidates" aria-label="模型候选" data-testid="model-candidates">
      <h4>服务元数据候选</h4><p className="ms-hint">不推断图像、视频或音频能力。角色需按服务实际支持声明；已有 ID 不会被覆盖。</p>
      <input aria-label="筛选候选模型" placeholder="搜索 ID 或名称" value={query} onChange={event => setQuery(event.target.value)}/>
      <div className="ms-candidate-list">{filtered.map(model => {
        const existing = provider.models.some(item => item.id === model.id);
        const patch = change => setMetadata(previous => ({...previous, models: previous.models.map(item => item.id === model.id ? {...item, ...change} : item)}));
        return <div className="ms-candidate" key={model.id}><label className="ms-candidate-name"><input type="checkbox" checked={model.selected} disabled={locked || existing} aria-label={`选择候选 ${model.id}`} onChange={event => patch({selected: event.target.checked})}/><span><code>{model.id}</code><small>{model.name}{existing ? ' · 已在目录中' : ''}</small></span></label>{!existing && model.selected && <RoleChecks roles={model.roles} protocol={provider.protocol} disabled={locked} onChange={roles => patch({roles})} prefix={`candidate-${model.id}`} candidate/>}</div>;
      })}{!filtered.length && <p className="ms-hint">无匹配候选</p>}</div>
      <div className="ms-inline-actions"><button type="button" className="ms-secondary" disabled={locked || !selected.length || selected.some(model => !model.roles.length)} data-testid="model-candidates-apply" onClick={addCandidates}>加入草稿（{selected.length}）</button><button type="button" className="ms-text-button" onClick={() => { setMetadata(null); setQuery(''); }}>丢弃候选</button></div>
    </section>;
  }

  function renderProvider(provider, index) {
    const saved = base.document.providers.find(item => item.id === origins.current[index]);
    const unchanged = saved && signature(saved) === signature(provider);
    const configured = base.credentials[provider.id]?.configured === true;
    const bindingChanged = saved && (saved.baseUrl !== provider.baseUrl || saved.protocol !== provider.protocol || saved.auth !== provider.auth);
    const credentialLabel = !saved ? '保存后配置凭据' : bindingChanged ? '连接配置已改，保存后需重新配置凭据' : provider.auth === 'none' ? '无需凭据' : configured ? '已配置 · 未验证连接' : '未配置凭据';
    const total = draft.providers.reduce((sum, item) => sum + item.models.length, 0);
    const open = editing === index;
    const credentialDisabled = locked || dirty || conflict || !saved;
    return <li className={`ms-provider ${open ? 'ms-provider-open' : ''}`} key={index} data-testid={`provider-row-${index}`}>
      <div className="ms-provider-head"><button type="button" className="ms-provider-toggle" aria-expanded={open} aria-controls={`${uid}-provider-${index}`} onClick={() => toggleProvider(index)}><span className="ms-provider-title"><strong>{provider.name || '未命名服务'}</strong><small>{provider.id || '未设置 ID'} · {provider.protocol === 'ollama' ? 'Ollama' : 'OpenAI 兼容'}</small></span><span className={`ms-status-dot ${!bindingChanged && (provider.auth === 'none' || configured) && saved ? 'ms-ready' : ''}`} aria-label={credentialLabel}/>{open ? <ChevronDown size={16}/> : <ChevronRight size={16}/>}</button><button type="button" className="ms-icon" disabled={locked} aria-label={`删除服务 ${provider.name || provider.id}`} data-testid={`provider-delete-${index}`} onClick={() => setConfirm({type: 'remove-provider', index, title: `删除“${provider.name || provider.id}”？`, text: '将从草稿中删除服务、模型及其默认角色引用。保存后同时清除此服务在本程序中的凭据；不会删除远端模型。', action: '从草稿删除'})}><Trash2 size={15}/></button></div>
      {open && <div className="ms-provider-editor" id={`${uid}-provider-${index}`} data-testid="provider-editor">
        {!saved && <p className="ms-hint">新增服务尚未保存。保存后才能配置原生凭据或获取元数据。</p>}
        <div className="ms-two-columns"><label>显示名称<input data-testid={`provider-name-${index}`} value={provider.name} maxLength={100} disabled={locked} onChange={event => updateProvider(index, item => ({...item, name: event.target.value}))}/></label><label>服务 ID<input data-testid={`provider-id-${index}`} value={provider.id} maxLength={64} disabled={locked || Boolean(saved)} spellCheck="false" pattern="[a-z][a-z0-9_-]{0,63}" aria-describedby={`${uid}-id-hint`} onChange={event => updateProvider(index, item => {
          const id = event.target.value;
          return {...item, id};
        })}/></label></div>
        <p className="ms-hint" id={`${uid}-id-hint`}>ID 使用小写字母开头及小写字母、数字、下划线或短横线；已保存 ID 固定。</p>
        <section className="ms-credential" aria-label="原生凭据管理"><div><KeyRound size={16}/><strong>服务凭据</strong><span data-testid={`provider-credential-status-${index}`}>{credentialLabel}</span></div><p className="ms-hint">网页不输入、读取或显示密钥。按钮仅打开 C# 原生对话框；需先保存全部草稿。</p><div className="ms-inline-actions"><button type="button" className="ms-secondary" disabled={credentialDisabled || provider.auth !== 'required'} data-testid={`provider-credential-set-${index}`} onClick={() => configureCredential(provider.id, 'set')}>{configured ? '更换凭据（原生对话框）' : '配置凭据（原生对话框）'}</button><button type="button" className="ms-text-button" disabled={credentialDisabled || !configured} data-testid={`provider-credential-clear-${index}`} onClick={() => setConfirm({type: 'credential-clear', providerId: provider.id, title: '清除此服务的凭据？', text: '仅删除本程序保存的凭据，不删除服务目录，也不撤销服务商侧凭据。此操作立即保存。', action: '清除凭据'})}>清除凭据</button></div></section>
        <details className="ms-details" open={!saved || undefined}><summary>自定义设置</summary><div className="ms-detail-body"><label>API 协议<select data-testid={`provider-protocol-${index}`} value={provider.protocol} disabled={locked} onChange={event => {
          const protocol = event.target.value;
          if (protocol === 'ollama' && provider.models.some(model => model.roles.some(role => role !== 'text'))) setConfirm({type: 'ollama', index, title: '切换为 Ollama？', text: 'Ollama 仅支持文本。所有目录模型将改为文本角色，同时清除该服务的图像、视频、音频默认引用。原地址保留，请自行核对。', action: '切换并调整角色'});
          else updateProvider(index, item => ({...item, protocol}));
        }}><option value="openai">OpenAI 兼容（Chat Completions）</option><option value="ollama">Ollama（仅文本）</option></select></label><label>服务地址<input data-testid={`provider-url-${index}`} value={provider.baseUrl} disabled={locked} maxLength={2000} spellCheck="false" placeholder={provider.protocol === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.example.com/v1'} onChange={event => updateProvider(index, item => ({...item, baseUrl: event.target.value}))}/></label><p className="ms-hint">仅 HTTP(S)，不含用户名、密码、查询参数或片段。地址或协议变更后，旧凭据绑定失效。</p><label>认证<select data-testid={`provider-auth-${index}`} value={provider.auth} disabled={locked} onChange={event => updateProvider(index, item => ({...item, auth: event.target.value, ...(event.target.value === 'none' ? {allowInsecureHttpAuth: false} : {})}))}><option value="required">需要凭据</option><option value="none">无认证</option></select></label><label className="ms-checkbox"><input type="checkbox" checked={provider.allowInsecureHttpAuth} disabled={locked || provider.auth === 'none'} data-testid={`provider-insecure-${index}`} onChange={event => updateProvider(index, item => ({...item, allowInsecureHttpAuth: event.target.checked}))}/><span>显式允许向非本机 HTTP 服务发送凭据</span></label><p className="ms-hint">仅在信任局域网或网关时启用。HTTP 不加密传输；默认拒绝发送凭据到非回环 HTTP 地址。</p></div></details>
        <details className="ms-details" open><summary>模型目录（{provider.models.length}）</summary><div className="ms-detail-body"><p className="ms-hint">角色是用户声明，不代表服务已验证支持。修改 ID、删除模型或取消角色会清除失效的默认选择。</p>
          <div className="ms-inline-actions"><button type="button" className="ms-secondary" data-testid={`provider-list-models-${index}`} disabled={locked || conflict || !unchanged || fetching} onClick={() => listModels(index)}><RefreshCw size={14}/>{fetching && editing === index ? '正在获取…' : '获取已保存服务的模型'}</button>{fetching && editing === index && <button type="button" className="ms-text-button" data-testid="provider-list-cancel" onClick={() => { cancelMetadata(); setNotice('已取消模型列表请求，目录未改变。'); }}>取消请求</button>}</div>
          {!unchanged && <p className="ms-hint">先保存此服务的修改，才能获取其元数据。手填目录始终可用。</p>}
          {renderCandidates(provider, index)}
          <div className="ms-models">{provider.models.map((model, modelIndex) => <fieldset className="ms-model" key={modelIndex} data-testid={`model-row-${index}-${modelIndex}`} disabled={locked}><legend>模型 {modelIndex + 1}</legend><div className="ms-model-head"><strong>{model.name || model.id || '新模型'}</strong><button type="button" className="ms-icon" aria-label={`删除模型 ${model.id || modelIndex + 1}`} data-testid={`model-delete-${index}-${modelIndex}`} onClick={() => setConfirm({type: 'remove-model', index, modelIndex, title: `删除模型“${model.name || model.id || modelIndex + 1}”？`, text: '从草稿中移除此模型，同时清空所有引用它的默认角色选择。保存后生效，不删除远端模型。', action: '从草稿删除'})}><Trash2 size={14}/></button></div><label>模型 ID<input data-testid={`model-id-${index}-${modelIndex}`} value={model.id} maxLength={200} spellCheck="false" onChange={event => updateProvider(index, item => ({...item, models: item.models.map((entry, at) => at === modelIndex ? {...entry, id: event.target.value} : entry)}))}/></label><label>显示名称<input data-testid={`model-name-${index}-${modelIndex}`} value={model.name} maxLength={100} onChange={event => updateProvider(index, item => ({...item, models: item.models.map((entry, at) => at === modelIndex ? {...entry, name: event.target.value} : entry)}))}/></label><RoleChecks roles={model.roles} protocol={provider.protocol} disabled={locked} prefix={`model-${index}-${modelIndex}`} onChange={roles => updateProvider(index, item => ({...item, models: item.models.map((entry, at) => at === modelIndex ? {...entry, roles} : entry)}))}/>{provider.protocol === 'ollama' && <p className="ms-hint">Ollama 目录只可声明文本角色。</p>}</fieldset>)}</div>
          <button type="button" className="ms-secondary" data-testid={`model-add-${index}`} disabled={locked || provider.models.length >= 256 || total >= 512} onClick={() => updateProvider(index, item => ({...item, models: [...item.models, {id: '', name: '', roles: ['text']}]}))}><Plus size={14}/>手动添加模型</button>
        </div></details>
      </div>}
    </li>;
  }

  function renderContent() {
    if (!draft || !base) return <div className="ms-empty"><Server size={28}/><h3>{loading ? '正在读取模型设置…' : '未读取到模型设置'}</h3><p>不会使用临时空白文档覆盖宿主设置。</p>{!loading && <button type="button" className="ms-secondary" onClick={readSettings}>重试读取</button>}</div>;
    if (section === 'general') return <div className="ms-page" data-testid="settings-general"><p className="ms-intro">应用级生成参数；明确保存后生效，不写入项目凭据。</p><label className="ms-setting-row"><span><strong>文本温度</strong><small>影响文本生成的随机程度，范围 0–2。</small></span><input type="number" min="0" max="2" step="0.1" data-testid="settings-temperature" value={draft.general.temperature} disabled={locked} onChange={event => mutate(document => { document.general.temperature = event.target.value === '' ? '' : Number(event.target.value); return document; })}/></label><label className="ms-setting-row"><span><strong>语音音色</strong><small>音频生成时传给服务的 voice；需由供应商支持。</small></span><input data-testid="settings-voice" value={draft.general.voice} maxLength={200} disabled={locked} onChange={event => mutate(document => { document.general.voice = event.target.value; return document; })}/></label><label className="ms-setting-row"><span><strong>恢复上次项目</strong><small>下次启动时尝试恢复本机上次打开的画布。</small></span><input type="checkbox" data-testid="settings-restore" checked={draft.general.restoreLastProject} disabled={locked} onChange={event => mutate(document => { document.general.restoreLastProject = event.target.checked; return document; })}/></label><p className="ms-hint">运行中的工作流使用启动时的设置快照；此处保存不改变已开始的执行。</p></div>;
    if (section === 'providers') return <div className="ms-page" data-testid="settings-providers"><p className="ms-intro">按服务分别管理地址、原生凭据和模型目录。展开一张编辑卡片，不丢失其他服务的草稿。</p><ul className="ms-provider-list">{draft.providers.map(renderProvider)}</ul>{!draft.providers.length && <div className="ms-empty"><Server size={28}/><h3>尚未添加模型服务</h3><p>离线示例不需要服务凭据；真实生成需配置服务和模型。</p></div>}<div className="ms-add-provider"><label>新增方式<select aria-label="新增服务预设" data-testid="provider-preset" value={preset} disabled={locked} onChange={event => setPreset(event.target.value)}><option value="openai">OpenAI 兼容预设</option><option value="ollama">Ollama 本机预设</option><option value="custom">自定义服务</option></select></label><button type="button" className="ms-secondary" disabled={locked || draft.providers.length >= 32} data-testid="provider-add" onClick={addProvider}><Plus size={15}/>添加服务</button></div><p className="ms-hint">最多 32 个服务；每服务 256 个模型，合计 512 个。仅提供已实现的 OpenAI 兼容接口和 Ollama，不含 Responses / Anthropic。</p></div>;
    if (section === 'defaults') return <div className="ms-page" data-testid="settings-defaults"><div className="ms-info">WhaleFlow 扩展：为画布的文本、图像、视频和音频角色选择默认服务与模型。此页并非 DSH 原位同款功能。</div><p className="ms-intro">仅列出目录中已声明相应角色的模型。节点自身的明确选择优先；不根据模型名称猜测能力。</p>{ROLES.map(([role, label]) => {
      const options = draft.providers.flatMap(provider => provider.models.filter(model => model.roles.includes(role) && model.id.trim()).map(model => ({value: signature({providerId: provider.id, modelId: model.id}), label: `${provider.name || provider.id} / ${model.name || model.id} (${model.id})`})));
      return <label className="ms-default-row" key={role}><span>{label}默认模型</span><select data-testid={`default-model-${role}`} value={draft.defaults[role] ? signature(draft.defaults[role]) : ''} disabled={locked} onChange={event => mutate(document => { document.defaults[role] = event.target.value ? JSON.parse(event.target.value) : null; return document; })}><option value="">未选择</option>{options.map((option, index) => <option key={`${option.value}-${index}`} value={option.value}>{option.label}</option>)}</select>{!options.length && <small className="ms-hint">请先在服务目录中声明{label}角色。</small>}</label>;
    })}<p className="ms-hint">默认选择与新增目录可一起保存。配置了服务却未选择某角色默认模型时，相应真实生成将提示配置错误，不会悄悄切换端点。</p></div>;
    return <div className="ms-page" data-testid="settings-about"><div className="ms-about-mark">W</div><h3>WhaleFlow</h3><p className="ms-intro">独立的本地 AI 工作流画布 · 0.3</p><div className="ms-info">设置交互参考 DSH 公开实现；WhaleFlow 不共享其账号、插件或密钥。默认角色选择是本程序扩展。</div><p className="ms-hint">模型设置与凭据由桌面宿主管理，凭据只在 C# 原生对话框中录入。公开设置不含密钥，项目不携带凭据。</p><p className="ms-hint">获取模型目录只查询已保存服务的元数据，不生成内容、不下载模型，也不验证额度。外部真实生成可能产生服务商费用。</p></div>;
  }

  const title = SECTIONS.find(([id]) => id === section)?.[1];
  const status = loading ? '正在读取' : busy === 'save' ? '正在保存' : busy === 'credential' ? '原生凭据操作中' : conflict ? '版本冲突 · 草稿保留' : dirty ? '未保存' : base ? '已保存' : '未加载';
  return createPortal(<div className="ms-overlay" data-testid="model-settings-overlay" onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()} onPointerDown={event => { event.stopPropagation(); if (event.target === event.currentTarget && !confirm) requestClose(); }} onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <section ref={panelRef} className="ms-panel" role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} tabIndex={-1} data-testid="model-settings-dialog">
      <aside className="ms-nav" inert={confirm ? true : undefined} aria-hidden={confirm ? true : undefined}><h2>设置</h2><nav aria-label="设置分类">{SECTIONS.map(([id, label, Icon]) => <button type="button" key={id} className={section === id ? 'ms-nav-active' : ''} data-ms-nav={id} data-testid={`settings-nav-${id}`} aria-current={section === id ? 'page' : undefined} onClick={() => changeSection(id)}><Icon size={17}/>{label}</button>)}</nav><span className="ms-nav-brand">WhaleFlow</span></aside>
      <div className="ms-main" inert={confirm ? true : undefined} aria-hidden={confirm ? true : undefined}><header className="ms-header"><h2 id={`${uid}-title`}>{title}</h2><button type="button" className="ms-icon" aria-label="关闭设置" data-testid="settings-close" disabled={locked} onClick={requestClose}><X size={19}/></button></header>
        <div className="ms-scroll" tabIndex={0} aria-label={`${title}设置内容`}>
          {running && <div className="ms-info" role="note">工作流正在运行。保存仅影响后续执行，不修改当前运行快照。</div>}
          {error && <div className="ms-error" role="alert" data-testid="settings-error">{error}</div>}
          {notice && <p className="ms-notice" role="status" aria-live="polite" data-testid="settings-notice">{notice}</p>}
          {renderContent()}
        </div>
        <footer className="ms-footer"><div className="ms-save-status" role="status" aria-live="polite" data-testid="settings-save-status"><span className={`ms-status-dot ${!dirty && base && !conflict ? 'ms-ready' : ''}`}/>{status}{base && <small>版本 {base.revision}</small>}</div><div className="ms-inline-actions"><button type="button" className="ms-text-button" disabled={locked} data-testid="settings-reload" onClick={requestReload}>重新读取</button><button type="button" className="ms-primary" data-testid="settings-save" disabled={locked || !base || !dirty || conflict} onClick={save}>{busy === 'save' ? '保存中…' : '保存设置'}</button></div></footer>
      </div>
      {confirm && <div className="ms-confirm-shade"><section ref={confirmRef} className="ms-confirm" role="alertdialog" aria-modal="true" aria-labelledby={`${uid}-confirm-title`} aria-describedby={`${uid}-confirm-text`} tabIndex={-1} data-testid="settings-confirm"><h3 id={`${uid}-confirm-title`}>{confirm.title}</h3><p id={`${uid}-confirm-text`}>{confirm.text}</p><div className="ms-inline-actions"><button type="button" className="ms-secondary" data-testid="settings-confirm-cancel" onClick={() => setConfirm(null)}>保留并返回</button><button type="button" className="ms-primary" data-testid="settings-confirm-accept" onClick={confirmAction}>{confirm.action}</button></div></section></div>}
    </section>
  </div>, document.body);
}

export {ModelSettings as SettingsDialog};
export default ModelSettings;
