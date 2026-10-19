import assert from 'node:assert/strict';
import {open,readFile,writeFile,stat,mkdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {readOwnZip} from './read-own-zip.mjs';
import {runtimeInputs,sourceInputs,treeFiles,assertArchivePath,assertNativeSmoke,assertNativeBuild,buildOutput,version,releaseName,runtimeArchiveName,sourceArchiveName,assertV4BrowserEvidence} from './archive-helpers.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),output=buildOutput(root);
const executable=path.join(output,'WhaleFlow.exe'),archive=path.join(root,'release',runtimeArchiveName);
async function hash(file){const digest=createHash('sha256');for await(const chunk of createReadStream(file))digest.update(chunk);return digest.digest('hex');}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const handle=await open(executable,'r'),head=Buffer.alloc(4096);await handle.read(head,0,head.length,0);await handle.close();
assert.equal(head.toString('ascii',0,2),'MZ');const pe=head.readUInt32LE(0x3c);assert.equal(head.toString('ascii',pe,pe+4),'PE\u0000\u0000');assert.equal(head.readUInt16LE(pe+4),0x8664);
const smoke=JSON.parse(await readFile(path.join(output,'artifacts/native-smoke.json'),'utf8'));assertNativeSmoke(smoke);assert(Date.parse(smoke.timestamp)>=(await stat(executable)).mtimeMs-1000,'Native smoke predates executable');
const nativeBuild=await assertNativeBuild(root,output);
const sourceFiles=['native-shell/server.mjs'];
for(const directory of ['lib','dist']){const source=await treeFiles(directory,root),built=await treeFiles(directory,output);assert.deepEqual(built,source,'Built file set differs: '+directory);sourceFiles.push(...source);}
const browser=await assertV4BrowserEvidence(root);
const browserFiles=browser.distManifest;
assert(Array.isArray(browserFiles)&&browserFiles.length>0,'Browser frontend fingerprint missing');
assert.deepEqual(browserFiles.map(file=>file.path).sort(),(await treeFiles('dist',root)).filter(file=>/\.(?:m?js|css|html)$/i.test(file)).map(file=>file.slice('dist/'.length)).sort(),'Browser frontend file set is stale');
for(const file of browserFiles)assert.equal(await hash(path.join(root,'dist',file.path)),file.sha256,'Browser acceptance is stale: '+file.path);
const latestDist=Math.max(...await Promise.all((await treeFiles('dist',root)).map(async file=>(await stat(path.join(root,file))).mtimeMs)));
for(const file of [...await treeFiles('src',root),...await treeFiles('lib',root),'vite.config.js'])assert((await stat(path.join(root,file))).mtimeMs<=latestDist+1000,'Frontend source changed without rebuild: '+file);
for(const file of sourceFiles)assert((await readFile(path.join(output,file))).equals(await readFile(path.join(root,file))),`Build differs from source: ${file}`);
const expected=await runtimeInputs(root,output),expectedRuntimeCount=expected.size,verified=[];
for await(const entry of readOwnZip(archive)){
 assertArchivePath(entry.name);assert(expected.has(entry.name),`Unexpected distributed file: ${entry.name}`);
 assert.equal(sha(entry.bytes),await hash(expected.get(entry.name)),`ZIP mismatch: ${entry.name}`);expected.delete(entry.name);verified.push(entry.name);
}
assert.equal(expected.size,0,'Archive missing files: '+[...expected.keys()].join(', '));
assert.equal(verified.length,expectedRuntimeCount,'Runtime contract count differs');
const report={version,createdAt:new Date().toISOString(),architecture:'PE x64 (0x8664)',shell:'WinForms / system WebView2 (sandbox enabled)',nativeBuild,packagedSourceMatch:sourceFiles,archiveContractFiles:expectedRuntimeCount,archiveFilesVerified:verified.length,archiveBytes:(await stat(archive)).size,zipSha256:await hash(archive),exeSha256:await hash(executable),nativeSmokeTimestamp:smoke.timestamp,browserAcceptance:{passed:true,completedAt:browser.completedAt,frontendFilesVerified:browserFiles.length,scope:browser.scope,nativeOsClipboard:browser.clipboard?.nativeOsClipboard||'NOT TESTED',creativeStudioScreenshot:'v4-creative-studio.png',directorStageScreenshot:'v4-director-stage.png'},desktopAcceptance:'PASS: real WebMessage/C# host/Node; eight model settings checks including native modal cancel/save/clear, encrypted reopen, CAS and endpoint binding; nine canvas checks including five durable outputs. Native modal input uses a controlled WinForms test driver, not physical keyboard input',realModelServices:'NOT TESTED: protocol tests use controlled substitutes'};
const sums=[`${report.zipSha256}  ${runtimeArchiveName}`,`${report.exeSha256}  ${releaseName}/WhaleFlow.exe`];
if(process.argv.includes('--source')){
 const sourceZip=path.join(root,'release',sourceArchiveName),sourceExpected=await sourceInputs(root,output),expectedSourceCount=sourceExpected.size;let count=0;
 for await(const entry of readOwnZip(sourceZip)){
  assertArchivePath(entry.name,{source:true});assert(sourceExpected.has(entry.name),'Unexpected source path: '+entry.name);
  if(entry.name==='verification/artifact-verification.json'){
   // This report is packed before --source updates its own source ZIP digest.
   const packed=JSON.parse(entry.bytes.toString());assert.equal(packed.version,version);assert.equal(packed.zipSha256,report.zipSha256);assert.equal(packed.exeSha256,report.exeSha256);assert.deepEqual(packed.nativeBuild,nativeBuild);assert.equal(packed.archiveFilesVerified,verified.length);
  }else{
   assert.equal(sha(entry.bytes),await hash(sourceExpected.get(entry.name)),'Source ZIP mismatch: '+entry.name);
   if(entry.name==='verification/distribution-smoke.json'){
    const result=JSON.parse(entry.bytes.toString());assertNativeSmoke(result);assert.equal(result.exitCode,0);assert.equal(result.extractedArchive,runtimeArchiveName);assert.equal(result.extractedArchiveSha256,report.zipSha256,'Extracted smoke belongs to a different ZIP');
   }
  }
  sourceExpected.delete(entry.name);count++;
 }
 assert.equal(sourceExpected.size,0,'Source archive missing files: '+[...sourceExpected.keys()].join(', '));assert.equal(count,expectedSourceCount);
 report.sourceContractFiles=expectedSourceCount;report.sourceFilesVerified=count;report.sourceZipSha256=await hash(sourceZip);sums.push(`${report.sourceZipSha256}  ${sourceArchiveName}`);
}
await mkdir(path.join(root,'artifacts'),{recursive:true});await writeFile(path.join(root,'artifacts/artifact-verification.json'),JSON.stringify(report,null,2));await writeFile(path.join(root,'release/SHA256SUMS.txt'),sums.join('\n')+'\n');console.log(JSON.stringify(report,null,2));
