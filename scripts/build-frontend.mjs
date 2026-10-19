import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
await mkdir(path.join(root,'artifacts'),{recursive:true});
// Node and the Go-based compiler prioritize Windows TEMP/TMP differently.
// Point both at an isolated, writable project directory; never alter a user's Temp ACLs.
const temporary=await mkdtemp(path.join(root,'artifacts','.build-'));
const watch=process.argv.slice(2).includes('--watch');
if(process.argv.slice(2).some(arg=>arg!=='--watch'))throw new Error('Only --watch is supported');
let code=1;
try{
 const child=spawn(process.execPath,[path.join(root,'node_modules','vite','bin','vite.js'),'build','--configLoader','native',...(watch?['--watch']:[])],{cwd:root,env:{...process.env,TEMP:temporary,TMP:temporary},stdio:'inherit',windowsHide:true});
 code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',value=>resolve(value??1));});
}finally{
 await rm(temporary,{recursive:true,force:true});
}
process.exitCode=code;
