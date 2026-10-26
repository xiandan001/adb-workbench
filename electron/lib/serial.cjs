const { tr } = require('./localization.cjs');
const path = require('node:path');
const { writeSerialSnapshot } = require('./serial-export.cjs');

const WORKSPACES = ['rs232', 'terminal'];

function createSerialController({ workspaces, getOwner, saveSnapshot }) {
  let subscribed = false;
  let subscriber;
  let saving = false;
  let migrationReserved = false;
  const watched = new WeakSet();
  const authorize = event => {
    const owner = getOwner();
    if (!owner || owner.isDestroyed() || event.sender !== owner.webContents) throw new Error(tr("请在主窗口操作串口"));
  };
  async function saveCurrent(workspace = 'rs232') {
    const service = workspaces.get(workspace);
    if (saving) throw new Error(tr("正在保存串口记录，请稍候"));
    saving = true;
    try {
      service.sealReceive();
      const snapshot = workspaces.snapshot(workspace);
      if (!snapshot.entries.length) throw new Error(tr("当前工作区暂无可保存的串口记录"));
      const result = await saveSnapshot(snapshot);
      if (result.success && !result.cancelled) service.markSaved(snapshot.revision);
      return result;
    } finally { saving = false; }
  }
  async function saveAll() {
    const states = workspaces.snapshots();
    const dirty = WORKSPACES.filter(workspace => states[workspace].unsaved && states[workspace].entries.length);
    const candidates = dirty.length ? dirty : WORKSPACES.filter(workspace => states[workspace].entries.length);
    for (const workspace of candidates) {
      const result = await saveCurrent(workspace);
      if (!result.success || result.cancelled) return result;
    }
    return { success: true };
  }
  function publish(delta) {
    const owner = getOwner();
    if (!WORKSPACES.includes(delta?.workspace) || !subscribed || !owner || owner.isDestroyed() || !owner.isVisible() || owner.isMinimized()
      || owner.webContents !== subscriber || subscriber.isDestroyed()) return;
    try { subscriber.send('serial:changed', delta); } catch { subscribed = false; }
  }
  function needsQuitConfirmation() { return workspaces.needsQuitConfirmation(); }
  function reserveForMigration() {
    if (needsQuitConfirmation()) throw new Error(tr("请先断开 RS232 和串口终端，并分别保存或清空记录，再导入数据"));
    migrationReserved = true;
    return () => { migrationReserved = false; };
  }
  function register(ipcMain) {
    const handle = (channel, operation, { fixedWorkspace, compact = false, requireWorkspace = false } = {}) => ipcMain.handle(channel, async (event, args) => {
      let authorized = false;
      let workspace;
      try {
        authorize(event); authorized = true;
        if (requireWorkspace && args?.workspace === undefined) throw new Error(tr("请明确选择要操作的串口工作区"));
        workspace = fixedWorkspace || (args?.workspace === undefined ? 'rs232' : args.workspace);
        if (!WORKSPACES.includes(workspace)) throw new Error(tr("串口工作区无效"));
        return { success: true, ...await operation(args, event, workspace) };
      }
      catch (error) { return { success: false, error: error.message, ...(error.code ? { code: error.code } : {}),
        ...(authorized && WORKSPACES.includes(workspace) && !compact ? { snapshot: workspaces.snapshot(workspace) } : {}) }; }
    });
    handle('serial:list', async () => ({ ports: await workspaces.get('rs232').listPorts() }));
    handle('serial:snapshot', (_args, _event, workspace) => ({ snapshot: workspaces.snapshot(workspace) }));
    handle('serial:subscribe', (args, event) => {
      if (typeof args?.active !== 'boolean') throw new Error(tr("串口订阅状态无效"));
      subscribed = args.active; subscriber = event.sender;
      if (!watched.has(subscriber)) {
        watched.add(subscriber);
        const clear = () => { if (subscriber === event.sender) subscribed = false; };
        subscriber.on('did-start-loading', clear);
        subscriber.on('render-process-gone', clear);
        subscriber.once('destroyed', clear);
      }
      return { snapshots: workspaces.snapshots() };
    });
    handle('serial:connect', async (args, _event, workspace) => {
      if (migrationReserved) throw new Error(tr("数据导入已准备，请重启应用后再连接串口"));
      await workspaces.get(workspace).connect(args);
      return { snapshot: workspaces.snapshot(workspace) };
    }, { requireWorkspace: true });
    handle('serial:disconnect', async (_args, _event, workspace) => {
      await workspaces.get(workspace).disconnect(); return { snapshot: workspaces.snapshot(workspace) };
    }, { requireWorkspace: true });
    handle('serial:send', async (args, _event, workspace) => {
      if (workspace !== 'rs232') throw new Error(tr("请在 RS232 调试工作区发送此类数据"));
      await workspaces.get(workspace).send(args); return { snapshot: workspaces.snapshot(workspace) };
    }, { requireWorkspace: true });
    handle('serial:terminal-read', args => workspaces.get('terminal').terminalRead(args), { fixedWorkspace: 'terminal', compact: true });
    handle('serial:terminal-write', args => workspaces.get('terminal').terminalWrite(args), { fixedWorkspace: 'terminal', compact: true });
    handle('serial:clear', (_args, _event, workspace) => {
      workspaces.get(workspace).clear(); return { snapshot: workspaces.snapshot(workspace) };
    }, { requireWorkspace: true });
    handle('serial:save', (_args, _event, workspace) => saveCurrent(workspace), { requireWorkspace: true });
  }
  return { register, publish, saveCurrent, saveAll, needsQuitConfirmation, reserveForMigration };
}

