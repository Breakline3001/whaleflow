import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import security from '../electron/security.cjs';
const { isIndexUrl, assertLocalSender, isAllowedResource, CSP } = security;
const dist = resolve('dist');
const index = pathToFileURL(join(dist, 'index.html')).href;

function fixture() {
  const frame = { url: index };
  const contents = { mainFrame: frame };
  const window = { isDestroyed: () => false, webContents: contents };
  return { window, event: { sender: contents, senderFrame: frame } };
}

test('IPC sender must be the exact live desktop window and its local main frame', () => {
  const { window, event } = fixture();
  assert.doesNotThrow(() => assertLocalSender(event, window, index));
  event.senderFrame.url += '#canvas';
  assert.doesNotThrow(() => assertLocalSender(event, window, index));
  assert.throws(() => assertLocalSender({ ...event, sender: {} }, window, index), /拒绝/);
  assert.throws(() => assertLocalSender({ ...event, senderFrame: { url: index } }, window, index), /拒绝/);
  assert.throws(() => assertLocalSender(event, null, index), /拒绝/);
  assert.throws(() => assertLocalSender(event, { ...window, isDestroyed: () => true }, index), /拒绝/);
  for (const url of ['https://example.test', 'about:blank', 'data:text/html,hello', `${index}?untrusted=1`, pathToFileURL(join(dist, 'other.html')).href]) {
    event.senderFrame.url = url;
    assert.throws(() => assertLocalSender(event, window, index), /拒绝/);
    assert.equal(isIndexUrl(url, index), false);
  }
});

test('renderer resources stay inside dist or self-contained schemes, never network or parent directories', () => {
  assert.equal(isAllowedResource(index, dist), true);
  assert.equal(isAllowedResource(pathToFileURL(join(dist, 'assets', 'index.js')).href, dist), true);
  assert.equal(isAllowedResource(pathToFileURL(join(dist, '..', 'package.json')).href, dist), false);
  assert.equal(isAllowedResource(pathToFileURL(join(dist, '..', 'dist-evil', 'index.js')).href, dist), false);
  for (const url of ['https://example.test', 'http://localhost:11434/api/chat', 'javascript:alert(1)', 'not a URL']) assert.equal(isAllowedResource(url, dist), false);
  assert.equal(isAllowedResource('data:image/png;base64,aGVsbG8=', dist), true);
});

test('CSP disallows renderer connections, frames, workers, objects, and inline scripts', () => {
  for (const rule of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "object-src 'none'", "worker-src 'none'", "base-uri 'none'", "script-src 'self'"]) assert(CSP.includes(rule));
  assert(!CSP.includes('unsafe-eval')); assert(!/script-src[^;]*unsafe-inline/.test(CSP));
});
