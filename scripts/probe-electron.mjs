import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const exe=fileURLToPath(new URL('../node_modules/electron/dist/electron.exe',import.meta.url));
for(const mode of ['node','version']){
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 if(mode==='node') env.ELECTRON_RUN_AS_NODE='1';
 const args=mode==='node'?['-e','console.log(JSON.stringify(process.versions))']:['--version'];
 const code=await new Promise(resolve=>{const child=spawn(exe,args,{env,stdio:'inherit'});child.on('error',e=>{console.error(e.message);resolve(-1);});child.on('exit',resolve);});
 console.log(`Electron probe ${mode}: ${code}`);
}
console.log('npm latest Electron:',(await(await fetch('https://registry.npmjs.org/electron/latest')).json()).version);
