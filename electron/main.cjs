'use strict';
const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { CSP, assertLocalSender, isAllowedResource } = require('./security.cjs');
const { configureSmokeUserData, runSmokeIntegration } = require('./smoke.cjs');

const DIST_DIRECTORY = path.resolve(__dirname, '../dist');
const INDEX_FILE = path.join(DIST_DIRECTORY, 'index.html');
const INDEX_URL = pathToFileURL(INDEX_FILE).href;
const SMOKE = process.argv.includes('--smoke-test');
const SMOKE_SCREENSHOT = process.argv.find((argument) => argument.startsWith('--smoke-screenshot='))?.slice('--smoke-screenshot='.length);
const smokeEvents = [];
if (SMOKE) {
  const smokeDirectory = configureSmokeUserData(app);
  console.log(`[WHALEFLOW_SMOKE] isolated-userData ${smokeDirectory}`);
}

let window = null;
let engine;
let projectApi;
let currentFilePath = null;
let projectQueue = Promise.resolve();
let autosaveQueue = Promise.resolve();
let smokeFinished = false;
let smokeTimer;
let shutdownStarted = false;

function cleanError(error) {
  const text = error instanceof Error ? error.message : String(error);
  const key = process.env.WHALEFLOW_API_KEY;
  return new Error((key ? text.split(key).join('[REDACTED]') : text).slice(0, 1500));
}

function assertSender(event) {
  assertLocalSender(event, window, INDEX_URL);
}

function handle(channel, minArgs, maxArgs, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      assertSender(event);
      if (args.length < minArgs || args.length > maxArgs) throw new Error(`${channel} 参数数量无效`);
      return await callback(...args);
    } catch (error) { throw cleanError(error); }
  });
}

function enqueueProject(callback) {
  const next = projectQueue.then(callback);
  projectQueue = next.catch(() => {});
  return next;
}

function autosavePath() { return path.join(app.getPath('userData'), 'autosave.json'); }
function snapshot(project) {
  const serialized = projectApi.serializeProject(project);
  const key = process.env.WHALEFLOW_API_KEY;
  if (key && serialized.includes(key)) throw new Error('项目包含敏感 API 凭据，已拒绝保存；请从项目内容中移除');
  return projectApi.parseProject(serialized);
}

