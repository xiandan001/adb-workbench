const { contextBridge, ipcRenderer } = require('electron');
const supportedLanguages = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR'];

contextBridge.exposeInMainWorld('startupOverlay', Object.freeze({
  initialLanguage: supportedLanguages.find(locale => typeof process !== 'undefined' && process.argv?.includes(`--app-language=${locale}`)) || 'zh-CN',
  ready: () => ipcRenderer.send('startup-overlay:ready'),
  finished: () => ipcRenderer.send('startup-overlay:finished'),
  onPlay: callback => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.once('startup-overlay:play', listener);
    return () => ipcRenderer.removeListener('startup-overlay:play', listener);
  },
}));
