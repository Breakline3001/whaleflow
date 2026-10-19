// Dependency-free WebGL1 renderer and column-major matrix helpers.
export const identity = () => [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
export function multiply(a,b) {
  const out = new Array(16).fill(0);
  for(let c=0;c<4;c++) for(let r=0;r<4;r++) for(let k=0;k<4;k++) out[c*4+r]+=a[k*4+r]*b[c*4+k];
  return out;
}
export function modelMatrix(position,rotation,scale) {
  const [x,y,z]=rotation, cx=Math.cos(x),sx=Math.sin(x),cy=Math.cos(y),sy=Math.sin(y),cz=Math.cos(z),sz=Math.sin(z);
  const rx=[1,0,0,0,0,cx,sx,0,0,-sx,cx,0,0,0,0,1];
  const ry=[cy,0,-sy,0,0,1,0,0,sy,0,cy,0,0,0,0,1];
  const rz=[cz,sz,0,0,-sz,cz,0,0,0,0,1,0,0,0,0,1];
  const m=multiply(multiply(rz,ry),rx);
  for(let c=0;c<3;c++) for(let r=0;r<3;r++) m[c*4+r]*=scale[c];
  m[12]=position[0];m[13]=position[1];m[14]=position[2];return m;
}
const subtract=(a,b)=>a.map((n,i)=>n-b[i]);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot=(a,b)=>a.reduce((sum,n,i)=>sum+n*b[i],0);
const normalize=a=>{const l=Math.hypot(...a);return a.map(n=>n/l);};
export function cameraBasis(camera) {
  const {azimuth:a,elevation:e,distance:d,target:t}=camera;
  const eye=[t[0]+d*Math.cos(e)*Math.sin(a),t[1]+d*Math.sin(e),t[2]+d*Math.cos(e)*Math.cos(a)];
  const back=normalize(subtract(eye,t)),right=normalize(cross([0,1,0],back)),up=cross(back,right);
  return {eye,back,right,up};
}
export function viewMatrix(camera) {
  const {eye,back:z,right:x,up:y}=cameraBasis(camera);
  return [x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,-dot(x,eye),-dot(y,eye),-dot(z,eye),1];
}
export function perspective(fov,aspect,near=0.05,far=5000) {
  const f=1/Math.tan(fov*Math.PI/360),nf=1/(near-far);
  return [f/aspect,0,0,0,0,f,0,0,0,0,(far+near)*nf,-1,0,0,2*far*near*nf,0];
}
export function normalMatrix(m) {
  const a=m.slice(0,3),b=m.slice(4,7),c=m.slice(8,11),bc=cross(b,c),det=dot(a,bc);
  return [...bc,...cross(c,a),...cross(a,b)].map(n=>n/det);
}
export function createBoxGeometry() {
  const positions=[],normals=[];
  for(const [normal,u,v] of [ [[1,0,0],[0,1,0],[0,0,1]], [[-1,0,0],[0,0,1],[0,1,0]], [[0,1,0],[0,0,1],[1,0,0]], [[0,-1,0],[1,0,0],[0,0,1]], [[0,0,1],[1,0,0],[0,1,0]], [[0,0,-1],[0,1,0],[1,0,0]] ]) {
    for(const [s,t] of [[-1,-1],[1,-1],[1,1],[-1,-1],[1,1],[-1,1]]) {
      positions.push(...normal.map((n,i)=>(n+s*u[i]+t*v[i])/2));normals.push(...normal);
    }
  }
  return {positions,normals};
}
export function createSphereGeometry(rows=16,columns=24) {
  const positions=[],normals=[];
  const vertex=(r,c)=>{const p=r/rows*Math.PI,t=c/columns*Math.PI*2;return [Math.sin(p)*Math.cos(t),Math.cos(p),Math.sin(p)*Math.sin(t)];};
  for(let r=0;r<rows;r++) for(let c=0;c<columns;c++) for(const [i,j] of [[r,c],[r+1,c],[r+1,c+1],[r,c],[r+1,c+1],[r,c+1]]) {const v=vertex(i,j);positions.push(...v.map(n=>n/2));normals.push(...v);}
  return {positions,normals};
}
function shaderProgram(gl,vertex,fragment) {
  const shaders=[];
  try {
    for(const [type,source] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]) {const s=gl.createShader(type);shaders.push(s);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)||'Shader compile failed');}
    const p=gl.createProgram();for(const s of shaders)gl.attachShader(p,s);gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS)){const error=gl.getProgramInfoLog(p);gl.deleteProgram(p);throw new Error(error||'Shader link failed');}return p;
  } finally {for(const s of shaders)gl.deleteShader(s);}
}
export function createDirectorRenderer(canvas,{onStatus=()=>{}}={}) {
  const gl=canvas.getContext('webgl',{alpha:false,antialias:true,preserveDrawingBuffer:true});
  if(!gl) throw new Error('此设备无法创建 WebGL1 上下文。');
  const program=shaderProgram(gl,`attribute vec3 aPosition;attribute vec3 aNormal;uniform mat4 uMVP;uniform mat3 uNormal;varying vec3 vNormal;void main(){gl_Position=uMVP*vec4(aPosition,1.0);vNormal=uNormal*aNormal;}`,`precision mediump float;varying vec3 vNormal;uniform vec3 uColor;uniform float uLit;void main(){float light=mix(1.0,0.3+0.7*max(dot(normalize(vNormal),normalize(vec3(0.5,1.0,0.7))),0.0),uLit);gl_FragColor=vec4(uColor*light,1.0);}`);
  const bgProgram=shaderProgram(gl,`attribute vec2 aPosition;varying vec2 vUV;void main(){vUV=aPosition;gl_Position=vec4(aPosition,0.0,1.0);}`,`precision mediump float;varying vec2 vUV;uniform sampler2D uTexture;uniform vec3 uRight;uniform vec3 uUp;uniform vec3 uBack;uniform float uTan;uniform float uAspect;void main(){vec3 d=normalize(uRight*vUV.x*uTan*uAspect+uUp*vUV.y*uTan-uBack);vec2 uv=vec2(0.5+atan(d.x,-d.z)/6.2831853,0.5-asin(clamp(d.y,-1.0,1.0))/3.14159265);gl_FragColor=texture2D(uTexture,uv);}`);
  const buffers=[];
  function buffer(data){const b=gl.createBuffer();buffers.push(b);gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data),gl.STATIC_DRAW);return b;}
  function mesh(g){return {position:buffer(g.positions),normal:buffer(g.normals),count:g.positions.length/3};}
  const box=mesh(createBoxGeometry()),sphere=mesh(createSphereGeometry()),plane=mesh({positions:[-0.5,0,-0.5,0.5,0,0.5,0.5,0,-0.5,-0.5,0,-0.5,-0.5,0,0.5,0.5,0,0.5],normals:Array.from({length:6},()=>[0,1,0]).flat()});
  const lines=[];for(let i=-10;i<=10;i++)lines.push(-10,0,i,10,0,i,i,0,-10,i,0,10);
  const grid=mesh({positions:lines,normals:lines.map((_,i)=>i%3===1?1:0)}),quad=buffer([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]);
  const loc={};for(const name of ['uMVP','uNormal','uColor','uLit'])loc[name]=gl.getUniformLocation(program,name);
  const position=gl.getAttribLocation(program,'aPosition'),normal=gl.getAttribLocation(program,'aNormal');
  let texture=null,image=null,generation=0,disposed=false,lastStage=null,lastSelection=null;
  function drawMesh(g,model,color,lit=true,mode=gl.TRIANGLES){
    gl.bindBuffer(gl.ARRAY_BUFFER,g.position);gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,3,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.ARRAY_BUFFER,g.normal);gl.enableVertexAttribArray(normal);gl.vertexAttribPointer(normal,3,gl.FLOAT,false,0,0);
    gl.uniformMatrix4fv(loc.uMVP,false,new Float32Array(multiply(vp,model)));gl.uniformMatrix3fv(loc.uNormal,false,new Float32Array(normalMatrix(model)));gl.uniform3fv(loc.uColor,color);gl.uniform1f(loc.uLit,lit?1:0);gl.drawArrays(mode,0,g.count);
  }
  let vp=identity();
  function render(stage,selectedId=null){
    if(disposed || gl.isContextLost())return;
    lastStage=stage;lastSelection=selectedId;
    gl.viewport(0,0,canvas.width,canvas.height);
    const color=stage.background.slice(1).match(/../g).map(n=>parseInt(n,16)/255);
    gl.clearColor(...color,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    if(texture){
      gl.disable(gl.DEPTH_TEST);gl.useProgram(bgProgram);const p=gl.getAttribLocation(bgProgram,'aPosition');gl.bindBuffer(gl.ARRAY_BUFFER,quad);gl.enableVertexAttribArray(p);gl.vertexAttribPointer(p,2,gl.FLOAT,false,0,0);
      const basis=cameraBasis(stage.camera);for(const key of ['right','up','back'])gl.uniform3fv(gl.getUniformLocation(bgProgram,`u${key[0].toUpperCase()+key.slice(1)}`),basis[key]);
      gl.uniform1f(gl.getUniformLocation(bgProgram,'uTan'),Math.tan(stage.camera.fov*Math.PI/360));gl.uniform1f(gl.getUniformLocation(bgProgram,'uAspect'),stage.aspectRatio);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);gl.uniform1i(gl.getUniformLocation(bgProgram,'uTexture'),0);gl.drawArrays(gl.TRIANGLES,0,6);gl.disableVertexAttribArray(p);
    }
    gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.disable(gl.CULL_FACE);gl.useProgram(program);
    vp=multiply(perspective(stage.camera.fov,stage.aspectRatio),viewMatrix(stage.camera));
    if(stage.grid)drawMesh(grid,modelMatrix([0,-0.006,0],[0,0,0],[1,1,1]),[0.26,0.28,0.3],false,gl.LINES);
    for(const object of stage.objects){
      const model=modelMatrix(object.position,object.rotation,object.scale),color=object.id===selectedId?[0.53,0.81,0.96]:object.type==='person'?[0.77,0.8,0.84]:[0.67,0.61,0.51];
      if(object.type==='person'){
        // Articulated mannequin assembled from actual solid meshes; feet rest on y=0.
        const part=(g,p,s)=>drawMesh(g,multiply(model,modelMatrix(p,[0,0,0],s)),color);
        part(sphere,[0,1.61,0],[0.32,0.38,0.32]);part(box,[0,1.12,0],[0.47,0.62,0.25]);part(box,[0,0.77,0],[0.38,0.15,0.23]);
        for(const sign of [-1,1]){part(box,[sign*0.135,0.38,0],[0.16,0.72,0.19]);part(box,[sign*0.345,1.08,0],[0.15,0.67,0.18]);part(box,[sign*0.135,0.06,0.06],[0.18,0.12,0.34]);}
      } else drawMesh(object.type==='sphere'?sphere:object.type==='plane'?plane:box,model,color);
    }
    gl.flush();
  }
  function setBackground(url){
    const token=++generation;if(image){image.onload=null;image.onerror=null;}if(texture){gl.deleteTexture(texture);texture=null;}if(lastStage)render(lastStage,lastSelection);
    if(!url){onStatus('');return;}
    onStatus('正在加载等距柱状背景…');image=new Image();image.crossOrigin='anonymous';
    image.onload=()=>{
      if(disposed||token!==generation)return;
      let candidate=null;
      try {if(image.width>gl.getParameter(gl.MAX_TEXTURE_SIZE)||image.height>gl.getParameter(gl.MAX_TEXTURE_SIZE))throw new Error('背景尺寸超出 GPU 限制');candidate=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,candidate);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);if(gl.getError()!==gl.NO_ERROR)throw new Error('背景纹理上传失败');texture=candidate;onStatus('全景背景已加载；仅提供环境，不重建几何。');if(lastStage)render(lastStage,lastSelection);}
      catch(error){if(candidate)gl.deleteTexture(candidate);onStatus(`背景不可用：${error.message}`);}
    };
    image.onerror=()=>{if(token===generation&&!disposed)onStatus('背景加载失败（需要可读取的本地资源或允许 CORS 的 URL）。');};image.src=url;
  }
  return {render,setBackground,capture(stage){const selection=lastSelection;render(stage,null);try {gl.finish();return canvas.toDataURL('image/png');}finally{render(stage,selection);}},dispose(){disposed=true;generation++;if(image){image.onload=null;image.onerror=null;}for(const b of buffers)gl.deleteBuffer(b);if(texture)gl.deleteTexture(texture);gl.deleteProgram(program);gl.deleteProgram(bgProgram);}};
}
