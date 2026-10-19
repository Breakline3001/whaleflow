import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createDirectorStage, validateDirectorStage, DIRECTOR_OBJECT_TYPES } from '../lib/director-stage.mjs';
import { createDirectorRenderer } from './director-webgl.mjs';
import './director-stage.css';
import './director-stage-shell.css';

const clone = value => JSON.parse(JSON.stringify(value));
const labels = { person: '人物', box: '方盒', sphere: '球体', plane: '平面' };
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
function NumberField({ label, value, onChange, min, max, step = 0.1 }) {
  return <div className="ds-row"><label>{label}</label><input type="number" value={Number(value.toFixed(4))} min={min} max={max} step={step} onChange={event => { if (event.target.value !== '' && Number.isFinite(event.target.valueAsNumber)) onChange(clamp(event.target.valueAsNumber, min ?? -10000, max ?? 10000)); }} /></div>;
}
/* Triad rows follow the measured inspector rhythm: 3 columns, 4px gap, 28px cells. */
function VectorFields({ label, value, onChange, scale = false, degrees = false }) {
  const axes = ['X', 'Y', 'Z'];
  return <div className="ds-row"><label>{label}</label><div className="ds-triad">{axes.map((axis, index) => (
    <label key={axis}><span>{axis}</span><input type="number" value={Number((degrees ? value[index] * 180 / Math.PI : value[index]).toFixed(3))} min={scale ? 0.001 : -10000} max={10000} onChange={event => { const next = event.target.valueAsNumber; if (event.target.value !== '' && Number.isFinite(next)) onChange(value.map((n, i) => i === index ? (degrees ? clamp(next, -360, 360) * Math.PI / 180 : clamp(next, scale ? 0.001 : -10000, 10000)) : n)); }} /></label>
  ))}</div></div>;
}
export default function DirectorStage({ stage, onSave, onCapture, onClose, backgroundImage }) {
  const initial = useRef(null);
  if (!initial.current) {
    const validation = validateDirectorStage(stage);
    initial.current = { stage: validation.valid ? clone(stage) : createDirectorStage(), error: validation.valid ? '' : `舞台数据无效：${validation.errors.join('；')}` };
  }
  const [draft, setDraft] = useState(initial.current.stage);
  const [baseline, setBaseline] = useState(JSON.stringify(initial.current.stage));
  const [baseRevision, setBaseRevision] = useState(initial.current.stage.revision);
  const [selectedId, setSelectedId] = useState(initial.current.stage.objects[0]?.id ?? null);
  const [error, setError] = useState(initial.current.error);
  const [rendererReady, setRendererReady] = useState(false);
  const [backgroundStatus, setBackgroundStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const canvasRef = useRef(null), panelRef = useRef(null), rendererRef = useRef(null), liveRef = useRef({}), busyRef = useRef(false);
  const dirty = JSON.stringify(draft) !== baseline;
  const selected = draft.objects.find(object => object.id === selectedId);
  const updateCamera = patch => setDraft(value => ({ ...value, camera: { ...value.camera, ...patch } }));
  const updateObject = patch => setDraft(value => ({ ...value, objects: value.objects.map(object => object.id === selectedId ? { ...object, ...patch } : object) }));
  const requestClose = () => { if (busyRef.current) return; if (dirty) setConfirmClose(true); else onClose?.(); };
  async function commit(capture = false) {
    if (busyRef.current) return;
    const validation = validateDirectorStage(draft);
    if (!validation.valid) { setError(validation.errors.join('；')); return; }
    const callback = capture ? onCapture : onSave;
    if (!callback) { setError(capture ? '尚未接入截图回调。' : '尚未接入保存回调。'); return; }
    busyRef.current = true; setBusy(true); setError('');
    try {
      const payload = clone({ ...draft, revision: baseRevision + 1 });
      if (capture) {
        if (!rendererRef.current || !rendererReady) throw new Error('WebGL 尚未就绪。');
        const png = rendererRef.current.capture(draft);
        await callback(payload, png, baseRevision);
      } else await callback(payload, baseRevision);
      setDraft(payload); setBaseRevision(payload.revision); setBaseline(JSON.stringify(payload));
    } catch (failure) { setError(failure?.message || String(failure)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  liveRef.current = { draft, selectedId, requestClose, commit, busy, confirmClose };
  useEffect(() => {
    const previous = document.activeElement;
    const panel = panelRef.current;
    panel.focus();
    function keydown(event) {
      const state = liveRef.current;
      // Bubble-phase isolation preserves native typing while blocking app-level shortcuts.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (!state.confirmClose) state.commit(); }
      else if (event.key === 'Escape') { event.preventDefault(); if (state.confirmClose) setConfirmClose(false); else state.requestClose(); }
      else if (event.key === 'Tab') {
        const nodes = [...panel.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(node => node.getClientRects().length && !node.closest('[inert]'));
        if (!nodes.length) { event.preventDefault(); panel.focus(); }
        else {
          const first = nodes[0], last = nodes[nodes.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel)) { event.preventDefault(); first.focus(); }
        }
      }
      event.stopPropagation();
    }
    function focusin(event) { if (!panel.contains(event.target)) panel.focus(); }
    panel.addEventListener('keydown', keydown);
    document.addEventListener('focusin', focusin);
    return () => { panel.removeEventListener('keydown', keydown); document.removeEventListener('focusin', focusin); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    let renderer;
    const lost = event => { event.preventDefault(); setRendererReady(false); setError('WebGL 上下文丢失。请关闭并重新打开舞台。'); };
    canvas.addEventListener('webglcontextlost', lost);
    try { renderer = createDirectorRenderer(canvas, { onStatus: setBackgroundStatus }); rendererRef.current = renderer; setRendererReady(true); }
    catch (failure) { setError(failure.message); }
    const resize = () => {
      const { draft: current, selectedId: id } = liveRef.current;
      const rect = canvas.parentElement.getBoundingClientRect();
      const width = Math.max(1, Math.min(rect.width, rect.height * current.aspectRatio));
      const height = width / current.aspectRatio;
      canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(width * pixelRatio)); canvas.height = Math.max(1, Math.round(height * pixelRatio));
      renderer?.render(current, id);
    };
    const observer = new ResizeObserver(resize); observer.observe(canvas.parentElement); resize();
    let drag = null;
    const down = event => { if (busyRef.current || event.button !== 0) return; canvas.focus(); canvas.setPointerCapture(event.pointerId); drag = { x: event.clientX, y: event.clientY }; };
    const move = event => { if (!drag || busyRef.current) return; const dx = event.clientX - drag.x, dy = event.clientY - drag.y; drag = { x: event.clientX, y: event.clientY }; setDraft(value => ({ ...value, camera: { ...value.camera, azimuth: ((value.camera.azimuth - dx * 0.008) % (Math.PI * 2)), elevation: clamp(value.camera.elevation + dy * 0.008, -1.55, 1.55) } })); };
    const up = () => { drag = null; };
    const wheel = event => { event.preventDefault(); event.stopPropagation(); if (busyRef.current) return; setDraft(value => ({ ...value, camera: { ...value.camera, distance: clamp(value.camera.distance * Math.exp(clamp(event.deltaY, -500, 500) * 0.001), 0.2, 1000) } })); };
    canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move); canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up); canvas.addEventListener('lostpointercapture', up); canvas.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); canvas.removeEventListener('webglcontextlost', lost); canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', up); canvas.removeEventListener('lostpointercapture', up); canvas.removeEventListener('wheel', wheel); renderer?.dispose(); rendererRef.current = null; };
  }, []);
  useEffect(() => { rendererRef.current?.setBackground(backgroundImage); }, [backgroundImage]);
  useEffect(() => {
    const canvas = canvasRef.current, rect = canvas.parentElement.getBoundingClientRect();
    const width = Math.max(1, Math.min(rect.width, rect.height * draft.aspectRatio)), height = width / draft.aspectRatio, ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`; canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio));
    rendererRef.current?.render(draft, selectedId);
  }, [draft, selectedId]);
  function addObject(type) {
    const id = `stage-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
    setDraft(value => ({ ...value, objects: [...value.objects, { id, type, name: `${labels[type]} ${value.objects.length + 1}`, position: [0, type === 'box' || type === 'sphere' ? 0.5 : 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }] })); setSelectedId(id);
  }
  return createPortal(<div className="ds-overlay" data-director-stage="true" role="dialog" aria-modal="true" aria-label="3D 导演台" ref={panelRef} tabIndex={-1} onPointerDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <canvas ref={canvasRef} className="ds-canvas" tabIndex={0} aria-label="三维导演台，拖动旋转视角，滚轮调整距离"/>
    <div className="ds-mode" role="group" aria-label="导演台视角"><button className="on" aria-pressed="true">导演视角</button><button aria-pressed="false" disabled title="机位视角复用同一自由相机">机位视角</button></div>
    <aside className="ds-left" inert={confirmClose ? true : undefined}>
      <div className="ds-rail-head"><button className="ds-icon-button" aria-label="返回画布" disabled={busy} onClick={requestClose}>←</button><span>3D导演台</span></div>
      <div className="ds-rail-body">
        <nav className="ds-nav" aria-label="导演台分区"><button className="on" aria-label="场景物件">物</button><div className="ds-nav-gap"/><button aria-label="摄影机">机</button><button aria-label="画幅">幅</button></nav>
        <div className="ds-list">
          <div className="ds-add-row">{DIRECTOR_OBJECT_TYPES.map(type => <button className="ds-object" disabled={draft.objects.length >= 200} key={type} onClick={() => addObject(type)}>＋{labels[type]}</button>)}</div>
          <div className="ds-group-label">场景物件</div>
          {draft.objects.map(object => <button key={object.id} className={`ds-object ${object.id === selectedId ? 'on' : ''}`} onClick={() => setSelectedId(object.id)}>{object.name || labels[object.type]}</button>)}
          {!draft.objects.length && <p className="ds-group-label">还没有物件，用上面的按钮添加。</p>}
          <div className="ds-group-label" role="status">{backgroundStatus || '真实几何预演；人物为基础人形，不从图片推断空间。'}</div>
        </div>
      </div>
    </aside>
    <aside className="ds-right" inert={confirmClose ? true : undefined}>
      <div className="ds-rail-head"><span>属性</span></div>
      <div className="ds-list">
        {selected ? <fieldset disabled={busy}>
          <div className="ds-row"><label>名称</label><input type="text" value={selected.name} maxLength={200} onChange={event => updateObject({name: event.target.value})}/></div>
          <VectorFields label="位置（米）" value={selected.position} onChange={position => updateObject({position})}/>
          <VectorFields label="旋转（度）" degrees value={selected.rotation} onChange={rotation => updateObject({rotation})}/>
          <VectorFields label="缩放" scale value={selected.scale} onChange={scale => updateObject({scale})}/>
          <div className="ds-row"><label>统一缩放</label><div className="ds-slider"><input type="range" min="0.01" max="10" step="0.01" value={selected.scale[0]} onChange={event => { const value = clamp(event.target.valueAsNumber, 0.01, 10); updateObject({scale: [value, value, value]}); }}/><input type="number" min="0.01" max="10" step="0.01" value={Number(selected.scale[0].toFixed(2))} onChange={event => { if (event.target.value === '' || !Number.isFinite(event.target.valueAsNumber)) return; const value = clamp(event.target.valueAsNumber, 0.01, 10); updateObject({scale: [value, value, value]}); }}/></div></div>
          <button className="ds-object" onClick={() => {setDraft(value => ({...value, objects: value.objects.filter(object => object.id !== selectedId)})); setSelectedId(null);}}>删除物件</button>
        </fieldset> : <p className="ds-group-label">选中一个物件来编辑它。</p>}
        <div className="ds-group-label">摄影机</div>
        <fieldset disabled={busy}>
          <div className="ds-add-row">{[['正面', 0, 0.15], ['侧面', Math.PI / 2, 0.15], ['俯拍', 0, 1.4], ['透视', 0.65, 0.3]].map(([label, azimuth, elevation]) => <button className="ds-object" key={label} onClick={() => updateCamera({azimuth, elevation})}>{label}</button>)}</div>
          <NumberField label="方位 °" value={draft.camera.azimuth * 180 / Math.PI} min={-360} max={360} onChange={value => updateCamera({azimuth: value * Math.PI / 180})}/>
          <NumberField label="仰角 °" value={draft.camera.elevation * 180 / Math.PI} min={-88.8} max={88.8} onChange={value => updateCamera({elevation: value * Math.PI / 180})}/>
          <NumberField label="距离" value={draft.camera.distance} min={0.2} max={1000} onChange={distance => updateCamera({distance})}/>
          <VectorFields label="注视目标" value={draft.camera.target} onChange={target => updateCamera({target})}/>
          <NumberField label="垂直视野角 °" value={draft.camera.fov} min={10} max={120} step={1} onChange={fov => updateCamera({fov})}/>
        </fieldset>
        <div className="ds-group-label">画幅与环境</div>
        <fieldset disabled={busy}>
          <div className="ds-row"><label>画幅</label><select value={draft.aspectRatio} onChange={event => setDraft(value => ({...value, aspectRatio: Number(event.target.value)}))}>{![16 / 9, 9 / 16, 1, 2.35].includes(draft.aspectRatio) && <option value={draft.aspectRatio}>自定义 {draft.aspectRatio.toFixed(3)}</option>}<option value={16 / 9}>16:9 横屏</option><option value={9 / 16}>9:16 竖屏</option><option value={1}>1:1 方形</option><option value={2.35}>2.35:1 宽银幕</option></select></div>
          <div className="ds-row"><label>背景颜色</label><input type="color" value={draft.background} onChange={event => setDraft(value => ({...value, background: event.target.value}))}/></div>
          <div className="ds-row"><label><input type="checkbox" checked={draft.grid} onChange={event => setDraft(value => ({...value, grid: event.target.checked}))}/> 地面网格（含在截图内）</label></div>
          <p className="ds-group-label">选择高亮不写入截图；全景图仅作等距柱状环境背景。</p>
        </fieldset>
      </div>
    </aside>
    {error && <div className="ds-error" role="alert">{error}</div>}
    <footer className="ds-capsule" inert={confirmClose ? true : undefined}><span>{dirty ? '有未保存更改' : '已保存'} · 修订 {baseRevision}</span><button aria-label="关闭导演舞台" disabled={busy} onClick={requestClose}>关闭</button><button disabled={busy || !onSave} onClick={() => commit()}>保存舞台</button><button className="ds-primary" disabled={busy || !rendererReady || !onCapture || backgroundStatus.startsWith('正在')} onClick={() => commit(true)}>{busy ? '处理中…' : '截图并保存到画布'}</button></footer>
    {confirmClose && <div className="ds-confirm" role="alertdialog" aria-modal="true" aria-labelledby="ds-confirm-title"><h3 id="ds-confirm-title">放弃未保存更改？</h3><p>关闭后，本次布景和摄影机修改将丢失。</p><div><button autoFocus onClick={() => setConfirmClose(false)}>继续编辑</button><button className="ds-primary" onClick={() => onClose?.()}>放弃并关闭</button></div></div>}
  </div>, document.body);
}
