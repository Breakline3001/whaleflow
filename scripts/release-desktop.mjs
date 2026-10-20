// Deliver only a previously verified runtime archive into a new desktop folder.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,lstat,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readOwnZip} from './read-own-zip.mjs';
import {runtimeArchiveName,runtimeInputs,buildOutput,version} from './archive-helpers.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),desktop=process.env.WHALEFLOW_DESKTOP||path.join(process.env.USERPROFILE,'Desktop'),folderName=process.env.WHALEFLOW_DELIVERY_NAME||'WhaleFlow-0.5.0',folder=path.join(desktop,folderName),shortcutName=process.env.WHALEFLOW_DELIVERY_SHORTCUT||'WhaleFlow创作导演台.lnk',shortcut=path.join(desktop,shortcutName);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function absent(file){try{await lstat(file);throw Error('拒绝覆盖已有路径：'+file);}catch(e){if(e.code!=='ENOENT')throw e;}}
await absent(folder);await absent(shortcut);
const archive=path.join(root,'release',runtimeArchiveName),archiveSha256=sha(await readFile(archive));
const verified=JSON.parse(await readFile(path.join(root,'artifacts/artifact-verification.json'),'utf8'));
assert.equal(verified.version,version);assert.equal(verified.zipSha256,archiveSha256);assert(verified.sourceFilesVerified>0,'Verify both archives before delivery');
const expected=await runtimeInputs(root,buildOutput(root));let files=0;
await mkdir(folder);
for await(const entry of readOwnZip(archive)){assert(expected.has(entry.name),'Unexpected entry');const destination=path.join(folder,entry.name);await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,entry.bytes);assert.equal(sha(await readFile(destination)),sha(await readFile(expected.get(entry.name))));expected.delete(entry.name);files++;}
assert.equal(expected.size,0);assert(!(await readdir(folder)).includes('Data'));
const exe=path.join(folder,'WhaleFlow.exe'),readback=path.join(root,'artifacts/shortcut-readback.json');
const quote=s=>"'"+s.replaceAll("'","''")+"'";
const script=`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut(${quote(shortcut)}); $s.TargetPath=${quote(exe)}; $s.WorkingDirectory=${quote(folder)}; $s.IconLocation=${quote(exe+',0')}; $s.Save(); $r=$w.CreateShortcut(${quote(shortcut)}); @{target=$r.TargetPath;directory=$r.WorkingDirectory}|ConvertTo-Json|Set-Content -Encoding UTF8 -LiteralPath ${quote(readback)}`;
const code=await new Promise((resolve,reject)=>{const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{stdio:'inherit'});child.on('error',reject);child.on('exit',resolve);});assert.equal(code,0);
const link=JSON.parse((await readFile(readback,'utf8')).replace(/^\uFEFF/,''));assert.equal(link.target.toLowerCase(),exe.toLowerCase());assert.equal(link.directory.toLowerCase(),folder.toLowerCase());await rm(readback);
const result={version,deliveredAt:new Date().toISOString(),folder,shortcut,files,archiveSha256,exeSha256:sha(await readFile(exe)),containsData:false,shortcutTarget:link.target};await writeFile(path.join(root,'artifacts/desktop-delivery.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
