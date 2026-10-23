const { createSshProfileStore } = require('./ssh-profiles.cjs');
const { createSshController } = require('./ssh-controller.cjs');
const { createSshCommandHistory } = require('./ssh-command-history.cjs');
const { ask } = require('./app-message-dialog.cjs');

let controller;
function register(ipcMain) {
  const { app, dialog, safeStorage, shell } = require('electron');
  const { Client } = require('ssh2');
  const ctx = require('./app-context.cjs');
  const { createSshSessionService } = require('./ssh-session.cjs');
  const { createSshFiles } = require('./ssh-files.cjs');
  const getOwner = () => ctx.getMainWindow();
  const encryptedStorage = { directory: app.getPath('userData'),
    canEncrypt: () => safeStorage.isEncryptionAvailable() && (!safeStorage.getSelectedStorageBackend || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) };
  const profiles = createSshProfileStore(encryptedStorage);
  const history = createSshCommandHistory(encryptedStorage);
  const sessions = createSshSessionService({ createClient: () => new Client(), resolveProfile: args => args.config,
    shouldRememberCommands: identity => {
      try { return !history.list(identity).paused; } catch { return false; }
    },
    verifyHostKey: challenge => profiles.verifyHostKey(challenge, async () => {
      const result = await ask({ type: 'warning', title: '首次连接：核对 SSH 主机指纹',
        message: `${challenge.username}@${challenge.host}:${challenge.port}`,
        detail: `此主机尚未被信任，请与服务器管理员核对以下指纹。\n\n${challenge.keyType}\n${challenge.fingerprint}\n\n确认后会将指纹保存在本机；以后指纹变化将拒绝连接。`,
        buttons: ['取消连接', '指纹正确，信任并连接'], defaultId: 0, cancelId: 0, noLink: true });
      return result.response === 1 && !challenge.signal?.aborted;
    }), onChange: () => controller?.publish(), onShellCommand: event => { void controller?.recordShellCommand(event); } });
  const watchedFileSessions = new Set();
  const files = createSshFiles({ getSftp: id => {
    const context = sessions.getSessionContext(id);
    if (!watchedFileSessions.has(id)) {
      watchedFileSessions.add(id);
      context.signal.addEventListener('abort', () => { files.disposeSession(id); watchedFileSessions.delete(id); }, { once: true });
    }
    return sessions.getSftp(id);
  }, assertSession: id => sessions.getSessionContext(id).assertCurrent(),
    onChange: event => controller?.publish(event) });
  controller = createSshController({ sessions, files, profiles, history, getOwner,
    openLocalDirectory: directory => shell.openPath(directory),
    dialogs: { ask, open: options => dialog.showOpenDialog(getOwner(), options) },
    onPublish: (snapshot, owner) => owner.webContents.send('ssh:changed', snapshot) });
  controller.register(ipcMain);
}
module.exports = {
  register,
  needsQuitConfirmation: () => controller?.needsQuitConfirmation() || false,
  confirmQuit: ask => controller?.confirmQuit(ask) ?? true,
  reserveForMigration: () => controller?.reserveForMigration() || (() => {}),
  cleanup: async () => controller?.dispose()
};
