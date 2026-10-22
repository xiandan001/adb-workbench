const path = require('node:path');
const { writeSerialSnapshot } = require('./serial-export.cjs');

function createSerialController({ service, getOwner, saveSnapshot }) {
  let subscribed = false;
  let subscriber;
  let saving = false;
  let connecting = false;
  let connectRequest = 0;
  let migrationReserved = false;
  const watched = new WeakSet();
  const authorize = event => {
    const owner = getOwner();
    if (!owner || owner.isDestroyed() || event.sender !== owner.webContents) throw new Error('请在主窗口操作串口');
  };
  async function saveCurrent() {
    if (saving) throw new Error('正在保存串口记录，请稍候');
    saving = true;
    try {
      service.sealReceive();
      const snapshot = service.snapshot();
      if (!snapshot.entries.length) throw new Error('暂无可保存的串口记录');
      const result = await saveSnapshot(snapshot);
      if (result.success && !result.cancelled) service.markSaved(snapshot.revision);
      return result;
    } finally { saving = false; }
  }
  function publish(delta) {
    const owner = getOwner();
    if (!subscribed || !owner || owner.isDestroyed() || !owner.isVisible() || owner.isMinimized()
      || owner.webContents !== subscriber || subscriber.isDestroyed()) return;
    try { subscriber.send('serial:changed', delta); } catch { subscribed = false; }
  }
  function needsQuitConfirmation() { return connecting || service.needsQuitConfirmation(); }
  function reserveForMigration() {
    if (needsQuitConfirmation()) throw new Error('请先断开串口，并保存或清空当前串口记录，再导入数据');
    migrationReserved = true;
    return () => { migrationReserved = false; };
  }
  function register(ipcMain) {
    const handle = (channel, operation) => ipcMain.handle(channel, async (event, args) => {
      let authorized = false;
      try { authorize(event); authorized = true; return { success: true, ...await operation(args, event) }; }
      catch (error) { return { success: false, error: error.message, ...(authorized ? { snapshot: service.snapshot() } : {}) }; }
    });
    handle('serial:list', async () => ({ ports: await service.listPorts() }));
    handle('serial:snapshot', () => ({ snapshot: service.snapshot() }));
    handle('serial:subscribe', (args, event) => {
      if (typeof args?.active !== 'boolean') throw new Error('串口订阅状态无效');
      subscribed = args.active; subscriber = event.sender;
      if (!watched.has(subscriber)) {
        watched.add(subscriber);
        const clear = () => { if (subscriber === event.sender) subscribed = false; };
        subscriber.on('did-start-loading', clear);
        subscriber.on('render-process-gone', clear);
        subscriber.once('destroyed', clear);
      }
      return { snapshot: service.snapshot() };
    });
    handle('serial:connect', async args => {
      if (migrationReserved) throw new Error('数据导入已准备，请重启应用后再连接串口');
      if (connecting) throw new Error('正在连接串口，请稍候');
      connecting = true;
      const request = ++connectRequest;
      try {
        const ports = await service.listPorts();
        if (request !== connectRequest) throw new Error('串口连接已取消');
        if (migrationReserved) throw new Error('正在准备数据导入，不能连接串口');
        if (!ports.some(port => port.path === args?.path)) throw new Error('所选串口已不可用，请刷新后重新选择');
        await service.connect(args);
        return { snapshot: service.snapshot() };
      } finally { connecting = false; }
    });
    handle('serial:disconnect', async () => { connectRequest++; await service.disconnect(); return { snapshot: service.snapshot() }; });
    handle('serial:send', async args => { await service.send(args); return { snapshot: service.snapshot() }; });
    handle('serial:clear', () => { service.clear(); return { snapshot: service.snapshot() }; });
    handle('serial:save', saveCurrent);
  }
  return { register, publish, saveCurrent, needsQuitConfirmation, reserveForMigration };
}

let service;
let controller;
function publish(delta) { controller?.publish(delta); }
function register(ipcMain, options = {}) {
  const { app, dialog } = require('electron');
  const ctx = require('./app-context.cjs');
  const { createSerialService } = require('./serial-service.cjs');
  // Native binding is loaded only when the serial module is used, not during general app startup.
  service = options.service || createSerialService({
    listPorts: () => require('serialport').SerialPort.list(),
    createPort: config => new (require('serialport').SerialPort)(config), onChange: publish
  });
  controller = createSerialController({ service, getOwner: () => ctx.getMainWindow(),
    saveSnapshot: async snapshot => {
      const result = await dialog.showSaveDialog(ctx.getMainWindow(), {
        title: '保存当前串口记录', defaultPath: path.join(app.getPath('downloads'), `serial-${new Date().toISOString().replace(/[:.]/g, '-')}.log`),
        filters: [{ name: '串口记录', extensions: ['log', 'txt'] }]
      });
      if (result.canceled || !result.filePath) return { success: true, cancelled: true };
      await writeSerialSnapshot(result.filePath, snapshot);
      return { success: true, path: result.filePath };
    }
  });
  controller.register(ipcMain);
}
function snapshot() { return service?.snapshot() || { entries: [], status: 'disconnected', unsaved: false }; }
function needsQuitConfirmation() { return controller?.needsQuitConfirmation() || false; }
function reserveForMigration() { return controller?.reserveForMigration() || (() => {}); }
async function saveCurrent() { return controller?.saveCurrent(); }
async function cleanup() { await service?.dispose(); }

module.exports = { createSerialController, register, publish, snapshot, needsQuitConfirmation, reserveForMigration, saveCurrent, cleanup };
