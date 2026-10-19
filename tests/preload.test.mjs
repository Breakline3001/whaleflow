import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

async function loadBridge() {
  const calls = [];
  const ipc = new EventEmitter();
  ipc.invoke = (channel, ...args) => { calls.push([channel, ...args]); return Promise.resolve({ ok: true }); };
  let name; let desktop;
  const electron = { ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (key, value) => { name = key; desktop = value; } } };
  const source = await readFile(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  vm.runInNewContext(source, { require: (id) => { assert.equal(id, 'electron'); return electron; } });
  return { ipc, calls, name, desktop };
}

test('preload exposes only the explicit desktop contract, with no token/env/raw IPC access', async () => {
  const { name, desktop, calls } = await loadBridge();
  assert.equal(name, 'desktop'); assert.equal(Object.isFrozen(desktop), true);
  assert.deepEqual(Object.keys(desktop).sort(), ['openProject', 'saveProject', 'autosave', 'restoreAutosave', 'importMedia', 'runWorkflow', 'cancelWorkflow', 'onWorkflowEvent', 'getAppInfo'].sort());
  const p = { version: 1 }; const config = { provider: 'demo' };
  await desktop.openProject(); await desktop.saveProject(p); await desktop.saveProject(p, true);
  await desktop.autosave(p); await desktop.restoreAutosave(); await desktop.importMedia();
  await desktop.runWorkflow(p, config); await desktop.cancelWorkflow(); await desktop.getAppInfo();
  assert.deepEqual(calls, [['project:open'], ['project:save', p, false], ['project:save', p, true], ['project:autosave', p], ['project:restore-autosave'], ['media:import'], ['workflow:run', p, config], ['workflow:cancel'], ['app:info']]);
});

test('event subscriptions hide Electron event objects and unsubscribe idempotently', async () => {
  const { ipc, desktop } = await loadBridge();
  const received = [];
  const unsubscribe = desktop.onWorkflowEvent((...args) => received.push(args));
  const payload = { runId: 'run', nodeId: 'node', status: 'running' };
  ipc.emit('workflow:event', { sender: 'must not cross bridge' }, payload);
  assert.deepEqual(received, [[payload]]);
  unsubscribe(); unsubscribe();
  ipc.emit('workflow:event', {}, payload);
  assert.equal(received.length, 1); assert.equal(ipc.listenerCount('workflow:event'), 0);
  assert.throws(() => desktop.onWorkflowEvent('not-a-function'), /必须是函数/);
});
