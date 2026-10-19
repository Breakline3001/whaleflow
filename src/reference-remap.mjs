// Remap canvas identifiers without modifying narrative or model IDs.
export function remapCreativeReferences(data,mapping){
 const visit=(value,key='')=>{if(Array.isArray(value))return value.map(item=>visit(item));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,visit(v,k)]));if(typeof value==='string'&&['referenceNodeId','panoramaNodeId','directorNodeId','studioNodeId','sourceNodeId','creativeDraftFor'].includes(key))return mapping.get(value)||value;return value;};
 return visit(data);
}
