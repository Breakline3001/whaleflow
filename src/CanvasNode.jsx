import React, {memo, useContext, useEffect, useMemo, useRef, useState} from 'react';
import {Handle, NodeResizer, Position} from '@xyflow/react';
import {AlignLeft, ArrowUp, AudioLines, Check, ChevronDown, Copy, Download, Image, LoaderCircle, MoreHorizontal, Play, Plus, ScrollText, Settings2, Sparkles, Upload, Video, X} from 'lucide-react';
import {KINDS, DEFAULT_CONFIG} from './catalog.jsx';
import {Runtime} from './runtime.jsx';
import {outputView} from './output.mjs';
import {nodeModelOptions, nodeModelPatch, nodeModelState} from './model-routing.mjs';
import './node.css';

const stop = event => event.stopPropagation();
const IMAGE_SIZES = ['auto', '256x256', '512x512', '1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792'];
const RATIOS = ['1:1', '16:9', '9:16', '3:2', '2:3', '4:3', '3:4'];
const PLAN_KINDS = ['script', 'director', 'shots', 'clip'];
const GENERATORS = ['text', 'image', 'video', 'audio', ...PLAN_KINDS];
const RATIO_SIZES = {'1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536', '16:9': '1792x1024', '9:16': '1024x1792'};

function EmptyIllustration({kind, Icon}) {
  if (kind === 'image') return <svg className="wf-placeholder-icon" width="70" height="58" viewBox="0 0 70 58" aria-hidden="true"><circle cx="52" cy="12" r="6" fill="currentColor"/><path d="M3 50 24 13q2-4 5 0l16 26 7-10q2-3 4 0l12 21q2 4-3 4H6q-5 0-3-4Z" fill="currentColor"/></svg>;
  return <Icon className="wf-placeholder-icon" size={58} strokeWidth={1.5}/>;
}

function Preview({output, data, kind, onError}) {
  const mediaKind = /^data:(image|audio|video)\//i.exec(data.mediaUrl || '')?.[1]?.toLowerCase();
  const image = output?.image || (mediaKind === 'image' ? data.mediaUrl : undefined);
  const images = output?.images?.length ? output.images : image ? [image] : [];
  const audio = output?.audio || (mediaKind === 'audio' ? data.mediaUrl : undefined);
  const video = output?.video || (mediaKind === 'video' ? data.mediaUrl : undefined);
  const plan = output?.plan;
  return <div className={`output-preview nodrag nowheel ${images.length ? 'has-images' : ''}`} onPointerDown={stop} onDoubleClick={stop}>
    {images.length > 0 && <div className={`wf-image-grid ${images.length > 1 ? 'multiple' : ''}`}>{images.map((src, index) => <img key={index} src={src} alt={`${data.title || '图像输出'}${images.length > 1 ? ` ${index + 1}` : ''}`} draggable={false} onError={onError}/>)}</div>}
    {video && <video src={video} controls preload="metadata" onError={onError} aria-label="视频素材预览"/>}
    {audio && <div className="wf-audio-preview"><AudioLines size={54} strokeWidth={1}/><audio src={audio} controls preload="metadata" onError={onError} aria-label="音频预览"/></div>}
    {plan && <section className="wf-plan"><strong>{plan.title || '结构化创作方案'}</strong><p className="wf-plan-disclosure">结构方案 · rendered: false<br/>未渲染视频，未分析素材画面或声音</p><ol>{(plan.items || []).map((item, index) => <li key={index}>{item.startSeconds !== undefined && <small>{item.startSeconds}s — {item.endSeconds}s{item.sourceId ? ` · ${item.sourceId}` : ''}</small>}<p>{item.description}</p></li>)}</ol></section>}
    {output?.text && !plan && (!images.length && !video && !audio || kind === 'output') && <div className="wf-result-text">{output.text}</div>}
    {output?.demo && <span className="wf-demo-stamp">DEMO · 非真实 AI 生成</span>}
  </div>;
}

