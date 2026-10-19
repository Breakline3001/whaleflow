import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkflowEngine} from '../lib/workflow.mjs';
import {createDefaultModelSettings} from '../lib/model-settings-schema.mjs';
import {node,project} from './helpers.mjs';

for(const mode of [{manual:true},{textMode:'manual'}]) test(`manual text ${Object.keys(mode)[0]} never requires a model or generates DEMO output`,async()=>{
  let fetches=0;const events=[];
  const engine=new WorkflowEngine({apiKey:'controlled-global-key-NOT-REAL',fetchImpl:async()=>{fetches++;throw Error('No manual text network');},onEvent:event=>events.push(event)});
  const document=createDefaultModelSettings();
  document.providers=[{id:'unused',name:'Unused missing-key provider',protocol:'openai',baseUrl:'https://controlled.example/v1',auth:'required',allowInsecureHttpAuth:false,models:[{id:'text-model',name:'Text',roles:['text']}]}];
  engine.runConfigured(project([node('a','text',{content:'Controlled manual text',...mode})]),{revision:1,document,credentials:{}});
  await engine.waitForIdle();
  const success=events.find(event=>event.nodeId==='a'&&event.status==='success');
  assert.ok(success);assert.equal(success.output.text,'Controlled manual text');assert.equal(success.output.demo,false);assert.equal(fetches,0);
});
