'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Only purpose-specific messages cross the isolation boundary. No raw IPC, fs, env or token API.
const desktop = {
  openProject: () => ipcRenderer.invoke('project:open'),
  saveProject: (project, saveAs = false) => ipcRenderer.invoke('project:save', project, saveAs),
  autosave: (project) => ipcRenderer.invoke('project:autosave', project),
  restoreAutosave: () => ipcRenderer.invoke('project:restore-autosave'),
  importMedia: () => ipcRenderer.invoke('media:import'),
  runWorkflow: (project, config) => ipcRenderer.invoke('workflow:run', project, config),
  cancelWorkflow: () => ipcRenderer.invoke('workflow:cancel'),
  onWorkflowEvent: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('onWorkflowEvent callback 必须是函数');
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('workflow:event', listener);
    let subscribed = true;
    return () => {
      if (subscribed) ipcRenderer.removeListener('workflow:event', listener);
      subscribed = false;
    };
  },
  getAppInfo: () => ipcRenderer.invoke('app:info'),
};
contextBridge.exposeInMainWorld('desktop', Object.freeze(desktop));
