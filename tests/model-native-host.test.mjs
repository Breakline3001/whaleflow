import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import http from 'node:http';
import {createNativeServer} from '../native-shell/server.mjs';
import {createDefaultModelSettings} from '../lib/model-settings-schema.mjs';
import {node,project} from './helpers.mjs';

async function fixture(t) {
  const root=await mkdtemp(join(process.cwd(),'.model-host-test-'));
  const session=randomBytes(32).toString('base64');
  const host=await createNativeServer({session,dataDir:join(root,'Data'),readyPath:join(root,'ready.json'),smoke:true});
  t.after(async()=>{await host.close();await rm(root,{recursive:true,force:true});});
  const rpc=(method,args=[],authenticated=true)=>new Promise((resolve,reject)=>{
    const request=http.request(`${host.origin}/rpc`,{method:'POST',headers:{'Content-Type':'application/json',...(authenticated?{'X-WhaleFlow-Session':session}:{})}},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);
      response.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');resolve({status:response.statusCode,text,body:JSON.parse(text)});});
    });
    request.on('error',reject);request.end(JSON.stringify({method,args}));
  });
  return {...host,rpc};
}
function provider(baseUrl='https://controlled.example/v1') {
  return {id:'controlled',name:'Controlled metadata',protocol:'openai',baseUrl,auth:'none',allowInsecureHttpAuth:false,models:[{id:'same-model',name:'Model',roles:['text']}]};
}

test('native model RPC requires session; defaults and canonical validation do not expose a credential reader',async t=>{
  const f=await fixture(t);
  assert.equal((await f.rpc('models.defaults',[],false)).status,401);
  assert.deepEqual((await f.rpc('models.defaults')).body,{result:createDefaultModelSettings()});
  const doc=createDefaultModelSettings();doc.providers=[provider('https://controlled.example/v1///')];
  const validated=await f.rpc('models.validate',[doc]);
  assert.equal(validated.status,200);assert.equal(validated.body.result.providers[0].baseUrl,'https://controlled.example/v1');
  for(const method of ['models.get','credentials.read','models.save','getModelSettings']) assert.equal((await f.rpc(method)).status,400);
  assert.equal((await f.rpc('models.defaults',[{}])).status,400);
});

test('native settings validation, model lists and execution reject the private application origin',async t=>{
  const f=await fixture(t),doc=createDefaultModelSettings();doc.providers=[provider(`${f.origin}/v1`)];
  assert.equal((await f.rpc('models.validate',[doc])).status,400);
  assert.equal((await f.rpc('models.list',[{provider:doc.providers[0],credential:null,requestId:'self-origin'}])).status,400);
  assert.equal((await f.rpc('workflow.runConfigured',[project(),{revision:1,document:doc,credentials:{}}])).status,400);
  assert.deepEqual((await f.rpc('models.cancel',['already-finished'])).body,{result:null});
});

test('registered and retired model secrets protect RPC errors and project writes',async t=>{
  const f=await fixture(t),old='controlled-native-host-old-key-NOT-REAL',next='controlled-native-host-new-key-NOT-REAL';
  assert.deepEqual((await f.rpc('models.registerSecrets',[[old,next]])).body,{result:null});
  for(const marker of [old,next]) {
    const doc=createDefaultModelSettings();doc.providers=[{...provider(),name:marker}];
    const invalid=await f.rpc('models.validate',[doc]);
    assert.equal(invalid.status,400);assert.equal(invalid.text.includes(marker),false);
    const saved=await f.rpc('project.autosave',[project([node('a','text',{content:marker})])]);
    assert.equal(saved.status,400);assert.equal(saved.text.includes(marker),false);
  }
});

test('native configured execution preflights v2 model refs and keeps explicit DEMO offline',async t=>{
  const f=await fixture(t),doc=createDefaultModelSettings();doc.providers=[provider()];doc.defaults.text={providerId:'controlled',modelId:'same-model'};
  const snapshot={revision:1,document:doc,credentials:{}};
  const invalid={...project([node('a','text',{modelRef:{providerId:'deleted',modelId:'same-model'}})]),version:2};
  assert.equal((await f.rpc('workflow.runConfigured',[invalid,snapshot])).status,400);
  const offline=await f.rpc('workflow.runConfigured',[project([node('a','text',{provider:'demo',content:'Controlled offline test'})]),snapshot]);
  assert.equal(offline.status,200);assert.equal(typeof offline.body.result.runId,'string');
});
