'use strict';
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "media-src 'self' data: blob:", "font-src 'self' data:",
  "connect-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
  "frame-src 'none'", "frame-ancestors 'none'", "worker-src 'none'",
].join('; ');

function isIndexUrl(value, indexUrl) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href === indexUrl;
  } catch { return false; }
}

function assertLocalSender(event, window, indexUrl) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !isIndexUrl(event.senderFrame?.url, indexUrl)) {
    throw new Error('拒绝来自非本地桌面主窗口的 IPC 请求');
  }
}

function isAllowedResource(value, distDirectory) {
  try {
    const url = new URL(value);
    if (url.protocol === 'file:') {
      const relative = path.relative(distDirectory, fileURLToPath(url));
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    }
    return ['data:', 'blob:', 'devtools:'].includes(url.protocol);
  } catch { return false; }
}

module.exports = { CSP, isIndexUrl, assertLocalSender, isAllowedResource };
