export const node = (id, kind = 'prompt', data = {}) => ({ id, type: 'workflow', position: { x: 0, y: 0 }, data: { kind, title: id, content: `${id} content`, ...data } });
export const edge = (source, target, id = `${source}-${target}`) => ({ id, source, target });
export const project = (nodes = [node('a')], edges = []) => ({ version: 1, name: '测试项目', nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } });
export const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
