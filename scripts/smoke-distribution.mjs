import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readOwnZip} from './read-own-zip.mjs';
import {runtimeArchiveName,assertArchivePath,assertNativeSmoke} from './archive-helpers.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const archive=path.join(root,'release',runtimeArchiveName);
async function hash(file){const digest=createHash('sha256');for await(const chunk of createReadStream(file))digest.update(chunk);return digest.digest('hex');}
const extractedArchiveSha256=await hash(archive);
const directory=await mkdtemp(path.join(root,'release/.extracted-smoke-'));
try{
 for await(const entry of readOwnZip(archive)){assertArchivePath(entry.name);const file=path.join(directory,entry.name);assert(file.startsWith(directory+path.sep));await mkdir(path.dirname(file),{recursive:true});await writeFile(file,entry.bytes);}
 const code=await new Promise((resolve,reject)=>{const child=spawn(path.join(directory,'WhaleFlow.exe'),['--smoke-test','--smoke-screenshot='+path.join(root,'artifacts/native-smoke.png')],{cwd:directory,stdio:'inherit'});child.on('error',reject);child.on('exit',resolve);});
 const report=JSON.parse(await readFile(path.join(directory,'artifacts/native-smoke.json'),'utf8'));
 assert.equal(await hash(archive),extractedArchiveSha256,'Archive changed during extracted acceptance');
 await mkdir(path.join(root,'artifacts'),{recursive:true});
 await writeFile(path.join(root,'artifacts/distribution-smoke.json'),JSON.stringify({...report,extractedArchive:runtimeArchiveName,extractedArchiveSha256,exitCode:code},null,2));
 assert.equal(code,0,'Extracted program did not exit successfully');assertNativeSmoke(report);console.log('[DISTRIBUTION_SMOKE] PASS: extracted ZIP starts and completes the real native workflow');
}finally{await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
