// Replace the director stage return block (line 118 to EOF) with the full-screen shell.
// Keeps every existing handler: requestClose/commit/updateObject/updateCamera/addObject.
import {readFile,writeFile} from 'node:fs/promises';
const file = new URL('./src/DirectorStage.jsx', 'file:///D:/XYP/whaleflow-v4/');
const lines = (await readFile(file, 'utf8')).split('\n');
const marker = lines.findIndex(line => line.startsWith('  return createPortal('));
if (marker < 0) throw new Error('return block marker not found');
const head = lines.slice(0, marker);
const block = `  return createPortal(<div className="ds-overlay" data-director-stage="true" role="dialog" aria-modal="true" aria-label="3D 导演台" ref={panelRef} tabIndex={-1} onPointerDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <canvas ref={canvasRef} className="ds-canvas" tabIndex={0} aria-label="三维导演台，拖动旋转视角，滚轮调整距离"/>
    <div className="ds-mode" role="group" aria-label="导演台视角"><button className="on" aria-pressed="true">导演视角</button><button aria-pressed="false" disabled title="机位视角复用同一自由相机">机位视角</button></div>
    <aside className="ds-left" inert={confirmClose ? true : undefined}>
      <div className="ds-rail-head"><button className="ds-icon-button" aria-label="返回画布" disabled={busy} onClick={requestClose}>←</button><span>3D导演台</span></div>
      <div className="ds-rail-body">
        <nav className="ds-nav" aria-label="导演台分区"><button className="on" aria-label="场景物件">物</button><div className="ds-nav-gap"/><button aria-label="摄影机">机</button><button aria-label="画幅">幅</button></nav>
        <div className="ds-list">
          <div className="ds-add-row">{DIRECTOR_OBJECT_TYPES.map(type => <button className="ds-object" disabled={draft.objects.length >= 200} key={type} onClick={() => addObject(type)}>＋{labels[type]}</button>)}</div>
          <div className="ds-group-label">场景物件</div>
          {draft.objects.map(object => <button key={object.id} className={\`ds-object \${object.id === selectedId ? 'on' : ''}\`} onClick={() => setSelectedId(object.id)}>{object.name || labels[object.type]}</button>)}
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
    <footer className="ds-capsule" inert={confirmClose ? true : undefined}><span>{dirty ? '有未保存更改' : '已保存'} · 修订 {baseRevision}</span><button disabled={busy} onClick={requestClose}>关闭</button><button disabled={busy || !onSave} onClick={() => commit()}>保存舞台</button><button className="ds-primary" disabled={busy || !rendererReady || !onCapture || backgroundStatus.startsWith('正在')} onClick={() => commit(true)}>{busy ? '处理中…' : '截图并保存到画布'}</button></footer>
    {confirmClose && <div className="ds-confirm" role="alertdialog" aria-modal="true" aria-labelledby="ds-confirm-title"><h3 id="ds-confirm-title">放弃未保存更改？</h3><p>关闭后，本次布景和摄影机修改将丢失。</p><div><button autoFocus onClick={() => setConfirmClose(false)}>继续编辑</button><button className="ds-primary" onClick={() => onClose?.()}>放弃并关闭</button></div></div>}
  </div>, document.body);
}
`;
await writeFile(file, head.join('\n') + '\n' + block);
console.log('rewrote return block from line', marker + 1, 'total lines', (head.join('\n') + '\n' + block).split('\n').length);
