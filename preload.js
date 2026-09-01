const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');

// contextIsolation is enabled and nodeIntegration is disabled in the
// renderer for security, so the renderer has no require(). Settings.json
// is the single shared config source (also read directly by the Python
// backend), so we load it here in the preload's Node context and expose
// the plain data object across the isolation bridge.
const appSettings = require(path.join(__dirname, 'config', 'settings.json'));
contextBridge.exposeInMainWorld('APP_SETTINGS', appSettings);

contextBridge.exposeInMainWorld('electronAPI', {
  onMediaOpened: (cb) => ipcRenderer.on('media:opened', (_e, payload) => cb(payload)),
  onMenuSave: (cb) => ipcRenderer.on('menu:save', (_e, payload) => cb(payload)),
  onTranscriptLoaded: (cb) => ipcRenderer.on('transcript:loaded', (_e, payload) => cb(payload)),
  onAnalysisProgress: (cb) => ipcRenderer.on('backend:progress', (_e, payload) => cb(payload)),

  analyzeMedia: (filePath) => ipcRenderer.invoke('backend:analyze', { filePath }),
  cancelAnalysis: () => ipcRenderer.invoke('backend:cancel'),
  saveTranscript: (payload) => ipcRenderer.invoke('file:saveTranscript', payload)
});
