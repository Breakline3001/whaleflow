import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {rename,rm,readFile,readdir,lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
export async function run(executable,args,cwd){const code=await new Promise((resolve,reject)=>{const child=spawn(executable,args,{cwd,stdio:'inherit'});child.on('error',reject);child.on('exit',resolve);});if(code!==0)throw new Error(`${path.basename(executable)} exited ${code}`);}
const quote=value=>"'"+value.replaceAll("'","''")+"'";
export async function zipDirectory(source,destination){
 const temporary=destination+'.'+randomUUID()+'.tmp.zip';
 const command=`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Compress-Archive -Path ${quote(path.join(source,'*'))} -DestinationPath ${quote(temporary)} -CompressionLevel Optimal`;
 try{await run('powershell.exe',['-NoLogo','-NoProfile','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],source);await rename(temporary,destination);}finally{await rm(temporary,{force:true});}
}
export const runtimeFiles=['WhaleFlow.exe','WhaleFlow.exe.config','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll','WEBVIEW2-SDK-LICENSE.txt','webview2-sdk-provenance.json','host/node.exe','host/NODE-LICENSE.txt','host/runtime-provenance.json','host/build-source-manifest.json','runtimes/win-x64/native/WebView2Loader.dll','native-shell/server.mjs'];
export const runtimeDirectories=['lib','dist','third-party-licenses','examples'];
export const documents=['README.md','VALIDATION.md','LICENSE','THIRD_PARTY_NOTICES.md'];

// One file-set contract drives staging and verification; no historical file counts.
const projectRoot=fileURLToPath(new URL('../',import.meta.url));
const metadata=JSON.parse(await readFile(path.join(projectRoot,'package.json'),'utf8'));
const lock=JSON.parse(await readFile(path.join(projectRoot,'package-lock.json'),'utf8'));
export const version=metadata.version;
assert(/^\d+\.\d+\.\d+$/.test(version),'Invalid release version');
assert.equal(lock.version,version,'Package lock version differs');
assert.equal(lock.packages[''].version,version,'Root package lock version differs');
export const releaseName='WhaleFlow-'+version;
export const runtimeArchiveName=releaseName+'-Windows-x64.zip';
export const sourceArchiveName=releaseName+'-source.zip';
export const nativeSources=['native-shell/WhaleFlow.cs','native-shell/ModelSettings.cs','native-shell/WhaleFlow.manifest'];
export async function libModules(root=projectRoot){return (await treeFiles('lib',root)).filter(file=>file.endsWith('.mjs'));}
export const modelModules=['lib/model-settings-schema.mjs','lib/model-settings.mjs'];
export const sourceTopFiles=[...documents,'package.json','package-lock.json','index.html','vite.config.js','.gitignore','PROGRESS.md'];
export const sourceDirectories=['src','lib','tests','scripts','electron','examples','third-party-licenses','research'];
export const sourceNativeFiles=[...nativeSources,'native-shell/server.mjs','native-shell/node-runtime-version.json','native-shell/webview2-version.json'];
export function buildOutput(root=projectRoot){
 const output=path.resolve(root,process.env.WHALEFLOW_BUILD_OUTPUT||'release/'+releaseName);
 assert(output.startsWith(path.join(root,'release')+path.sep),'Build output must stay inside this project release directory');
 return output;
}
export function assertArchivePath(name,{source=false}={}){
 assert(typeof name==='string'&&name&&!name.includes('\\')&&!name.includes(':')&&!name.startsWith('/')&&!name.split('/').some(part=>!part||part==='.'||part==='..'),'Unsafe archive path: '+name);
 assert(!/(^|\/)(?:Data|artifacts|node_modules|vendor|\.git|\.dsh|webview|profile)(\/|$)|(^|\/)\.env(?:\.|$)|(?:\.dpapi|\.lock|\.tmp)(?:\.|\/|$)|app\.asar/i.test(name),'Private data, temporary file or legacy runtime rejected: '+name);
 assert(!/(?:\.(?:key|pem|pfx|p12|keystore)|(?:^|\/)(?:id_rsa|id_ed25519|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|user[-_]?keys?(?:\.[^/]*)?))$/i.test(name),'Credential file rejected: '+name);
 if(source)assert(!/\.(?:exe|dll|nupkg|zip|7z|pdb)$/i.test(name),'Binary or dependency rejected from source: '+name);
 else if(/\.(?:exe|dll)$/i.test(name))assert(runtimeFiles.includes(name),'Unexpected runtime executable: '+name);
}
export async function treeFiles(directory,base,{source=false}={}){
 const info=await lstat(path.join(base,directory));assert(info.isDirectory()&&!info.isSymbolicLink(),'Non-regular directory input: '+directory);
 const files=[];
 for(const entry of await readdir(path.join(base,directory),{withFileTypes:true})){
  const name=directory+'/'+entry.name;assertArchivePath(name,{source});
  if(entry.isDirectory())files.push(...await treeFiles(name,base,{source}));
  else{assert(entry.isFile()&&!entry.isSymbolicLink(),'Non-regular archive input: '+name);files.push(name);}
 }
 return files.sort();
}
async function addFiles(target,names,base,options){
 for(const name of names){assertArchivePath(name,options);const file=path.join(base,name),info=await lstat(file);assert(info.isFile()&&!info.isSymbolicLink(),'Non-regular archive input: '+name);assert(!target.has(name),'Duplicate contract path: '+name);target.set(name,file);}
}
export function evidenceFiles(root,output,{source=false}={}){
 const files=new Map([['verification/native-smoke.json',path.join(output,'artifacts/native-smoke.json')],['verification/v4-browser-integration.report.json',path.join(root,'artifacts/v4-browser-integration.report.json')],['verification/v4-creative-studio.png',path.join(root,'artifacts/v4-creative-studio.png')],['verification/v4-director-stage.png',path.join(root,'artifacts/v4-director-stage.png')]]);
 if(source)for(const name of ['native-smoke.png','artifact-verification.json','distribution-smoke.json'])files.set('verification/'+name,path.join(root,'artifacts',name));
 return files;
}
export function assertNativeSmoke(report){
 assert.equal(report.ok,true,'A passing native smoke report is required');
 assert.equal(report.details?.appInfo?.version,version,'Native smoke belongs to a different version');
 assert.equal(report.details.appInfo.platform,'win32');
 for(const check of ['app-ready-and-empty-canvas','project-menu-loads-five-node-demo','desktop-getAppInfo','visible-run-action-clicked','five-success-events-and-nodes','output-image-decoded','run-button-reset','autosave-restore-roundtrip','invalid-project-rejected-without-overwrite'])assert(report.details.checks.includes(check),'Missing native acceptance: '+check);
 assert.deepEqual(report.details.autosaveObservation,{nodeCount:5,outputs:5},'All five durable outputs are required');
 assert(report.details.outputImage?.width>0&&report.details.outputImage?.height>0,'Decoded output image required');
 for(const check of ['exact-fourteen-native-bridge-members','native-catalog-save-and-encrypted-readback','structured-cas-conflict-preserves-current-revision','native-password-modal-cancel-unchanged','native-password-modal-save-status-only-and-reopen','native-credential-clear','native-endpoint-change-invalidates-credential-binding','actual-settings-component-reloads-native-snapshot'])assert(report.details.modelSettingsChecks?.includes(check),'Missing native model settings acceptance: '+check);
}
export async function assertV4BrowserEvidence(root){
 const artifacts=path.join(root,'artifacts');
 const report=JSON.parse(await readFile(path.join(artifacts,'v4-browser-integration.report.json'),'utf8'));
 assert.equal(report.passed,true,'Passing v4 browser acceptance required');
 assert.equal(report.ok,true,'Browser report must include ok:true');
 assert.deepEqual(report.errors,[],'Browser acceptance reported errors');
 assert.equal(report.version,version,'Browser acceptance belongs to a different version');
 assert.equal(report.distUnchangedDuringRun,true,'Browser acceptance must verify dist remained unchanged');
 const manifest=report.distManifest;
 assert(Array.isArray(manifest)&&manifest.length>0,'Browser frontend fingerprint missing');
 assert.deepEqual(manifest.map(file=>file.path).sort(),(await treeFiles('dist',root)).filter(file=>/\.(?:m?js|css|html)$/i.test(file)).map(file=>file.slice('dist/'.length)).sort(),'Browser frontend file set is stale');
 const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
 for(const file of manifest){assert.equal(typeof file.sha256,'string','Browser frontend hash missing: '+file.path);assert.equal(sha(await readFile(path.join(root,'dist',file.path))),file.sha256,'Browser acceptance is stale: '+file.path);}
 for(const name of ['v4-creative-studio.png','v4-director-stage.png']){const image=await readFile(path.join(artifacts,name));assert(image.length>8&&image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'Missing valid v4 screenshot: '+name);}
 return report;
}
export async function assertNativeBuild(root,output){
 const manifest=JSON.parse(await readFile(path.join(output,'host/build-source-manifest.json'),'utf8'));
 assert.equal(manifest.version,version);assert.equal(manifest.algorithm,'sha256');
 const required=[...nativeSources,'native-shell/server.mjs',...await libModules(root)].sort();
 assert.deepEqual(manifest.files.map(file=>file.path).sort(),required,'Native source fingerprint file set differs');
 const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
 for(const file of manifest.files){const bytes=await readFile(path.join(root,file.path));assert.equal(bytes.length,file.bytes,'Native input size differs: '+file.path);assert.equal(sha(bytes),file.sha256,'Native source changed without rebuild: '+file.path);}
 assert.equal(sha(await readFile(path.join(output,'WhaleFlow.exe'))),manifest.executableSha256,'Executable differs from native build fingerprint');
 return manifest;
}
export async function runtimeInputs(root,output){
 const files=new Map();await addFiles(files,runtimeFiles,output);await addFiles(files,documents,root);
 for(const directory of runtimeDirectories)await addFiles(files,await treeFiles(directory,output),output);
 await addFiles(files,await treeFiles('research',root),root);
 for(const required of await libModules(root))assert(files.has(required),'Missing library runtime module: '+required);
 for(const [name,file]of evidenceFiles(root,output))files.set(name,file);
 return files;
}
export async function sourceInputs(root,output){
 const files=new Map(),options={source:true};await addFiles(files,[...sourceTopFiles,...sourceNativeFiles],root,options);
 for(const directory of sourceDirectories)await addFiles(files,await treeFiles(directory,root,options),root,options);
 for(const required of await libModules(root))assert(files.has(required),'Missing library source module: '+required);
 for(const [name,file]of evidenceFiles(root,output,options))files.set(name,file);
 return files;
}

