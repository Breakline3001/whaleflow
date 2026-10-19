import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdir,readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
await mkdir(path.join(root,'artifacts'),{recursive:true});
const server=createServer(async(req,res)=>{try{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const file=path.resolve(root,'dist','.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(path.join(root,'dist')+path.sep))throw new Error('bad path');const body=await readFile(file);res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});res.end(body);}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const page=`http://127.0.0.1:${server.address().port}/`;
console.log('Temporary test-only page:',page);
const child=spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',[
 '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--hide-scrollbars',
 '--window-size=1512,980','--timeout=8000','--virtual-time-budget=4000',
 '--user-data-dir='+path.join(root,'artifacts','chrome-preview-profile'),
 '--screenshot='+path.join(root,'artifacts','canvas-preview.png'),page
],{stdio:'inherit'});
child.on('error',e=>{console.error(e);server.close();process.exitCode=1;});
child.on('exit',code=>{console.log('Chrome preview exit:',code);server.close();process.exitCode=code??1;});
process.on('SIGINT',()=>child.kill());process.on('SIGTERM',()=>child.kill());
