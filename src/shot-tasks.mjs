import {nodeModelPatch,nodeModelState} from './model-routing.mjs';
import {validateMediaUrl} from './schema.mjs';
export function compileShotTasks(project,studioId,document,shotIds,mode,selection,snapshot,idFactory=()=>crypto.randomUUID()){
 if(!['image','video'].includes(mode))throw Error('未知生成任务');
 const studio=project.nodes.find(n=>n.id===studioId);if(!studio)throw Error('工作台已删除');
 const shots=document.shots.filter(s=>shotIds.includes(s.id));if(!shots.length)throw Error('请先选择镜头');
 const patch=nodeModelPatch(selection),tasks=[];const origin=studio.position;
 const bottom=Math.max(origin.y,...project.nodes.filter(n=>n.data.studioNodeId===studioId).map(n=>n.position.y+(n.height||420)+60));
 for(const [index,shot] of shots.entries()){
  const reference=shot.referenceNodeId?project.nodes.find(n=>n.id===shot.referenceNodeId):mode==='video'?project.nodes.filter(n=>n.data.studioNodeId===studioId&&n.data.studioShotId===shot.id&&n.data.studioRevision===document.revision&&n.data.kind==='image'&&n.data.lastOutput?.image).at(-1):null;
  const referenceImage=reference?.data.mediaUrl||reference?.data.lastOutput?.image;
  if(shot.referenceNodeId&&!referenceImage)throw Error(`${shot.title}：参考图已缺失`);
  if(referenceImage){validateMediaUrl(referenceImage,'image');if(!/^data:image\/(?:png|jpeg|webp);base64,/i.test(referenceImage))throw Error(`${shot.title}：参考图需要 PNG/JPEG/WebP，请勿使用 DEMO SVG`);}
  if(mode==='video'&&!referenceImage)throw Error(`${shot.title}：请先生成当前修订的分镜图或选择参考图`);
  const data={kind:mode,title:`${shot.title} · ${mode==='image'?'分镜图':'首帧视频'}`,content:shot.prompt||[shot.description,document.style,shot.camera,shot.dialogue].filter(Boolean).join('\n'),...patch,studioNodeId:studioId,studioShotId:shot.id,studioRevision:document.revision,...(referenceImage?{referenceImage}:{}),...(mode==='video'?{videoSeconds:[4,8,12].includes(shot.duration)?shot.duration:4,videoSize:document.aspectRatio==='9:16'?'720x1280':'1280x720'}:{batchSize:1,imageSize:document.aspectRatio==='9:16'?'1024x1536':document.aspectRatio==='1:1'?'1024x1024':'1536x1024',imageAspectRatio:document.aspectRatio==='9:16'?'2:3':document.aspectRatio==='1:1'?'1:1':'3:2'})};
  const state=nodeModelState(data,snapshot);if(mode==='image'&&state.imageRules){const rules=state.imageRules;if(!rules.sizes.includes(data.imageSize)){data.imageSize=rules.sizes.includes('1024x1024')?'1024x1024':rules.sizes[0];data.imageAspectRatio='1:1';}}if(state.error)throw Error(`${shot.title}：${state.error}`);if((mode==='video'||referenceImage)&&state.protocol==='demo')throw Error('参考图编辑和视频需要真实模型服务，不支持 DEMO');
  tasks.push({id:idFactory(),type:'workflow',position:{x:origin.x+460+(index%3)*390,y:bottom+Math.floor(index/3)*520},width:350,height:420,data});
 }
 return {...project,version:3,nodes:[...project.nodes.map(n=>({...n,selected:false})),...tasks.map(n=>({...n,selected:true}))]};
}
