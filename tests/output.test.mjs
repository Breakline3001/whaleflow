import test from 'node:test';
import assert from 'node:assert/strict';
import {outputView} from '../src/output.mjs';

test('output view tolerates legacy metadata without rendering objects as React children',()=>{
 for(const value of [null,undefined,4,'text',[]])assert.equal(outputView(value),undefined);
 const source={text:{privateMetadata:'retained'},demo:{enabled:true},plan:{title:{label:'x'},items:{not:'an array'}},custom:{retained:true}};
 const before=JSON.stringify(source),view=outputView(source);
 assert.equal(view.text,'');assert.equal(view.demo,false);assert.equal(view.plan.title,'结构化创作方案');assert.deepEqual(view.plan.items,[]);assert.deepEqual(view.custom,{retained:true});assert.equal(JSON.stringify(source),before);
});
test('plan view only renders finite times and string descriptions, with a bounded visible list',()=>{
 const items=[null,'bad',{description:42},{description:'valid',sourceId:{not:'text'},startSeconds:NaN,endSeconds:Infinity},...Array.from({length:600},(_,n)=>({description:'shot '+n,sourceId:'source',startSeconds:n,endSeconds:n+1}))];
 const view=outputView({text:'full output',plan:{title:'Plan',items}});
 assert.equal(view.text,'full output');assert.equal(view.plan.items.length,500);assert.deepEqual(view.plan.items[0],{description:'valid',sourceId:undefined,startSeconds:undefined,endSeconds:undefined});assert.equal(items.length,604);
});
test('media view does not turn arbitrary stored strings into remote resource requests',()=>{
 const view=outputView({image:'https://example.invalid/private',audio:'file:///audio.mp3',video:'javascript:alert(1)',images:['https://example.invalid/a','data:image/png;base64,AA==',null]});
 assert.equal(view.image,undefined);assert.equal(view.audio,undefined);assert.equal(view.video,undefined);assert.deepEqual(view.images,['data:image/png;base64,AA==']);
});
