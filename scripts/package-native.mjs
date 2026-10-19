import assert from 'node:assert/strict';
import {readFile,stat,mkdir,mkdtemp,copyFile,rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {runtimeInputs,buildOutput,runtimeArchiveName,version,assertNativeSmoke,assertNativeBuild,zipDirectory,assertV4BrowserEvidence} from './archive-helpers.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const output=buildOutput(root);
const release=path.join(root,'release');await mkdir(release,{recursive:true});
const report=JSON.parse(await readFile(path.join(output,'artifacts/native-smoke.json'),'utf8'));
assertNativeSmoke(report);await assertNativeBuild(root,output);
assert(Date.parse(report.timestamp)>=(await stat(path.join(output,'WhaleFlow.exe'))).mtimeMs-1000,'Native executable was changed after the last smoke test');
await assertV4BrowserEvidence(root);
const inputs=await runtimeInputs(root,output);
const stage=await mkdtemp(path.join(release,'.package-stage-'));
const destination=path.join(release,runtimeArchiveName);
try{
 for(const [name,file]of inputs){await mkdir(path.dirname(path.join(stage,name)),{recursive:true});await copyFile(file,path.join(stage,name));}
 await zipDirectory(stage,destination);
 const digest=createHash('sha256');for await(const chunk of createReadStream(destination))digest.update(chunk);
 console.log('[NATIVE_PACKAGE]',JSON.stringify({version,file:destination,files:inputs.size,bytes:(await stat(destination)).size,sha256:digest.digest('hex')}));
}finally{await rm(stage,{recursive:true,force:true});}