function registerIpc() {
  handle('project:open', 0, 0, () => enqueueProject(async () => {
    const result = await dialog.showOpenDialog(window, {
      title: '打开 WhaleFlow 项目', properties: ['openFile'], filters: [{ name: 'WhaleFlow JSON 项目', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    const project = await projectApi.readProject(filePath);
    currentFilePath = filePath;
    return { project, filePath };
  }));
  handle('project:save', 1, 2, (project, saveAs = false) => {
    if (typeof saveAs !== 'boolean') throw new Error('saveAs 必须是布尔值');
    const data = snapshot(project);
    return enqueueProject(async () => {
      let filePath = currentFilePath;
      if (saveAs || !filePath) {
        const safeName = data.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || 'Untitled';
        const result = await dialog.showSaveDialog(window, {
          title: '保存 WhaleFlow 项目', defaultPath: filePath || `${safeName}.json`, filters: [{ name: 'WhaleFlow JSON 项目', extensions: ['json'] }],
        });
        if (result.canceled || !result.filePath) return null;
        filePath = result.filePath;
        if (!path.extname(filePath)) filePath += '.json';
      }
      await projectApi.writeProject(filePath, data);
      currentFilePath = filePath;
      return { filePath };
    });
  });
  handle('project:autosave', 1, 1, (project) => {
    const data = snapshot(project);
    const next = autosaveQueue.then(() => projectApi.writeProject(autosavePath(), data));
    autosaveQueue = next.catch(() => {});
    return next;
  });
  handle('project:restore-autosave', 0, 0, async () => {
    await autosaveQueue;
    try { return await projectApi.readProject(autosavePath()); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  });
  handle('media:import', 0, 0, async () => {
    const result = await dialog.showOpenDialog(window, {
      title: '导入媒体（单文件最多 20 MiB）', properties: ['openFile'],
      filters: [{ name: '图像与视频', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'mp4', 'webm', 'mov', 'ogv'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return projectApi.importMediaFile(result.filePaths[0]);
  });
  handle('workflow:run', 2, 2, (project, config) => engine.run(project, config));
  handle('workflow:cancel', 0, 0, () => engine.cancel());
  handle('app:info', 0, 0, () => ({ version: app.getVersion(), platform: process.platform }));
}

function configureSession() {
  const localSession = session.defaultSession;
  localSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  localSession.setPermissionCheckHandler(() => false);
  localSession.on('will-download', (event) => event.preventDefault());
  localSession.webRequest.onBeforeRequest((details, callback) => {
    // Renderer assets are limited to the packaged dist directory. Node fetch in the main process is independent.
    callback({ cancel: !isAllowedResource(details.url, DIST_DIRECTORY) });
  });
  localSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) if (key.toLowerCase() === 'content-security-policy') delete headers[key];
    headers['Content-Security-Policy'] = [CSP];
    callback({ responseHeaders: headers });
  });
}

function finishSmoke(ok, detail) {
  if (smokeFinished) return;
  smokeFinished = true;
  clearTimeout(smokeTimer);
  const message = `[WHALEFLOW_SMOKE] ${ok ? 'PASS' : 'FAIL'} ${detail}`;
  (ok ? console.log : console.error)(message);
  app.exit(ok ? 0 : 1);
}

function createWindow() {
  currentFilePath = null;
  window = new BrowserWindow({
    title: 'WhaleFlow', width: 1512, height: 980, minWidth: 1100, minHeight: 700,
    backgroundColor: '#111318', show: !SMOKE, autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'), webSecurity: true,
      allowRunningInsecureContent: false, webviewTag: false, devTools: !app.isPackaged,
    },
  });
  window.setMenu(null);
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-frame-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('render-process-gone', (_event, details) => {
    engine.cancel().catch((error) => console.error(cleanError(error).message));
    if (SMOKE) finishSmoke(false, `renderer-gone:${details.reason}`);
  });
  contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (SMOKE && isMainFrame) finishSmoke(false, `renderer-load:${code} ${description}`);
  });
  contents.on('preload-error', (_event, _preloadPath, error) => {
    if (SMOKE) finishSmoke(false, `preload:${cleanError(error).message}`);
  });
  if (SMOKE) contents.once('did-finish-load', async () => {
    try {
      await runSmokeIntegration({ app, window, engine, events: smokeEvents, screenshotPath: SMOKE_SCREENSHOT });
      finishSmoke(true, 'app-ready renderer-loaded demo-workflow IPC autosave output-image button-reset');
    } catch (error) { finishSmoke(false, cleanError(error).message); }
  });
  window.on('closed', () => {
    window = null;
    currentFilePath = null;
    engine.cancel().catch((error) => console.error(cleanError(error).message));
  });
  window.loadFile(INDEX_FILE).catch((error) => {
    if (SMOKE) finishSmoke(false, cleanError(error).message);
    else { console.error(cleanError(error).message); dialog.showErrorBox('WhaleFlow 加载失败', '无法加载桌面界面，请先构建 dist/index.html。'); }
  });
}

if (SMOKE) {
  smokeTimer = setTimeout(() => finishSmoke(false, 'timeout:20s'), 20_000);
  smokeTimer.unref();
}

app.whenReady().then(async () => {
  if (SMOKE) console.log('[WHALEFLOW_SMOKE] app-ready');
  projectApi = await import(pathToFileURL(path.join(__dirname, '../lib/project.mjs')).href);
  const { WorkflowEngine } = await import(pathToFileURL(path.join(__dirname, '../lib/workflow.mjs')).href);
  engine = new WorkflowEngine({
    // The token is read only in the main process; never persisted or emitted in events.
    apiKey: SMOKE ? '' : process.env.WHALEFLOW_API_KEY || '',
    ...(SMOKE ? { fetchImpl: async () => { throw new Error('Smoke test 禁止调用真实模型网络'); } } : {}),
    onEvent(event) {
      if (SMOKE) smokeEvents.push(event);
      if (window && !window.isDestroyed()) window.webContents.send('workflow:event', event);
    },
    onError(error) { console.error('[workflow]', cleanError(error).message); },
  });
  configureSession();
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch((error) => {
  if (SMOKE) finishSmoke(false, cleanError(error).message);
  else { console.error(cleanError(error)); app.exit(1); }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin' || SMOKE) app.quit(); });
app.on('before-quit', (event) => {
  if (SMOKE || shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  // Flush already acknowledged save requests before terminating the process.
  Promise.all([engine?.cancel(), projectQueue, autosaveQueue])
    .catch((error) => console.error(cleanError(error).message))
    .finally(() => app.quit());
});
