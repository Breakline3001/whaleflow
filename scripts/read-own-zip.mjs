// Bounded validator for our generated classic ZIPs, not an extractor for arbitrary archives.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {inflateRawSync} from 'node:zlib';
export async function* readOwnZip(file){
 const data=await readFile(file);assert(data.length<512*1024*1024,'ZIP exceeds validator bound');
 let end=-1;for(let offset=data.length-22;offset>=Math.max(0,data.length-65557);offset--)if(data.readUInt32LE(offset)===0x06054b50&&offset+22+data.readUInt16LE(offset+20)===data.length){end=offset;break;}
 assert(end>=0,'ZIP end record missing');assert.equal(data.readUInt16LE(end+4),0);assert.equal(data.readUInt16LE(end+6),0);
 const count=data.readUInt16LE(end+10),size=data.readUInt32LE(end+12);let cursor=data.readUInt32LE(end+16);
 assert(count!==65535&&cursor!==0xffffffff,'ZIP64 is not supported');assert.equal(cursor+size,end,'Unexpected central directory layout');
 const seen=new Set();let total=0;
 for(let index=0;index<count;index++){
  assert.equal(data.readUInt32LE(cursor),0x02014b50,'Bad ZIP central header');
  const flags=data.readUInt16LE(cursor+8),method=data.readUInt16LE(cursor+10),compressed=data.readUInt32LE(cursor+20),expanded=data.readUInt32LE(cursor+24),nameLength=data.readUInt16LE(cursor+28),extra=data.readUInt16LE(cursor+30),comment=data.readUInt16LE(cursor+32),local=data.readUInt32LE(cursor+42);
  assert(!(flags&1),'Encrypted entry rejected');assert(method===0||method===8,'Unsupported ZIP compression');
  const name=data.toString('utf8',cursor+46,cursor+46+nameLength).replaceAll('\\','/');cursor+=46+nameLength+extra+comment;
  assert(name&&!name.startsWith('/')&&!name.includes(':')&&!name.split('/').includes('..'),'Unsafe ZIP path');
  assert(!seen.has(name.toLowerCase()),'Duplicate ZIP entry');seen.add(name.toLowerCase());
  if(name.endsWith('/'))continue;
  assert(expanded<=128*1024*1024,'Entry exceeds validator bound');total+=expanded;assert(total<=512*1024*1024,'Expanded ZIP exceeds validator bound');
  assert.equal(data.readUInt32LE(local),0x04034b50,'Bad ZIP local header');assert.equal(data.readUInt16LE(local+8),method);
  const start=local+30+data.readUInt16LE(local+26)+data.readUInt16LE(local+28);assert(start+compressed<=end-size,'Invalid compressed range');
  const bytes=method===0?data.subarray(start,start+compressed):inflateRawSync(data.subarray(start,start+compressed),{maxOutputLength:Math.max(1,expanded)});
  assert.equal(bytes.length,expanded,'Incorrect uncompressed length');yield {name,bytes};
 }
 assert.equal(cursor,end,'ZIP entry count mismatch');
}
