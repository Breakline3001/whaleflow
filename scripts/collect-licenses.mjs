import {readFile,readdir,mkdir,copyFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),out=path.join(root,'third-party-licenses');
await mkdir(out,{recursive:true});
const lock=JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8'));
const collected=[];
for(const [relative,meta] of Object.entries(lock.packages)){
 if(!relative||meta.dev)continue;
 const directory=path.join(root,relative);
 const files=(await readdir(directory)).filter(n=>/^(license|licence|copying|notice)(\.|$)/i.test(n));
 for(const name of files){const target=relative.replace(/^node_modules\//,'').replaceAll('/','__')+'__'+name;await copyFile(path.join(directory,name),path.join(out,target));collected.push({package:relative,version:meta.version,file:target});}
}
// Electron is an experimental build-only fallback, not part of the native release.
await rm(path.join(out,'electron-LICENSE'),{force:true});
await writeFile(path.join(out,'INDEX.json'),JSON.stringify(collected,null,2));
console.log(`Collected ${collected.length} original notices.`);
