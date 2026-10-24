const { tr } = require('./localization.cjs');
// 窗口控制 + 对话框 + shell 操作 IPC handlers
// 该模块聚合所有 UI 交互相关的 IPC：窗口最小化/最大化/关闭、文件对话框、拖拽、shell 打开

const { app, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const ctx = require('./app-context.cjs');

function register(ipcMain) {
  // Window controls
  ipcMain.handle('window:minimize', async () => {
    const mainWindow = ctx.getMainWindow();
    if (mainWindow) {
      mainWindow.minimize();
    }
  });

  ipcMain.handle('window:maximize', async () => {
    const mainWindow = ctx.getMainWindow();
    if (mainWindow) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
    }
  });

  ipcMain.handle('window:close', async () => {
    const mainWindow = ctx.getMainWindow();
    if (mainWindow) {
      mainWindow.close();
    }
  });

  // Open file dialog
  ipcMain.handle('dialog:openFile', async (event, options) => {
    const mainWindow = ctx.getMainWindow();
    const result = await dialog.showOpenDialog(mainWindow, {
      defaultPath: app.getPath('downloads'),
      properties: ['openFile'],
      filters: options?.filters || [{ name: tr('APK 文件'), extensions: ['apk'] }],
      ...options
    });
    return result;
  });

  // Open save dialog for pull
  ipcMain.handle('dialog:saveFile', async (event, options) => {
    const mainWindow = ctx.getMainWindow();
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: options?.defaultPath || '',
      filters: options?.filters || [{ name: tr('所有文件'), extensions: ['*'] }],
      ...options
    });
    return result;
  });

  // Handle dropped file path (for drag and drop in renderer)
  ipcMain.handle('dialog:getDroppedFilePath', async (event, fileName) => {
    const mainWindow = ctx.getMainWindow();
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: tr("选择 APK 文件"),
        defaultPath: path.join(app.getPath('downloads'), fileName),
        filters: [{ name: tr('APK 文件'), extensions: ['apk'] }],
        properties: ['openFile']
      });
      if (!result.canceled && result.filePaths.length > 0) {
        return { success: true, filePath: result.filePaths[0] };
      }
      return { success: false, filePath: fileName };
    } catch (error) {
      return { success: false, filePath: fileName, error: error.message };
    }
  });

  // Broadcast dropped file path to renderer
  ipcMain.on('drop:file', (event, filePath) => {
    const mainWindow = ctx.getMainWindow();
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('drop:file', filePath);
    }
  });

  // Handle drag leave event
  ipcMain.on('drag-leave', () => {
    const mainWindow = ctx.getMainWindow();
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('drag-leave');
    }
  });

  ipcMain.handle('dialog:selectFolder', async () => {
    const mainWindow = ctx.getMainWindow();
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: tr("选择截图保存路径")
      });
      if (result.canceled) {
        return { success: false, canceled: true };
      }
      return { success: true, path: result.filePaths[0] };
    } catch (error) {
      console.error('Failed to select folder:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('shell:openPath', async (event, folderPath) => {
    try {
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
      }
      const result = await shell.openPath(folderPath);
      if (result) {
        return { success: false, error: result };
      }
      return { success: true };
    } catch (error) {
      console.error('Failed to open folder:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('shell:ensureFolder', async (event, folderPath) => {
    try {
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
      }
      return { success: true };
    } catch (error) {
      console.error('Failed to ensure folder:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { register };
