const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createSshShortcutGuard } = require('./ssh-shortcuts.cjs');

const ACTIVE_TRANSFERS = new Set(['queued', 'planning', 'running', 'preparing', 'transferring', 'cancelling']);
function createSshController({ sessions, files, profiles, history, getOwner, dialogs, onPublish = () => {} }) {
  let revision = 0;
  let subscribed = false;
  let timer;
  let migrationReserved = false;
  let pendingConnections = 0;
  let disposed = false;
  const drafts = new Map();
  const fileRevisions = new Map();
  const historyRevisions = new Map();
  const historyWarnings = new Map();
  const historyTasks = new Set();
  const enablingTerminals = new Set();
  const keys = new Map();
  const mutations = new Set();
  const terminalClosing = new Set();
  const sessionClosing = new Set();
  const shortcuts = createSshShortcutGuard({ getOwner, isTerminalReady: (sessionId, terminalId) => sessions.snapshot().sessions.some(session => session.id === sessionId && session.status === 'connected' && session.terminals.some(terminal => terminal.id === terminalId && terminal.status === 'ready')) });
  const snapshot = () => ({ revision, profiles: profiles.list(), sessions: sessions.snapshot().sessions, transfers: files.listTransfers(), fileRevisions: Object.fromEntries(fileRevisions), historyRevisions: Object.fromEntries(historyRevisions) });
  const getSession = id => {
    const session = sessions.snapshot().sessions.find(item => item.id === id);
    if (!session) throw new Error('SSH 会话已关闭，请重新选择连接');
    return session;
  };
  const writableSession = id => {
    const session = getSession(id);
    if (sessionClosing.has(id)) throw new Error('正在关闭此 SSH 会话，请稍候');
    if (session.status !== 'connected') throw new Error('SSH 会话尚未连接或已断开');
    return session;
  };
  const identityOf = session => ({ host: session.host, port: session.port, username: session.username });
  const identityKey = identity => JSON.stringify([identity.host, identity.port, identity.username]);
  const historyIdentity = sessionId => {
    if (!history) throw new Error('SSH 命令历史服务不可用');
    const session = getSession(sessionId);
    if (!session.host || !session.username) throw new Error('SSH 连接信息尚未就绪');
    return identityOf(session);
  };
  function historyChanged(identity) {
    for (const session of sessions.snapshot().sessions) {
      if (identityKey(identityOf(session)) === identityKey(identity)) historyRevisions.set(session.id, (historyRevisions.get(session.id) || 0) + 1);
    }
    publish();
  }
  async function readHistory(identity) {
    const result = await history.list(identity);
    return { ...result, ...(historyWarnings.has(identityKey(identity)) ? { warning: historyWarnings.get(identityKey(identity)) } : {}) };
  }
  function recordShellCommand(event) {
    if (disposed || !history) return Promise.resolve();
    const task = (async () => {
      let identity;
      try {
        const session = getSession(event.sessionId);
        if (session.status !== 'connected') return;
        if (!session.terminals.some(item => item.id === event.terminalId && item.status === 'ready')) return;
        identity = identityOf(session);
        // This callback is main-only and receives authenticated Shell markers, not renderer text or raw keystrokes.
        const result = await history.record(identity, event.command);
        if (result.recorded) { historyWarnings.delete(identityKey(identity)); historyChanged(identity); }
      } catch {
        if (identity) { historyWarnings.set(identityKey(identity), '命令历史保存未完成；终端仍可使用，请检查本机存储后重试'); historyChanged(identity); }
      }
    })().finally(() => historyTasks.delete(task));
    historyTasks.add(task); return task;
  }
  function authorize(event) {
    const owner = getOwner();
    if (!owner || owner.isDestroyed() || event.sender !== owner.webContents || event.senderFrame && event.senderFrame !== owner.webContents.mainFrame) throw new Error('请在主窗口操作 SSH 工作区');
  }
  function publish(event) {
    if (event?.type === 'files-changed' && typeof event.sessionId === 'string') fileRevisions.set(event.sessionId, (fileRevisions.get(event.sessionId) || 0) + 1);
    revision++;
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      shortcuts.validate();
      if (!subscribed) return;
      const owner = getOwner();
      if (!owner || owner.isDestroyed()) return;
      try { onPublish(snapshot(), owner); } catch { /* A closed or reloading owner cannot receive notifications. */ }
    }, 80);
    timer.unref?.();
  }
  const busyTransfers = id => files.listTransfers().filter(item => (!id || item.sessionId === id) && ACTIVE_TRANSFERS.has(item.status));
  const dirtyCount = id => id ? (drafts.get(id)?.length || 0) : [...drafts.values()].reduce((sum, paths) => sum + paths.length, 0);
  const needsQuitConfirmation = () => pendingConnections > 0 || historyTasks.size > 0 || sessions.needsQuitConfirmation() || busyTransfers().length > 0 || dirtyCount() > 0 || mutations.size > 0;
  function reserveForMigration() {
    if (needsQuitConfirmation()) throw new Error('请先保存 SSH 草稿、完成文件操作并断开所有 SSH 连接，再导入数据');
    migrationReserved = true;
    return () => { migrationReserved = false; };
  }
  async function confirmQuit(ask) {
    if (!needsQuitConfirmation()) return true;
    const result = await ask({ type: 'warning', title: '退出 SSH 工作区？',
      message: '退出会断开所有 SSH 连接并停止传输。',
      detail: `未保存文件：${dirtyCount()} 个；进行中的传输：${busyTransfers().length} 个。未保存内容不会自动写回远端，请先返回工作区保存。`,
      buttons: ['返回保存', '断开并退出'], defaultId: 0, cancelId: 0, noLink: true });
    return result.response === 1;
  }
  async function credential(args, event) {
    const auth = args?.auth;
    if (!auth) return undefined;
    if (typeof auth !== 'object') throw new Error('SSH 凭据无效');
    const result = {};
    if (auth.password !== undefined) result.password = auth.password;
    if (auth.passphrase !== undefined) result.passphrase = auth.passphrase;
    if (auth.keyToken !== undefined) {
      const key = keys.get(auth.keyToken);
      if (!key || key.expires < Date.now() || key.sender !== event.sender) throw new Error('选择的私钥已失效，请重新选择');
      result.privateKey = key.bytes.toString('utf8');
    }
    return result;
  }
  async function selectKey(event) {
    const result = await dialogs.open({ title: '选择 SSH 私钥（不会上传或展示私钥内容）', properties: ['openFile'] });
    if (result.canceled || !result.filePaths?.[0]) return { cancelled: true };
    authorize(event);
    const selected = result.filePaths[0];
    const stat = await fs.lstat(selected);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || !stat.size) throw new Error('请选择不超过 1 MiB 的普通私钥文件');
    const handle = await fs.open(selected, 'r');
    let bytes;
    try {
      const actual = await handle.stat();
      if (!actual.isFile() || actual.size !== stat.size || actual.ino !== stat.ino) throw new Error('私钥文件已变化，请重新选择');
      bytes = Buffer.alloc(actual.size);
      const read = await handle.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead !== bytes.length) throw new Error('私钥文件读取不完整');
    } finally { await handle.close(); }
    for (const [id, key] of keys) if (key.expires < Date.now() || keys.size >= 8) { key.bytes.fill(0); keys.delete(id); }
    const keyToken = randomUUID();
    keys.set(keyToken, { bytes, sender: event.sender, expires: Date.now() + 15 * 60 * 1000 });
    return { keyToken, name: path.basename(selected) };
  }
  async function resolveConnection(args, event) {
    const supplied = await credential(args, event);
    authorize(event);
    if (migrationReserved || disposed) throw new Error('SSH 工作区正在退出或导入数据');
    const resolved = profiles.resolve({ profileId: args.profileId, profile: args.profile, credential: supplied });
    if (args.saveProfile === true) {
      const profile = profiles.save({ profile: args.profile || resolved, credential: supplied,
        rememberCredentials: args.rememberCredentials === true });
      resolved.id = profile.id; resolved.profileId = profile.id;
      publish();
    }
    return resolved;
  }
  async function confirmDisconnect(sessionId, remove) {
    const session = getSession(sessionId);
    if (sessionClosing.has(sessionId)) throw new Error('正在关闭此 SSH 会话，请稍候');
    if (mutations.has(sessionId)) throw new Error('远端文件操作正在完成，请稍候再断开');
    sessionClosing.add(sessionId);
    try {
      const dirty = dirtyCount(sessionId);
      const transfers = busyTransfers(sessionId).length;
      if (dirty || transfers) {
        const result = await dialogs.ask({ type: 'warning', title: remove ? '关闭 SSH 会话？' : '断开 SSH 连接？',
          message: `${session.name} · ${session.username}@${session.host}:${session.port}`,
          detail: `此会话有 ${dirty} 个未保存文件、${transfers} 项进行中的传输。${remove ? '关闭会丢弃草稿。' : '断开后草稿仍保留在本页，但不能继续保存至已断开的连接。'}传输将停止。`,
          buttons: ['返回保存', remove ? '丢弃草稿并关闭' : '断开连接'], defaultId: 0, cancelId: 0, noLink: true });
        if (result.response !== 1) return { cancelled: true };
      }
      if (mutations.has(sessionId)) throw new Error('远端文件操作正在完成，请稍候再断开');
      getSession(sessionId);
      shortcuts.clearSession(sessionId);
      await files.disposeSession(sessionId);
      await sessions.disconnect({ sessionId });
      if (remove) { await sessions.removeSession({ sessionId }); drafts.delete(sessionId); fileRevisions.delete(sessionId); historyRevisions.delete(sessionId); }
      publish();
      return {};
    } finally { sessionClosing.delete(sessionId); }
  }
  function register(ipcMain) {
    const handle = (channel, operation, { mutation = false, offline = false } = {}) => ipcMain.handle(`ssh:${channel}`, async (event, raw = {}) => {
      const args = raw || {};
      let lock;
      try {
        authorize(event);
        if (disposed) throw new Error('SSH 工作区正在退出');
        if (!offline && migrationReserved) throw new Error('数据导入已准备，请重启应用后再操作 SSH');
        if (mutation) {
          getSession(args.sessionId);
          if (sessionClosing.has(args.sessionId)) throw new Error('正在关闭此 SSH 会话，请稍候');
          if (mutations.has(args.sessionId)) throw new Error('当前 SSH 文件操作尚未结束，请稍候');
          lock = args.sessionId; mutations.add(lock);
        }
        return { success: true, ...await operation(args, event) };
      } catch (error) {
        return { success: false, error: error.message || 'SSH 操作失败', ...(error.code ? { code: String(error.code) } : {}) };
      } finally { if (lock) mutations.delete(lock); }
    });
    handle('snapshot', () => snapshot(), { offline: true });
    handle('subscribe', args => {
      if (typeof args.active !== 'boolean') throw new Error('SSH 订阅参数无效');
      subscribed = args.active;
      if (!subscribed) shortcuts.reset();
      return snapshot();
    }, { offline: true });
    handle('select-key', (_args, event) => selectKey(event));
    handle('save-profile', async (args, event) => {
      profiles.save({ profile: args.profile, credential: await credential(args, event), rememberCredentials: args.rememberCredentials === true });
      publish(); return { profiles: profiles.list() };
    });
    handle('delete-profile', async args => {
      const profile = profiles.list().find(item => item.id === args.profileId);
      if (!profile) throw new Error('连接配置不存在');
      const result = await dialogs.ask({ type: 'question', title: '删除已保存连接？', message: profile.name,
        detail: '仅删除本机连接配置和保存凭据，不会删除服务器数据，也不会断开已连接会话。',
        buttons: ['取消', '删除连接'], defaultId: 0, cancelId: 0, noLink: true });
      if (result.response !== 1) return { cancelled: true };
      profiles.remove(args.profileId); publish(); return { profiles: profiles.list() };
    });
    handle('connect', async (args, event) => {
      pendingConnections++;
      try {
        const config = await resolveConnection(args, event);
        authorize(event);
        if (migrationReserved || disposed) throw new Error('SSH 工作区正在退出或导入数据');
        // Resolved credentials stay inside main; service receives no renderer trust decision.
        return await sessions.connect({ config });
      } finally { pendingConnections--; }
    });
    handle('disconnect', args => confirmDisconnect(args.sessionId, false));
    handle('close-session', args => confirmDisconnect(args.sessionId, true));
    handle('open-terminal', args => { writableSession(args.sessionId); return sessions.openTerminal(args); });
    handle('close-terminal', async args => {
      const session = getSession(args.sessionId);
      const terminal = session.terminals.find(item => item.id === args.terminalId);
      if (!terminal) throw new Error('终端已关闭');
      if (terminalClosing.has(args.terminalId)) return { cancelled: true };
      terminalClosing.add(args.terminalId);
      try {
        if (['ready', 'opening'].includes(terminal.status)) {
          const result = await dialogs.ask({ type: 'question', title: '关闭 SSH 终端？', message: `${session.name} · ${terminal.title}`,
            detail: '终端中运行的任务可能随终端关闭而结束。其他终端和文件传输不受影响。',
            buttons: ['取消', '关闭终端'], defaultId: 0, cancelId: 0, noLink: true });
          if (result.response !== 1) return { cancelled: true };
        }
        return await sessions.closeTerminal(args);
      } finally { terminalClosing.delete(args.terminalId); }
    });
    handle('terminal-read', args => sessions.terminalRead(args), { offline: true });
    handle('terminal-write', args => sessions.terminalWrite(args));
    handle('terminal-resize', args => sessions.terminalResize(args));
    handle('terminal-focus', (args, event) => { shortcuts.set(args, event.sender); return {}; }, { offline: true });
    handle('history-list', args => readHistory(historyIdentity(args.sessionId)), { offline: true });
    handle('history-remove', async args => {
      const identity = historyIdentity(args.sessionId); await history.remove(identity, args.id);
      historyWarnings.delete(identityKey(identity)); historyChanged(identity); return readHistory(identity);
    });
    handle('history-pause', async args => {
      if (typeof args.paused !== 'boolean') throw new Error('命令历史暂停状态无效');
      const identity = historyIdentity(args.sessionId); await history.setPaused(identity, args.paused);
      historyChanged(identity); return readHistory(identity);
    });
    handle('history-clear', async (args, event) => {
      const identity = historyIdentity(args.sessionId);
      const result = await dialogs.ask({ type: 'warning', title: '清空此主机的 SSH 命令历史？',
        message: `${identity.username}@${identity.host}:${identity.port}`,
        detail: '仅清除本机为此主机保存的命令历史，不修改服务器历史，也不影响其他主机。',
        buttons: ['取消', '清空历史'], defaultId: 0, cancelId: 0, noLink: true });
      if (result.response !== 1) return { cancelled: true };
      authorize(event); historyIdentity(args.sessionId);
      await history.clear(identity); historyWarnings.delete(identityKey(identity)); historyChanged(identity); return readHistory(identity);
    });
    handle('enable-shell-integration', async (args, event) => {
      const session = writableSession(args.sessionId);
      const findTerminal = () => writableSession(args.sessionId).terminals.find(item => item.id === args.terminalId);
      const terminal = findTerminal();
      if (!terminal || terminal.status !== 'ready' || terminalClosing.has(args.terminalId)) throw new Error('SSH 终端尚未就绪或正在关闭');
      if (enablingTerminals.has(args.terminalId)) throw new Error('正在启用命令识别，请稍候');
      if (terminal.shellIntegration?.status === 'ready') return { shellIntegration: terminal.shellIntegration };
      enablingTerminals.add(args.terminalId);
      try {
        const result = await dialogs.ask({ type: 'info', title: '启用此 SSH 终端的命令识别？',
          message: `${session.name} · ${terminal.title}`,
          detail: '仅支持 Bash 4.4 或更新版本。请确保当前为空的 Bash 命令提示符，没有未提交的命令，也不在密码输入或交互程序中。\n\n将通过 SFTP 创建并清理专用临时脚本，仅为当前终端安装命令边界识别，不修改 .bashrc 等启动文件。识别后的命令可在本机加密记录；命令参数也可能包含敏感内容，可随时暂停或清空历史。',
          buttons: ['取消', '启用当前终端'], defaultId: 0, cancelId: 0, noLink: true });
        if (result.response !== 1) return { cancelled: true };
        authorize(event);
        const current = findTerminal();
        if (!current || current.status !== 'ready' || terminalClosing.has(args.terminalId) || current.queuedBytes) throw new Error('终端状态已变化或仍有待发送输入，请稍候重试');
        return await sessions.enableShellIntegration({ sessionId: args.sessionId, terminalId: args.terminalId });
      } finally { enablingTerminals.delete(args.terminalId); }
    });
    handle('set-drafts', args => {
      getSession(args.sessionId);
      if (!Array.isArray(args.paths) || args.paths.length > 32 || args.paths.some(value => typeof value !== 'string' || value.length > 4096 || value.includes('\0'))) throw new Error('SSH 草稿状态无效');
      drafts.set(args.sessionId, [...new Set(args.paths)]); return {};
    }, { offline: true });
    handle('list', args => files.list(args));
    handle('preview', args => files.preview(args));
    handle('open-document', args => files.openDocument(args));
    handle('close-document', args => files.closeDocument(args), { offline: true });
    handle('save-document', args => files.saveDocument(args), { mutation: true });
    handle('mkdir', args => files.mkdir(args), { mutation: true });
    handle('create-file', args => files.createFile(args), { mutation: true });
    handle('move', async args => {
      const session = getSession(args.sessionId);
      const result = await dialogs.ask({ type: 'question', title: '移动或重命名远端文件？', message: `${session.name} · ${session.host}`,
        detail: `${args.source}\n→ ${args.destination}\n不会自动覆盖已存在目标。`, buttons: ['取消', '移动'], defaultId: 0, cancelId: 0, noLink: true });
      if (result.response !== 1) return { cancelled: true };
      return files.move(args);
    }, { mutation: true });
    handle('delete', async args => {
      const session = getSession(args.sessionId);
      const plan = await files.planDelete(args);
      const result = await dialogs.ask({ type: 'warning', title: '永久删除远端文件？', message: `${session.name} · ${session.host}`,
        detail: `路径：${args.path}\n删除无法从本机回收站恢复，目录中的内容也会删除。请核对主机与路径。`,
        buttons: ['取消', '永久删除'], defaultId: 0, cancelId: 0, noLink: true });
      if (result.response !== 1) return { cancelled: true };
      return files.confirmDelete({ sessionId: args.sessionId, planId: plan.planId });
    }, { mutation: true });
    handle('upload', async (args, event) => {
      writableSession(args.sessionId);
      const result = await dialogs.open({ title: '选择上传到当前 SSH 主机的文件',
        properties: args.kind === 'directory' ? ['openDirectory'] : ['openFile', 'multiSelections'] });
      if (result.canceled || !result.filePaths?.length) return { cancelled: true };
      authorize(event); writableSession(args.sessionId);
      return files.startTransfer({ sessionId: args.sessionId, direction: 'upload', sources: result.filePaths, destination: args.destination, overwrite: false });
    });
    handle('upload-dropped', async (args, event) => {
      const session = writableSession(args.sessionId);
      if (!Array.isArray(args.paths) || !args.paths.length || args.paths.length > 200 || args.paths.some(value => typeof value !== 'string' || !path.isAbsolute(value))) throw new Error('拖入文件无效');
      const result = await dialogs.ask({ type: 'question', title: '上传拖入的文件？', message: `${session.name} · ${session.host}`,
        detail: `${args.paths.slice(0, 10).join('\n')}${args.paths.length > 10 ? `\n另 ${args.paths.length - 10} 项` : ''}\n目标目录：${args.destination}`,
        buttons: ['取消', '上传'], defaultId: 0, cancelId: 0, noLink: true });
      if (result.response !== 1) return { cancelled: true };
      authorize(event); writableSession(args.sessionId);
      return files.startTransfer({ sessionId: args.sessionId, direction: 'upload', sources: args.paths, destination: args.destination, overwrite: false });
    });
    handle('download', async (args, event) => {
      writableSession(args.sessionId);
      const result = await dialogs.open({ title: '选择下载保存目录', properties: ['openDirectory', 'createDirectory'] });
      if (result.canceled || !result.filePaths?.[0]) return { cancelled: true };
      authorize(event); writableSession(args.sessionId);
      return files.startTransfer({ sessionId: args.sessionId, direction: 'download', sources: args.sources, destination: result.filePaths[0], overwrite: false });
    });
    handle('cancel-transfer', args => files.cancelTransfer(args));
    handle('retry-transfer', async args => {
      const transfer = files.listTransfers().find(item => item.id === args.transferId);
      if (!transfer) throw new Error('传输记录不存在');
      const session = writableSession(transfer.sessionId);
      let overwrite = false;
      if (transfer.status === 'conflict' || transfer.code === 'CONFLICT' || transfer.code === 'EXISTS') {
        const result = await dialogs.ask({ type: 'warning', title: '覆盖已存在的目标文件？', message: `${session.name} · ${session.host}`,
          detail: `${transfer.source}\n→ ${transfer.target}\n重试可能覆盖本次传输中冲突的文件，已成功的文件不会重新传输。`,
          buttons: ['取消', '覆盖并重试'], defaultId: 0, cancelId: 0, noLink: true });
        if (result.response !== 1) return { cancelled: true };
        overwrite = true;
      }
      writableSession(transfer.sessionId);
      return files.retryTransfer({ transferId: args.transferId, overwrite });
    });
  }
  async function dispose() {
    disposed = true;
    shortcuts.dispose();
    clearTimeout(timer); subscribed = false;
    for (const key of keys.values()) key.bytes.fill(0);
    keys.clear(); drafts.clear();
    await Promise.allSettled([...historyTasks]);
    try { await files.dispose(); }
    finally { await sessions.dispose(); }
  }
  return { register, publish, snapshot, recordShellCommand, needsQuitConfirmation, confirmQuit, reserveForMigration, dispose };
}

module.exports = { createSshController };
