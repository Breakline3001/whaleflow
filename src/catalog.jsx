import {AlignLeft,Image,Video,AudioLines,ScrollText,Clapperboard,ScanLine,Scissors,Folder,StickyNote,ArrowUpRight,Type,Group} from 'lucide-react';
export const KINDS={
 text:{title:'文本',icon:AlignLeft,color:'#aaa',width:350,height:200},
 image:{title:'图片',icon:Image,color:'#aaa',width:622,height:350},
 video:{title:'视频',icon:Video,color:'#aaa',width:622,height:350},
 clip:{title:'智能剪辑',icon:Scissors,color:'#aaa',width:420,height:340,badge:'Beta'},
 director:{title:'导演台',icon:Clapperboard,color:'#54d5f5',width:350,height:466,badge:'NEW'},
 shots:{title:'逐帧拉片',icon:ScanLine,color:'#aaa',width:350,height:350},
 audio:{title:'音频',icon:AudioLines,color:'#aaa',width:350,height:260},
 script:{title:'脚本',icon:ScrollText,color:'#aaa',width:350,height:350},
 asset:{title:'素材库',icon:Folder,color:'#aaa',width:350,height:300},
 prompt:{title:'文本输入',icon:Type,color:'#aaa',width:350,height:250},
 note:{title:'便签',icon:StickyNote,color:'#e4d18a',width:300,height:230},
 output:{title:'输出',icon:ArrowUpRight,color:'#aaa',width:350,height:350},
 group:{title:'分组',icon:Group,color:'#aaa',width:700,height:500}
};
export const ADD_KINDS=['text','image','video','clip','director','shots','audio','script','asset'];
export const DEFAULT_CONFIG={provider:'demo',baseUrl:'http://127.0.0.1:11434',model:'qwen2.5:7b',imageModel:'gpt-image-1',audioModel:'tts-1',videoModel:'sora-2',voice:'alloy',temperature:0.7};
export function storedConfig(value){
 if(!value||!['demo','ollama','openai'].includes(value.provider))return null;
 const result={...DEFAULT_CONFIG};for(const key of ['provider','baseUrl','model','imageModel','audioModel','videoModel','voice'])if(typeof value[key]==='string'&&value[key].length<=(key==='voice'?200:2000))result[key]=value[key];
 if(typeof value.temperature==='number'&&value.temperature>=0&&value.temperature<=2)result.temperature=value.temperature;
 result.baseUrl=result.baseUrl.trim()||(result.provider==='ollama'?'http://127.0.0.1:11434':result.provider==='openai'?'https://api.openai.com/v1':'');if(!result.baseUrl)return result;
 try{const url=new URL(result.baseUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)return null;}catch{return null;}return result;
}
