// 历史记录持久化 IPC handlers
// 连接历史 + 终端命令历史

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const ctx = require('./app-context.cjs');

// 连接历史记录上限
const MAX_HISTORY_SIZE = 20;
// 终端命令历史记录上限
const MAX_TERMINAL_HISTORY_SIZE = 100;
const terminalFile = deviceId => String(deviceId || '').startsWith('hdc:') ? 'hdc_terminal_command_history.json' : 'terminal_command_history.json';

// A history id is a millisecond timestamp; the device id disambiguates older rows.
function removeConnectionEntry(file, entry, io = fs) {
  if (!entry || Object.keys(entry).length !== 2 || typeof entry.id !== 'string' || !entry.id || entry.id.length > 200 ||
    typeof entry.deviceId !== 'string' || !entry.deviceId || entry.deviceId.length > 1024) return { success: false, code: 'INVALID_ENTRY' };
  let temporary, fd;
  try {
    let stat;
    try { stat = io.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return { success: true, data: [] }; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw Error('INVALID_HISTORY');
    const data = JSON.parse(new TextDecoder('utf-8', { fatal:true }).decode(io.readFileSync(file)));
    if (!Array.isArray(data)) throw Error('INVALID_HISTORY');
    const matches = data.filter(row => row.id === entry.id && row.deviceId === entry.deviceId);
    if (matches.length > 1) return { success: false, code: 'AMBIGUOUS_ENTRY' };
    if (matches.length === 1) {
      data.splice(data.indexOf(matches[0]), 1);
      const candidate = path.join(path.dirname(file), '.connection-history-' + randomUUID() + '.tmp');
      fd = io.openSync(candidate, 'wx', 0o600); temporary = candidate;
      io.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8'); io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
      const current = io.lstatSync(file);
      if (current.ino !== stat.ino || current.dev !== stat.dev || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) throw Error('HISTORY_CHANGED');
      io.renameSync(temporary, file); temporary = undefined;
    }
    return { success: true, data };
  } catch { return { success: false, code: 'HISTORY_UNAVAILABLE' }; }
  finally { if (fd !== undefined) { try { io.closeSync(fd); } catch { /* Original file untouched. */ } } if (temporary) { try { io.unlinkSync(temporary); } catch { /* Do not modify the original file. */ } } }
}

function register(ipcMain) {
  // 连接历史记录持久化
  ipcMain.handle('history:save', async (event, entry) => {
    try {
      const userDataPath = app.getPath('userData');
      const historyFilePath = path.join(userDataPath, 'connection_history.json');
      let history = [];
      if (fs.existsSync(historyFilePath)) {
        const data = fs.readFileSync(historyFilePath, 'utf-8');
        history = JSON.parse(data);
      }
      const newEntry = {
        id: Date.now().toString(),
        deviceId: entry.deviceId,
        transport: String(entry.deviceId || '').startsWith('hdc:') ? 'hdc' : 'adb',
        deviceName: entry.deviceName || entry.deviceId,
        ip: entry.ip || null,
        type: entry.type || 'usb',
        timestamp: new Date().toISOString()
      };
      const existingIndex = history.findIndex(h => h.deviceId === newEntry.deviceId);
      if (existingIndex !== -1) {
        history.splice(existingIndex, 1);
      }
      history.unshift(newEntry);
      if (history.length > MAX_HISTORY_SIZE) {
        history = history.slice(0, MAX_HISTORY_SIZE);
      }
      fs.writeFileSync(historyFilePath, JSON.stringify(history, null, 2), 'utf-8');
      return { success: true };
    } catch (error) {
      console.error('Failed to save connection history:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('history:load', async () => {
    try {
      const userDataPath = app.getPath('userData');
      const historyFilePath = path.join(userDataPath, 'connection_history.json');
      if (fs.existsSync(historyFilePath)) {
        const data = fs.readFileSync(historyFilePath, 'utf-8');
        const history = JSON.parse(data);
        return { success: true, data: history };
      }
      return { success: true, data: [] };
    } catch (error) {
      console.error('Failed to load connection history:', error);
      return { success: false, error: error.message, data: [] };
    }
  });

  ipcMain.handle('history:clear', async () => {
    try {
      const userDataPath = app.getPath('userData');
      const historyFilePath = path.join(userDataPath, 'connection_history.json');
      if (fs.existsSync(historyFilePath)) {
        fs.unlinkSync(historyFilePath);
      }
      return { success: true };
    } catch (error) {
      console.error('Failed to clear connection history:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('history:remove', (event, entry) => {
    const owner = ctx.getMainWindow(), frame = event.senderFrame;
    if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed() || owner.webContents !== event.sender || !frame || frame !== owner.webContents.mainFrame) return { success: false, code: 'NOT_AUTHORIZED' };
    const page = frame.url.split('#')[0];
    if (page !== pathToFileURL(path.join(app.getAppPath(), 'dist/index.html')).href && !(ctx.isDev && page === 'http://localhost:5173/')) return { success: false, code: 'NOT_AUTHORIZED' };
    return removeConnectionEntry(path.join(app.getPath('userData'), 'connection_history.json'), entry);
  });

  // 终端命令历史记录持久化
  ipcMain.handle('terminalHistory:save', async (event, command) => {
    try {
      const userDataPath = app.getPath('userData');
      const historyFilePath = path.join(userDataPath, terminalFile(command?.deviceId));
      let history = [];
      if (fs.existsSync(historyFilePath)) {
        const data = fs.readFileSync(historyFilePath, 'utf-8');
        history = JSON.parse(data);
      }
      const trimmedCmd = (typeof command === 'object' ? command.command : command || '').trim();
      if (!trimmedCmd) {
        return { success: true };
      }
      const existIndex = history.indexOf(trimmedCmd);
      if (existIndex !== -1) {
        history.splice(existIndex, 1);
      }
      history.unshift(trimmedCmd);
      if (history.length > MAX_TERMINAL_HISTORY_SIZE) {
        history = history.slice(0, MAX_TERMINAL_HISTORY_SIZE);
      }
      fs.writeFileSync(historyFilePath, JSON.stringify(history, null, 2), 'utf-8');
      return { success: true };
    } catch (error) {
      console.error('Failed to save terminal command history:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('terminalHistory:load', async (_event, args) => {
    try {
      const userDataPath = app.getPath('userData');
      const historyFilePath = path.join(userDataPath, terminalFile(args?.deviceId));
      if (fs.existsSync(historyFilePath)) {
        const data = fs.readFileSync(historyFilePath, 'utf-8');
        const history = JSON.parse(data);
        return { success: true, data: history };
      }
      return { success: true, data: [] };
    } catch (error) {
      console.error('Failed to load terminal command history:', error);
      return { success: false, error: error.message, data: [] };
    }
  });

  ipcMain.handle('terminalHistory:clear', async (_event, args) => {
    try {
      const userDataPath = app.getPath('userData');
      const historyFilePath = path.join(userDataPath, terminalFile(args?.deviceId));
      if (fs.existsSync(historyFilePath)) {
        fs.unlinkSync(historyFilePath);
      }
      return { success: true };
    } catch (error) {
      console.error('Failed to clear terminal command history:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { register, removeConnectionEntry };