function CanvasNode({id, data, selected, width, height}) {
  const context = useContext(Runtime);
  const {runtime = {}, config: globalConfig = {}, modelSnapshot, running, checkpoint, updateNode, runNode, notify, importMedia, openNodeMenu, createConnectedNode, openSettings, saveAsset, copyNodeText, setNodeSize} = context;
  // Legacy config supplies parameter fallbacks only, never endpoint/model routing.
  const config = {...DEFAULT_CONFIG, ...globalConfig, ...modelSnapshot?.document?.general};
  const kind = data.kind || 'text';
  const meta = KINDS[kind] || KINDS.text;
  const Icon = meta.icon;
  // A runtime entry, including a queued/error entry with no output, supersedes persisted output.
  const state = runtime[id] || {status: data.lastOutput ? 'success' : undefined, output: data.lastOutput};
  const output = useMemo(() => outputView(state.output), [state.output]);
  const [popover, setPopover] = useState(null);
  const [textView, setTextView] = useState('both');
  const [mediaError, setMediaError] = useState(false);
  const root = useRef(null);
  const editor = useRef(null);
  const modelState = useMemo(() => nodeModelState(data, modelSnapshot), [data, modelSnapshot]);
  const modelOptions = useMemo(() => nodeModelOptions(modelSnapshot, kind), [modelSnapshot, kind]);
  const defaultModel = useMemo(() => nodeModelState({kind}, modelSnapshot), [kind, modelSnapshot]);
  const hasLegacyModel = ['model', 'imageModel', 'audioModel', 'videoModel'].some(key => data[key]?.trim());
  const legacySelection = modelState.mode === 'inherit' && (Boolean(data.provider) || hasLegacyModel);
  const modelValue = legacySelection ? 'legacy' : modelState.value;
  const selectedOption = modelOptions.find(option => option.value === modelState.value);
  const provider = modelState.protocol;
  const generating = GENERATORS.includes(kind);
  const isBusy = running || state.status === 'running';
  const intro = kind === 'text' && !data.content && !output && !data.manual && data.textMode !== 'manual';
  const hasPreview = Boolean(output?.image || output?.images?.length || output?.audio || output?.video || output?.plan || data.mediaUrl);
  const isGroup = kind === 'group';
  const canConnect = !isGroup && kind !== 'note';
  const effectiveImageModel = modelState.selectedModel || '';
  const imageRules = modelState.imageRules;
  const imageRatio = data.imageAspectRatio ?? config.imageAspectRatio ?? '';
  const imageSize = data.imageSize ?? config.imageSize ?? '';
  const imageBatch = data.batchSize ?? config.batchSize ?? 1;
  const imageProblems = [];
  if (imageRules) {
    if (imageRatio && !imageRules.ratios.includes(imageRatio)) imageProblems.push(`比例 ${imageRatio}`);
    const finalSize = imageSize === 'auto' && imageRatio ? RATIO_SIZES[imageRatio] : imageSize;
    if (finalSize && !imageRules.sizes.includes(finalSize)) imageProblems.push(`尺寸 ${finalSize}`);
    if (imageRules.maxBatch && imageBatch > imageRules.maxBatch) imageProblems.push(`数量 ${imageBatch}`);
    if (imageSize && imageSize !== 'auto' && imageRatio && imageRules.sizes.includes(imageSize) && imageRules.ratios.includes(imageRatio)) {
      const [w, h] = imageSize.split('x').map(Number), [a, b] = imageRatio.split(':').map(Number);
      if (Math.abs((w / h) / (a / b) - 1) > 0.04) imageProblems.push('尺寸与比例组合');
    }
  }
  const imageWarning = imageProblems.length ? `${effectiveImageModel} 不支持当前${imageProblems.join('、')}。已保存值未被修改，请手动选择支持的参数。` : '';

  useEffect(() => { if (!selected) setPopover(null); }, [selected]);
  useEffect(() => { setMediaError(false); }, [output, data.mediaUrl]);
  useEffect(() => {
    if (!popover) return;
    const dismiss = event => { if (!root.current?.contains(event.target)) setPopover(null); };
    const escape = event => { if (event.key === 'Escape') setPopover(null); };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, [popover]);

  const focus = () => checkpoint?.();
  const patch = value => updateNode?.(id, value);
  const commit = value => { checkpoint?.(); patch(value); };
  const toggle = name => setPopover(current => current === name ? null : name);
  const run = () => { setPopover(null); runNode?.(id); };
  const importHere = () => { setPopover(null); importMedia?.(undefined, id); };
  const connect = nextKind => { setPopover(null); createConnectedNode?.(id, nextKind); };
  const manual = () => { commit({kind: 'prompt', manual: true}); setNodeSize?.(id, 350, 200); requestAnimationFrame(() => editor.current?.focus()); };
  const switchTextMode = () => { commit({kind: kind === 'prompt' ? 'text' : 'prompt', manual: kind !== 'prompt', textMode: undefined}); if (kind === 'text') setNodeSize?.(id, 350, 200); };
  const chooseModel = value => { try { commit(nodeModelPatch(value)); } catch { notify?.('模型选择无效，请重新选择目录模型。', true); } };
  const ratioChange = value => {
    if (imageRules && value && !imageRules.ratios.includes(value)) return;
    // DALL-E does not accept size:auto; an intentional ratio selection chooses its supported size.
    const size = imageRules && !imageRules.sizes.includes('auto') ? (RATIO_SIZES[value || config.imageAspectRatio] || '1024x1024') : 'auto';
    patch({imageAspectRatio: value || undefined, imageSize: size});
  };
  const sizeChange = value => {
    if (imageRules && value && !imageRules.sizes.includes(value)) return;
    const ratio = !value || value === 'auto' ? imageRatio : value === '1792x1024' ? '16:9' : value === '1024x1792' ? '9:16' : value === '1536x1024' ? '3:2' : value === '1024x1536' ? '2:3' : '1:1';
    patch({imageSize: value || undefined, ...(ratio ? {imageAspectRatio: ratio} : {})});
  };
  const downloadImages = () => {
    const urls = output?.images?.length ? output.images : [output?.image || (/^data:image\//i.test(data.mediaUrl || '') ? data.mediaUrl : '')].filter(Boolean);
    if (!urls.length) { notify?.('当前没有可下载的图像', true); return; }
    urls.forEach((url, index) => {
      if (!/^data:image\//i.test(url)) return;
      const mime = /^data:image\/([^;,]+)/i.exec(url)?.[1];
      const extension = mime === 'svg+xml' ? 'svg' : mime === 'jpeg' ? 'jpg' : mime || 'png';
      const link = document.createElement('a');
      link.href = url; link.download = `${(data.title || 'WhaleFlow').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}${urls.length > 1 ? `-${index + 1}` : ''}.${extension}`;
      document.body.appendChild(link); link.click(); link.remove();
    });
  };
  const editorField = (label, placeholder, extraClass = '') => <textarea ref={editor} className={`wf-editor nodrag nowheel ${extraClass}`} aria-label={label} maxLength={1000000} placeholder={placeholder} value={data.content || ''} disabled={isBusy} onFocus={focus} onChange={event => patch({content: event.target.value})} onPointerDown={stop} onDoubleClick={stop}/>;
  const toolButton = (label, name, children) => <button type="button" title={label} aria-label={label} aria-expanded={popover === name} className={popover === name ? 'active' : ''} onClick={() => toggle(name)}>{children}<ChevronDown size={11}/></button>;

  return <div ref={root} className={`workflow-node kind-${kind} ${selected ? 'is-selected' : ''} ${state.status || ''} ${intro ? 'is-intro' : ''}`} style={{width: width || meta.width, height: height || meta.height}} data-node-id={id}>
    <NodeResizer isVisible={Boolean(selected && !running)} minWidth={isGroup ? 360 : 180} minHeight={isGroup ? 240 : 120} onResizeStart={focus} lineClassName="wf-resize-line" handleClassName="wf-resize-dot"/>
    <div className="wf-node-label"><Icon size={14}/>{selected ? <input className="wf-title-input nodrag nowheel" aria-label="节点名称" maxLength={500} value={data.title || meta.title} disabled={isBusy} onFocus={focus} onChange={event => patch({title: event.target.value})} onPointerDown={stop} onDoubleClick={stop}/> : <span>{data.title || meta.title}</span>}
      {state.status === 'running' && <LoaderCircle className="wf-spin" size={12}/>}{state.status === 'success' && <Check className="wf-status-success" size={12}/>}
      {state.status === 'error' && <span className="wf-status-error">失败</span>}
      {['cancelled', 'skipped'].includes(state.status) && <small>{state.status === 'cancelled' ? '已取消' : '未执行'}</small>}
      {output?.demo && <small className="wf-label-demo">DEMO</small>}
      <button type="button" className="wf-node-menu nodrag" aria-label="节点菜单" title="节点菜单" onPointerDown={stop} onClick={event => openNodeMenu?.(id, event)}><MoreHorizontal size={16}/></button>
    </div>
    {canConnect && <><Handle type="target" position={Position.Left} className="wf-port wf-port-left" isConnectable={!isBusy} aria-label="连接输入端口"><Plus size={10}/></Handle><Handle type="source" position={Position.Right} className="wf-port wf-port-right" isConnectable={!isBusy} aria-label="连接输出端口" onClick={event => {event.stopPropagation(); if (!isBusy) toggle('connect');}}><Plus size={10}/></Handle></>}
    {isGroup ? <button type="button" className="wf-group-run nodrag" onPointerDown={stop} onClick={run} disabled={isBusy}><Play size={12}/>{isBusy ? '执行中' : '执行组'}</button> : <>
      <div className={`wf-node-body ${kind === 'prompt' || kind === 'note' || kind === 'text' && !intro ? 'wf-writing-body' : ''}`}>
        {intro ? <div className="wf-intro"><AlignLeft className="wf-placeholder-icon" size={64} strokeWidth={3}/><div className="wf-try"><span>尝试:</span><button className="nodrag" disabled={isBusy} onPointerDown={stop} onClick={manual}><AlignLeft size={15}/>自己编写内容</button><button className="nodrag" disabled={isBusy} onPointerDown={stop} onClick={() => connect('video')}><Video size={15}/>文生视频</button><button className="nodrag" disabled={isBusy} onPointerDown={stop} onClick={() => {notify?.('已打开图像素材导入。当前模型协议仅处理文本提示词，未接入图像反推或视觉理解。'); importMedia?.();}}><Image size={15}/>图片反推提示词</button><button className="nodrag" disabled={isBusy} onPointerDown={stop} onClick={() => {notify?.('已连接音频节点。当前接入文字转语音服务，不支持音乐生成；DEMO 仅提供测试音。'); connect('audio');}}><AudioLines size={15}/>文字生音乐</button></div></div> : null}
        {(kind === 'prompt' || kind === 'note') && editorField(kind === 'note' ? '便签内容' : '文本输入内容', kind === 'note' ? '记录你的想法…' : '输入内容…')}
        {kind === 'text' && !intro && <div className={`wf-text-workspace view-${textView}`}>
          {textView !== 'output' && <div className="wf-text-prompt">{editorField('AI 文本提示词', '输入给模型的指令…')}</div>}
          {output?.text && textView !== 'edit' && <div className="wf-text-output nodrag nowheel" onPointerDown={stop}><small>{output.demo ? 'DEMO · 本地确定性文本，非真实 AI' : '模型输出'}</small><div>{output.text}</div></div>}
          {!output?.text && textView === 'output' && <div className="wf-empty-result">运行后在此查看输出</div>}
        </div>}
        {hasPreview && !['prompt', 'note', 'text', ...PLAN_KINDS].includes(kind) && <Preview output={output} data={data} kind={kind} onError={() => setMediaError(true)}/>}
        {!hasPreview && !(kind === 'output' && output?.text) && ['image', 'video', 'audio', 'asset', 'output'].includes(kind) && <div className="wf-intro"><EmptyIllustration kind={kind} Icon={Icon}/><div className="wf-try"><span>{kind === 'output' ? '连接上游，汇集创作结果' : '尝试:'}</span>
          {kind === 'image' && <><button className="nodrag" disabled={isBusy} onPointerDown={stop} onClick={importHere}><Upload size={15}/>图生图</button><button className="nodrag" disabled={isBusy} onPointerDown={stop} onClick={() => {setPopover('model'); notify?.('当前未接入图片高清接口；可在模型参数中选择生成尺寸，不会对已有图片伪造超分辨率。');}}><span className="wf-hd-icon">HD</span>图片高清</button></>}
          {['video', 'audio', 'asset'].includes(kind) && <button className="nodrag" disabled={isBusy} onPointerDown={stop} onClick={importHere}><Upload size={15}/>{kind === 'video' ? '导入视频' : kind === 'audio' ? '导入音频' : '导入本地素材'}</button>}
          {kind === 'video' && <small>真实视频生成需配置模型服务<br/>DEMO 不生成虚假视频</small>}
          {kind === 'audio' && <small>DEMO 为测试音，不是 AI 音乐<br/>真实服务使用语音合成接口</small>}
        </div></div>}
        {!hasPreview && kind === 'output' && output?.text && <Preview output={output} data={data} kind={kind}/>}
        {['script','shots'].includes(kind) && !data.creative && <div className="wf-script-empty"><ScrollText size={38} strokeWidth={1.5}/>
          <span className="wf-script-try">尝试：</span>
          <div className="wf-script-modes">
            <button type="button" onPointerDown={stop} onClick={()=>context.generateStoryboard?.(id,'script')}>剧本生成分镜脚本</button>
            <button type="button" onPointerDown={stop} onClick={()=>context.generateStoryboard?.(id,'character')}>角色生成分镜脚本</button>
            <button type="button" data-testid="open-creative" onPointerDown={stop} onClick={()=>context.openCreative?.(id,'manual')}>自己编写分镜脚本</button>
          </div></div>}
        {['script','shots'].includes(kind) && !data.creative && context.inlineScript?.studioId===id && <div className="wf-script-running"><div className="wf-skeleton" aria-hidden="true">{Array.from({length:6},(_,row)=><div key={row}>{[0,1,2].map(col=><i key={col}/>)}</div>)}</div><div className="wf-script-status"><LoaderCircle className="wf-spin" size={13}/><span>{state.status==='running'?'生成中':'准备中'}</span><button type="button" onPointerDown={stop} onClick={()=>context.cancelInline?.()}>取消</button></div></div>}
        {['script','shots'].includes(kind) && data.creative && <div className="wf-script-summary"><ScrollText size={15}/><span>{data.creative.shots?.length||0} 个镜头 · 修订 {data.creative.revision}</span><button type="button" className="nodrag" data-testid="open-creative" onPointerDown={stop} onClick={()=>context.openCreative?.(id)}>打开工作台</button></div>}
        {kind==='director'&&<button className="nodrag" data-testid="open-director" onPointerDown={stop} onClick={()=>context.openStage?.(id)}>打开 3D 导演台</button>}
        {PLAN_KINDS.includes(kind) && <div className="wf-plan-workspace"><div className="wf-plan-input"><div className="wf-plan-caption"><Icon size={24}/><strong>{meta.title}</strong><span>生成结构化方案，不渲染视频</span></div>{editorField(`${meta.title}创作要求`, '写下创作目标、情节或剪辑要求…')}</div>{(output?.plan || output?.text) && <Preview output={output} data={data} kind={kind} onError={() => setMediaError(true)}/>}</div>}
        {(state.error || mediaError) && <div className="wf-node-error nodrag nowheel" role="alert" onPointerDown={stop}>{state.error || '媒体无法播放或预览，请检查素材格式并重新导入。'}</div>}
        {state.status === 'running' && <div className="wf-running-indicator"><LoaderCircle className="wf-spin" size={14}/>执行中</div>}
      </div>
      {selected && <div className={`wf-node-tools nodrag nowheel ${generating && !intro ? 'with-prompt' : ''}`} onPointerDown={stop} onDoubleClick={stop}>
        {kind === 'image' && <div className="wf-composer-heading"><button type="button" disabled={isBusy} onClick={importHere}><Plus size={13}/>{data.mediaUrl ? '替换素材' : '导入素材'}</button><span>{data.mediaUrl ? '素材透传 · 不执行图像编辑' : '文字生图'}</span></div>}
        {generating && !intro && !['text', ...PLAN_KINDS].includes(kind) && <div className="wf-toolbar-prompt">{editorField(`${meta.title}提示词`, kind === 'audio' ? '输入要合成的文字…' : kind === 'image' ? '描述画面的主体、背景与光线，连接上游文本可补充创作指令…' : '描述你想创作的内容…')}</div>}
        <div className="wf-toolbar-row">
          {generating && toolButton('模型与服务参数', 'model', <><Sparkles size={13}/><span className="wf-model-name" title={modelState.description}>{modelState.label}</span></>)}
          {kind === 'image' && <>{toolButton('图像宽高比', 'ratio', imageRatio || '比例')}{toolButton('图像尺寸', 'size', imageSize || '默认')}{toolButton('生成数量', 'batch', `×${imageBatch}`)}</>}
          {kind === 'video' && toolButton('视频尺寸与时长', 'video', `${data.videoSeconds || 4}s`)}
          {kind === 'audio' && toolButton('声音设置', 'voice', '声音')}
          {['prompt', 'text'].includes(kind) && <button type="button" disabled={isBusy} onClick={switchTextMode} title={kind === 'prompt' ? '切换为 AI 文本生成' : '切换为手写内容'}>{kind === 'prompt' ? <Sparkles size={13}/> : <AlignLeft size={13}/>}<span>{kind === 'prompt' ? 'AI 生成' : '手写'}</span></button>}
          {kind === 'text' && !intro && toolButton('提示词与输出显示', 'view', '视图')}
          {(output?.text || data.content) && <button type="button" title="复制文本" aria-label="复制文本" onClick={() => copyNodeText?.(id)}><Copy size={13}/></button>}
          {(output?.image || output?.images?.length || /^data:image\//i.test(data.mediaUrl || '')) && <button type="button" title="下载图像" aria-label="下载图像" onClick={downloadImages}><Download size={13}/></button>}
          {['image', 'video', 'audio', 'asset'].includes(kind) && <button type="button" title={data.mediaUrl ? '替换当前素材' : '导入素材'} aria-label={data.mediaUrl ? '替换当前素材' : '导入素材'} disabled={isBusy} onClick={importHere}><Upload size={13}/></button>}
          {output && <button type="button" title="保存到素材库" aria-label="保存到素材库" disabled={isBusy} onClick={() => saveAsset?.(id)}><Plus size={13}/><span>素材</span></button>}
          {kind !== 'note' && <button type="button" className="wf-generate" aria-label={generating ? `生成${meta.title}` : '执行节点'} title={kind === 'image' && !data.mediaUrl ? imageWarning || undefined : undefined} disabled={isBusy || Boolean(kind === 'image' && !data.mediaUrl && imageWarning)} onClick={run}>{isBusy ? <LoaderCircle size={14} className="wf-spin"/> : <ArrowUp size={15}/>}<span>{generating ? '生成' : '执行'}</span></button>}
        </div>
        {kind === 'image' && imageWarning && <div className="wf-image-param-warning" role="alert">{imageWarning}</div>}
        {generating && !intro && <div className="wf-service-note">{modelState.description}</div>}
      </div>}
    </>}
    {selected && popover && <div role="dialog" aria-label="节点参数" className={`wf-param-popover nodrag nowheel popover-${popover}`} onPointerDown={stop} onDoubleClick={stop}>
      <div className="wf-popover-heading"><strong>{({model: '模型与服务', ratio: '图像宽高比', size: '图像尺寸', batch: '生成数量', video: '视频参数', voice: '声音参数', connect: '连接新节点', view: '文本视图'})[popover]}</strong><button type="button" title="关闭参数" aria-label="关闭参数" onClick={() => setPopover(null)}><X size={13}/></button></div>
      {popover === 'model' && <>
        <label>{kind === 'image' ? '图像模型' : kind === 'audio' ? '语音模型' : kind === 'video' ? '视频模型' : '文本模型'}<select disabled={isBusy} value={modelValue} onFocus={focus} onChange={event => chooseModel(event.target.value)}>
          {legacySelection && <option value="legacy" disabled>保留旧配置 · {modelState.label}</option>}
          {modelState.mode === 'ref' && !selectedOption && <option value={modelState.value} disabled>保留引用 · {data.modelRef.providerId} / {data.modelRef.modelId}</option>}
          <option value="inherit">继承默认 · {defaultModel.label}</option>
          <option value="demo">DEMO · 本地离线演示</option>
          {modelOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select></label>
        <p role={modelState.error ? 'alert' : undefined}>{modelState.description}</p>
        {selectedOption && <button type="button" className="wf-settings-link" disabled={isBusy} onClick={() => chooseModel(selectedOption.value)}>应用此目录模型{modelState.passive && kind === 'text' ? '并启用生成' : ''}</button>}
        <p>目录按生成角色筛选；缺失引用和旧配置不会自动改写。继承默认保留手写状态；手写文本仅在明确选择生成模型时启用生成。导入素材仍直接透传。</p>
        <button type="button" className="wf-settings-link" onClick={() => {setPopover(null); openSettings?.();}}><Settings2 size={13}/>打开模型设置</button>
      </>}
      {kind === 'image' && ['model', 'ratio', 'size', 'batch'].includes(popover) && <><p>{imageRules?.hint || (provider === 'demo' ? 'DEMO 可演示所有选项；比例和尺寸仅代表接口请求值，不保证真实模型支持。' : '自定义模型不预设尺寸限制，参数为接口请求值，实际支持范围由服务决定。4:3 / 3:4 暂无标准 OpenAI 尺寸映射。')}</p>{imageWarning && <div className="wf-image-param-warning" role="alert">{imageWarning}</div>}</>}
      {popover === 'ratio' && <><label>宽高比<select value={imageRatio} disabled={isBusy} onFocus={focus} onChange={event => ratioChange(event.target.value)}><option value="">跟随全局 / 服务默认</option>{RATIOS.map(ratio => {const unsupported = Boolean(imageRules && !imageRules.ratios.includes(ratio)); return <option key={ratio} value={ratio} disabled={unsupported}>{ratio}{unsupported ? ' · 当前模型不支持' : imageRules?.maxBatch === 1 && ratio !== '1:1' ? ' · 近似横竖比例' : ''}</option>;})}</select></label><p>{imageRules && !imageRules.sizes.includes('auto') ? '主动更改比例会同步选择支持的显式尺寸。' : '主动更改比例会将尺寸重置为 auto。'}已保存的不兼容参数不会自动修改。</p></>}
      {popover === 'size' && <label>图像尺寸<select value={imageSize} disabled={isBusy} onFocus={focus} onChange={event => sizeChange(event.target.value)}><option value="">跟随全局 / 服务默认</option>{IMAGE_SIZES.map(size => {const unsupported = Boolean(imageRules && !imageRules.sizes.includes(size)); return <option key={size} value={size} disabled={unsupported}>{size}{unsupported ? ' · 当前模型不支持' : ''}</option>;})}</select><small>主动选择显式尺寸会匹配对应比例；模型支持范围以当前服务为准。</small></label>}
      {popover === 'batch' && <label>图像数量<select value={imageBatch} disabled={isBusy} onFocus={focus} onChange={event => {const value = Number(event.target.value); if (!imageRules?.maxBatch || value <= imageRules.maxBatch) patch({batchSize: value});}}>{[1, 2, 3, 4].map(count => <option key={count} value={count} disabled={Boolean(imageRules?.maxBatch && count > imageRules.maxBatch)}>{count} 张{imageRules?.maxBatch && count > imageRules.maxBatch ? ' · 当前模型不支持' : ''}</option>)}</select></label>}
      {popover === 'video' && <><label>视频尺寸<select value={data.videoSize || '1280x720'} disabled={isBusy} onFocus={focus} onChange={event => patch({videoSize: event.target.value})}>{['1280x720', '720x1280', '1792x1024', '1024x1792'].map(size => <option key={size}>{size}</option>)}</select></label><label>时长<select value={data.videoSeconds || 4} disabled={isBusy} onFocus={focus} onChange={event => patch({videoSeconds: Number(event.target.value)})}>{[4, 8, 12].map(seconds => <option key={seconds} value={seconds}>{seconds} 秒</option>)}</select></label><p>真实生成使用 /videos 服务；DEMO 不会伪造视频。</p></>}
      {popover === 'voice' && <><label>声音 voice<input maxLength={200} value={data.voice || ''} placeholder={`跟随全局：${config.voice || '未配置'}`} disabled={isBusy} onFocus={focus} onChange={event => patch({voice: event.target.value})}/></label><p>可用声音名称由所接入的语音服务定义；当前协议为文字转语音，不是音乐创作。</p></>}
      {popover === 'view' && <label>显示内容<select value={textView} onChange={event => setTextView(event.target.value)}><option value="both">提示词与输出</option><option value="edit">仅编辑提示词</option><option value="output">仅查看输出</option></select></label>}
      {popover === 'connect' && <div className="wf-connect-list">{['text', 'image', 'video', 'audio', 'script', 'output'].map(nextKind => {const NextIcon = KINDS[nextKind].icon; return <button type="button" disabled={isBusy} key={nextKind} onClick={() => connect(nextKind)}><NextIcon size={15}/>{KINDS[nextKind].title}<Plus size={12}/></button>;})}</div>}
    </div>}
  </div>;
}

export default memo(CanvasNode);
