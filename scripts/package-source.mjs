import {mkdir,mkdtemp,copyFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {zipDirectory,sourceInputs,buildOutput,sourceArchiveName,version} from './archive-helpers.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),release=path.join(root,'release');await mkdir(release,{recursive:true});
// Only explicit source trees and named verification evidence; never traverse Data,
// artifacts, dependencies or vendor. Synthetic credential markers in tests are valid source.
const inputs=await sourceInputs(root,buildOutput(root));
const stage=await mkdtemp(path.join(release,'.source-stage-'));
try{
 for(const [name,file]of inputs){await mkdir(path.dirname(path.join(stage,name)),{recursive:true});await copyFile(file,path.join(stage,name));}
 const destination=path.join(release,sourceArchiveName);await zipDirectory(stage,destination);console.log('[SOURCE_PACKAGE] '+JSON.stringify({version,file:destination,files:inputs.size}));
}finally{await rm(stage,{recursive:true,force:true});}
