import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
for(const flags of [['--disable-gpu','--disable-gpu-sandbox'],['--no-sandbox','--disable-gpu']]){
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const code=await new Promise(resolve=>{const child=spawn(path.join(root,'node_modules/electron/dist/electron.exe'),[root,...flags,'--smoke-test'],{cwd:root,env,stdio:'inherit'});child.on('error',e=>{console.error(e);resolve(-1);});child.on('exit',resolve);});
 console.log('DIAGNOSTIC ONLY',JSON.stringify(flags),'exit',code);
}
console.log('No production sandbox configuration was changed.');