let workspaces;
let controller;
function publish(delta) { controller?.publish(delta); }
function register(ipcMain, options = {}) {
  if (Object.hasOwn(options, 'service')) throw new Error(tr("串口工作区必须分别初始化，请使用 createService 或 workspaces"));
  const { app, dialog } = require('electron');
  const ctx = require('./app-context.cjs');
  const { createSerialService } = require('./serial-service.cjs');
  const { createSerialWorkspaces } = require('./serial-workspaces.cjs');
  // Each workspace owns its native handle and caches; enumeration never opens a port.
  workspaces = options.workspaces || createSerialWorkspaces({
    createService: options.createService || ((workspace, onChange) => createSerialService({
      listPorts: () => require('serialport').SerialPort.list(),
      createPort: config => new (require('serialport').SerialPort)(config),
      mergeReceive: workspace === 'rs232', terminalReplayBytes: workspace === 'terminal' ? 16 * 1024 * 1024 : 0, onChange
    })), onChange: publish
  });
  controller = createSerialController({ workspaces, getOwner: () => ctx.getMainWindow(),
    saveSnapshot: async snapshot => {
      const result = await dialog.showSaveDialog(ctx.getMainWindow(), {
        title: tr("保存当前串口记录"), defaultPath: path.join(app.getPath('downloads'), `serial-${snapshot.workspace}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`),
        filters: [{ name: tr("串口记录"), extensions: ['log', 'txt'] }]
      });
      if (result.canceled || !result.filePath) return { success: true, cancelled: true };
      await writeSerialSnapshot(result.filePath, snapshot);
      return { success: true, path: result.filePath };
    }
  });
  controller.register(ipcMain);
}
function snapshot(workspace = 'rs232') { return workspaces?.snapshot(workspace) || { workspace, entries: [], status: 'disconnected', unsaved: false }; }
function snapshots() { return Object.fromEntries(WORKSPACES.map(workspace => [workspace, snapshot(workspace)])); }
function needsQuitConfirmation() { return controller?.needsQuitConfirmation() || false; }
function reserveForMigration() { return controller?.reserveForMigration() || (() => {}); }
async function saveCurrent(workspace) { return controller?.saveCurrent(workspace); }
async function saveAll() { return controller?.saveAll(); }
async function cleanup() { await workspaces?.dispose(); }

module.exports = { createSerialController, register, publish, snapshot, snapshots, needsQuitConfirmation, reserveForMigration, saveCurrent, saveAll, cleanup };
