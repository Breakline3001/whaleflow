import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildOutput} from './archive-helpers.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const output=buildOutput(root);
const child=spawn(path.join(output,'WhaleFlow.exe'),args,{cwd:output,env,stdio:'inherit'});
child.on('error',e=>{console.error(e);process.exitCode=1;});child.on('exit',code=>{console.log('[NATIVE_RUN] exit='+code);process.exitCode=code??1;});process.on('SIGINT',()=>child.kill());process.on('SIGTERM',()=>child.kill());
