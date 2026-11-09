// 历史记录持久化 IPC handlers
// 连接历史 + 终端命令历史

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

// 连接历史记录上限
const MAX_HISTORY_SIZE = 20;
// 终端命令历史记录上限
const MAX_TERMINAL_HISTORY_SIZE = 100;
const terminalFile = deviceId => String(deviceId || '').startsWith('hdc:') ? 'hdc_terminal_command_history.json' : 'terminal_command_history.json';

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

module.exports = { register };
