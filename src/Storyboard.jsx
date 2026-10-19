import React from 'react';
import {X, Play, Image as ImageIcon} from 'lucide-react';

// Shot-ordered contact sheet. Reads only what already exists on the canvas:
// a shot with no generated image shows a placeholder, never an invented frame.
export default function Storyboard({story, nodes, running, onClose, onRedraw, onCreateShot}) {
  const doc = story?.data?.creative;
  const shots = doc?.shots || [];
  const tasksFor = shotId => nodes.filter(node => node.data.studioShotId === shotId);
  const imageFor = shotId => {
    const task = tasksFor(shotId).filter(node => node.data.lastOutput?.image || node.data.mediaUrl).at(-1);
    return task ? {src: task.data.lastOutput?.image || task.data.mediaUrl, id: task.id, revision: task.data.studioRevision} : null;
  };
  return <section className="storyboard-view">
    <header className="storyboard-heading">
      <h2>故事板</h2>
      <span>{shots.length} 个镜头 · {story ? `修订 ${doc.revision}` : '当前画布没有分镜文档'}</span>
      <button type="button" onClick={onCreateShot}>添加镜头节点</button>
      <button type="button" className="storyboard-close" aria-label="关闭故事板" onClick={onClose}><X size={16}/></button>
    </header>
    {!shots.length && <p className="storyboard-empty">还没有分镜。先在脚本节点里生成，或打开工作台自己编写。</p>}
    <div className="storyboard-strip">
      {shots.map((shot, index) => {
        const image = imageFor(shot.id);
        const stale = image && image.revision !== doc.revision;
        return <article className="story-card" key={shot.id} data-testid="storyboard-card">
          <header><span>{String(index + 1).padStart(2, '0')}</span><strong>{shot.title}</strong>{stale && <small>旧修订</small>}</header>
          <div className="story-frame">
            {image ? <img src={image.src} alt={shot.title}/> : <div className="story-frame-empty"><ImageIcon size={22}/><span>未生成</span></div>}
          </div>
          <p className="story-desc">{shot.description || shot.prompt || '没有描述'}</p>
          <footer>
            <span>{shot.duration}s · {shot.shotSize}</span>
            <button type="button" disabled={running || !image} onClick={() => image && onRedraw(image.id)}><Play size={12}/>重抽</button>
          </footer>
        </article>;
      })}
    </div>
  </section>;
}
