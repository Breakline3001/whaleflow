import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectorStage, validateDirectorStage } from '../lib/director-stage.mjs';
import { identity, multiply, modelMatrix, normalMatrix, cameraBasis, viewMatrix, perspective, createBoxGeometry, createSphereGeometry } from '../src/director-webgl.mjs';
const transform = (m, v) => [0,1,2,3].map(r => v.reduce((sum,n,c) => sum + m[c*4+r]*n, 0));
const close = (a,b) => a.forEach((n,i) => assert.ok(Math.abs(n-b[i]) < 1e-8, `${n} != ${b[i]}`));
test('default stage is valid, independent, and JSON portable', () => {
  const a=createDirectorStage(), b=createDirectorStage();
  a.objects[0].position[0]=9;assert.equal(b.objects[0].position[0],0);
  assert.equal(validateDirectorStage(JSON.parse(JSON.stringify(a))).valid,true);
  const source={camera:b.camera};const c=createDirectorStage(source);c.camera.target[0]=99;assert.equal(b.camera.target[0],0);
});
test('schema rejects malformed documents and unsafe geometry inputs', () => {
  for(const value of [null,[],{},'stage'])assert.equal(validateDirectorStage(value).valid,false);
  const mutations=[s=>s.revision=-1,s=>s.revision=0.5,s=>s.objects.push({...s.objects[0]}),s=>s.objects[0].type='mesh',s=>s.objects[0].position=[1,2],s=>s.objects[0].position[0]=Infinity,s=>s.objects[0].rotation[1]=NaN,s=>s.objects[0].scale[0]=0,s=>s.camera.elevation=Math.PI/2,s=>s.camera.distance=0,s=>s.camera.fov=180,s=>s.camera.target=[0,0,'0'],s=>s.grid='yes',s=>s.aspectRatio=0,s=>s.background='url(x)',s=>s.panoramaNodeId=''];
  for(const mutate of mutations){const s=createDirectorStage();mutate(s);assert.equal(validateDirectorStage(s).valid,false,mutate.toString());}
  assert.throws(()=>createDirectorStage({camera:{}}),TypeError);
});
test('schema accepts all supported object types and panorama association',()=>{
  const s=createDirectorStage({objects:['person','box','sphere','plane'].map((type,i)=>({id:`o${i}`,type,name:type,position:[i,0,0],rotation:[0,Math.PI,0],scale:[1,2,1]})),panoramaNodeId:'panorama-1'});
  assert.equal(validateDirectorStage(s).valid,true);
});
test('column-major model composition rotates, scales, and translates geometry',()=>{
  const m=modelMatrix([3,4,5],[0,0,Math.PI/2],[2,3,4]);
  close(transform(m,[1,0,0,1]),[3,6,5,1]);
  close(multiply(identity(),m),m);close(multiply(m,identity()),m);
  close(normalMatrix(modelMatrix([1,2,3],[0,0,0],[2,3,4])),[0.5,0,0,0,1/3,0,0,0,0.25]);
});
test('inverse-transpose normals stay perpendicular under nonuniform scale',()=>{
  const m=modelMatrix([0,0,0],[0.3,0.5,0.2],[2,3,4]),n=normalMatrix(m);
  const normal=[n[0],n[1],n[2]], tangent=[m[4],m[5],m[6]];
  assert.ok(Math.abs(normal.reduce((sum,v,i)=>sum+v*tangent[i],0))<1e-8);
});
test('orbit camera basis is orthonormal and view maps eye to origin',()=>{
  const c=createDirectorStage().camera,b=cameraBasis(c);
  close(transform(viewMatrix(c),[...b.eye,1]),[0,0,0,1]);
  const target=transform(viewMatrix(c),[...c.target,1]);close(target,[0,0,-c.distance,1]);
  for(const axis of [b.right,b.up,b.back])assert.ok(Math.abs(Math.hypot(...axis)-1)<1e-8);
  assert.ok(Math.abs(b.right.reduce((sum,n,i)=>sum+n*b.up[i],0))<1e-8);
});
test('perspective maps near and far to WebGL clip depth',()=>{
  const p=perspective(60,16/9,0.1,100);
  const near=transform(p,[0,0,-0.1,1]),far=transform(p,[0,0,-100,1]);
  assert.ok(Math.abs(near[2]/near[3]+1)<1e-8);assert.ok(Math.abs(far[2]/far[3]-1)<1e-8);assert.ok(p.every(Number.isFinite));
});
test('box and sphere meshes carry finite per-vertex unit normals',()=>{
  for(const g of [createBoxGeometry(),createSphereGeometry()]) {
    assert.equal(g.positions.length,g.normals.length);assert.equal(g.positions.length%9,0);assert.ok(g.positions.every(Number.isFinite));
    for(let i=0;i<g.normals.length;i+=3)assert.ok(Math.abs(Math.hypot(...g.normals.slice(i,i+3))-1)<1e-8);
  }
  const box=createBoxGeometry();assert.equal(box.positions.length/3,36);
  assert.ok(createSphereGeometry().positions.every(n=>Math.abs(n)<=0.5));
});
