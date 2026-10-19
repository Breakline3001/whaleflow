// Render persisted output defensively without changing the saved metadata contract.
export function outputView(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
 const media=(key,kind)=>typeof value[key]==='string'&&value[key].slice(0,12).toLowerCase().startsWith('data:'+kind+'/')?value[key]:undefined;
 const result={...value,text:typeof value.text==='string'?value.text:'',demo:value.demo===true,image:media('image','image'),audio:media('audio','audio'),video:media('video','video'),images:Array.isArray(value.images)?value.images.filter(v=>typeof v==='string'&&v.slice(0,11).toLowerCase()==='data:image/').slice(0,4):[]};
 if(value.plan&&typeof value.plan==='object'&&!Array.isArray(value.plan)){
  const plan=value.plan;
  result.plan={...plan,title:typeof plan.title==='string'?plan.title:'结构化创作方案',kind:typeof plan.kind==='string'?plan.kind:'',items:(Array.isArray(plan.items)?plan.items:[]).filter(item=>item&&typeof item==='object'&&!Array.isArray(item)&&typeof item.description==='string').slice(0,500).map(item=>({description:item.description,sourceId:typeof item.sourceId==='string'?item.sourceId:undefined,startSeconds:Number.isFinite(item.startSeconds)?item.startSeconds:undefined,endSeconds:Number.isFinite(item.endSeconds)?item.endSeconds:undefined}))};
 }else result.plan=undefined;
 return result;
}
