import {access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const quote=value=>"'"+value.replaceAll("'","''")+"'";
async function run(executable,args){const code=await new Promise((resolve,reject)=>{const child=spawn(executable,args,{cwd:root,stdio:'inherit'});child.on('error',reject);child.on('exit',resolve);});if(code!==0)throw new Error(`${path.basename(executable)} exited ${code}`);}
async function exists(file){try{await access(path.join(root,file));return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
for(const item of [{probe:'native-shell/vendor/webview2/lib/net462/Microsoft.Web.WebView2.Core.dll',script:'fetch-webview.mjs',archive:'webview2.zip',folder:'webview2'},{probe:'native-shell/vendor/node-runtime/node-v24.19.0-win-x64/node.exe',script:'fetch-node-runtime.mjs',archive:'node-runtime.zip',folder:'node-runtime'}]){
 if(await exists(item.probe))continue;
 await run(process.execPath,[path.join(root,'scripts',item.script)]);
 const command=`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath ${quote(path.join(root,'native-shell/vendor',item.archive))} -DestinationPath ${quote(path.join(root,'native-shell/vendor',item.folder))} -Force`;
 await run('powershell.exe',['-NoLogo','-NoProfile','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')]);
}
console.log('[PREPARE_NATIVE] Pinned WebView2 SDK and Node runtime are ready.');
