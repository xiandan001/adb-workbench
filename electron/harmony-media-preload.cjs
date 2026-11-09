const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name, args) => ipcRenderer.invoke('harmony-media:' + name, args);
const listen = (name, callback) => {
  if (typeof callback !== 'function') throw new TypeError('INVALID_CALLBACK');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on('harmony-media:' + name, listener);
  return () => ipcRenderer.removeListener('harmony-media:' + name, listener);
};
contextBridge.exposeInMainWorld('harmonyMedia', {
  init: () => invoke('init'), ready: () => invoke('ready'), ack: args => invoke('ack', args),
  stop: () => invoke('stop'), close: () => invoke('close'), input: args => invoke('input', args),
  recordStart: args => invoke('record-start', args), recordStop: () => invoke('record-stop'),
  recordChunk: args => invoke('record-chunk', args), recordEnd: args => invoke('record-end', args),
  recordResponse: args => invoke('record-response', args),
  onFrame: callback => listen('frame', callback), onState: callback => listen('state', callback),
  onLocale: callback => listen('locale', callback), onRecordCommand: callback => listen('record-command', callback),
  onRecordingState: callback => listen('record-state', callback)
});
