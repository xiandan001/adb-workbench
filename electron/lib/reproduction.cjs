const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { tr } = require('./localization.cjs');
const { createReproductionService } = require('./reproduction-session.cjs');
const { createSourceSnapshots, listSources } = require('./reproduction-sources.cjs');
const activity = require('./workbench-activity.cjs');

let singleton;
function getService() {
  if (singleton) return singleton;
  const { app } = require('electron');
  const sources = { serial: require('./serial.cjs'), ssh: require('./ssh.cjs') };
  const activities = new Map();
  singleton = createReproductionService({ directory: path.join(app.getPath('userData'), 'reproduction-sessions'),
    recording: require('./screen-recording.cjs'), startLog: args => require('./recording-log.cjs').startRecordingLog(args),
    samplePerformance: async deviceId => require('./performance-monitor.cjs').collectSnapshot(deviceId, false, { timeoutMs: 12000 }),
    sourceSnapshots: createSourceSnapshots(sources),
    verifyDevice: async deviceId => {
      const result = await require('./adb-runtime.cjs').runAdb(['-s', deviceId, 'get-state'], { timeoutMs: 5000, maxBuffer: 1024 });
      if (!result.ok || String(result.stdout).trim() !== 'device') throw new Error(tr('所选设备已离线，未切换到其他设备。'));
    },
    broadcast: payload => require('./app-context.cjs').broadcastToAllWindows('reproduction:update', payload) });
  singleton.onChange(session => {
    const terminal = ['completed', 'partial', 'interrupted'].includes(session.status);
    if (!activities.has(session.id)) {
      const id = activity.begin({ id: `reproduction:${session.id}`, kind: 'reproduction', title: session.title, deviceId: session.deviceId,
        target: { page: 'reproduction', id: session.id, deviceId: session.deviceId }, cancel: () => singleton.stop({ id: session.id }) });
      activities.set(session.id, id);
    }
    const id = activities.get(session.id);
    const stage = { starting: tr('正在准备复现采集'), recording: tr('正在采集复现证据'), stopping: tr('正在停止并保存证据'), completed: tr('复现采集已完成'), partial: tr('复现采集部分完成'), interrupted: tr('复现采集已中断') }[session.status];
    activity.update(id, { stage });
    if (terminal) activity.finish(id, { status: session.status === 'completed' ? 'completed' : 'failed', stage, detail: session.warnings.join('\n') });
  });
  return singleton;
}

async function openSession({ id } = {}) {
  const service = getService(), session = await service.load(id);
  let videoUrl = '';
  if (session.files.some(file => file.name === 'video.mp4')) {
    try { videoUrl = pathToFileURL(await service.store.filePath(id, 'video.mp4', true)).href; } catch { /* A missing video does not hide the remaining evidence. */ }
  }
  return { ok: true, session, videoUrl };
}
async function analyzeSession({ id } = {}) {
  const service = getService(), session = await service.load(id);
  if (['starting', 'recording', 'stopping'].includes(session.status)) throw new Error(tr('请先结束采集，再准备分析预览。'));
  if (session.unsaved) throw new Error(tr('请先重试保存会话状态，再分析或导出。'));
  const parts = [JSON.stringify({ title: session.title, deviceId: session.deviceId, startedAt: session.startedAt, endedAt: session.endedAt,
    status: session.status, markers: session.markers, warnings: session.warnings, clockBasis: tr('标记按本机时间记录，各来源设备时钟未经同步。') }, null, 2)];
  let bytes = Buffer.byteLength(parts[0]);
  for (const file of session.files.filter(file => file.name !== 'video.mp4')) {
    if (bytes >= 440 * 1024) break;
    const evidence = await service.store.readTail(id, file.name, Math.min(64 * 1024, 440 * 1024 - bytes));
    const text = `${file.label}\n${evidence.truncated || file.truncated ? tr('仅包含保留的近期片段，并非完整原始数据。') : ''}\n${evidence.text}`;
    parts.push(text); bytes += Buffer.byteLength(text);
  }
  const context = await require('./ai-analysis-handoff.cjs').createInternal({ origin: 'reproduction', deviceId: session.deviceId,
    title: session.title, question: tr('请结合所选复现证据分析问题，区分事实、推测和仍需验证的信息。'), text: parts.join('\n\n') });
  return { ok: true, ...context };
}

async function exportSession({ id } = {}) {
  const { dialog } = require('electron'), owner = require('./app-context.cjs').getMainWindow();
  const service = getService(), session = await service.load(id);
  if (['starting', 'recording', 'stopping'].includes(session.status)) throw new Error(tr('请先结束采集，再导出证据包。'));
  if (session.unsaved) throw new Error(tr('请先重试保存会话状态，再分析或导出。'));
  const selection = await dialog.showSaveDialog(owner, { title: tr('导出复现证据包'), defaultPath: `reproduction-${id}.zip`, filters: [{ name: 'ZIP', extensions: ['zip'] }] });
  if (selection.canceled || !selection.filePath) return { ok: true, cancelled: true };
  const destination = path.resolve(selection.filePath), sessionDirectory = await service.store.checkedDirectory(id);
  const { isWithin, exportArtifact } = require('./artifact-export.cjs');
  const targetStat = await fs.lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (targetStat && (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink > 1)) throw new Error(tr('请选择普通文件作为导出目标。'));
  const realDestination = path.join(await fs.realpath(path.dirname(destination)), path.basename(destination));
  if (isWithin(service.store.root, realDestination)) throw new Error(tr('请将证据包保存在复现记录目录之外。'));
  const stagedDestination = path.join(path.dirname(realDestination), `.reproduction-${randomUUID()}.zip`);
  // Export through an owned staging directory containing only manifest-declared files.
  const idActivity = activity.begin({ id: `reproduction-export:${randomUUID()}`, kind: 'export', title: tr('导出复现证据包'), target: { page: 'reproduction', id } });
  let temporary;
  try {
    temporary = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'awb-reproduction-export-'));
    const names = ['manifest.json', ...session.files.map(file => file.name)];
    for (const name of names) await fs.copyFile(await service.store.filePath(id, name, true), path.join(temporary, name));
    const result = await exportArtifact({ type: 'reproduction', title: session.title, deviceId: session.deviceId, rootPath: temporary, deletePath: temporary }, stagedDestination);
    await fs.rename(stagedDestination, realDestination);
    activity.finish(idActivity); return { ok: true, ...result, path: destination, source: sessionDirectory };
  } catch (error) { activity.finish(idActivity, { status: 'failed', detail: error.message }); throw error; }
  finally {
    await fs.unlink(stagedDestination).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (temporary && path.dirname(temporary) === path.resolve(require('node:os').tmpdir()) && path.basename(temporary).startsWith('awb-reproduction-export-')) await fs.rm(temporary, { recursive: true, force: true });
  }
}

function register(ipcMain) {
  // Restore metadata only. Never reconnect sources or resume capture after restart.
  void getService().list().catch(() => {});
  const operations = {
    list: () => getService().list(), sources: () => ({ ok: true, ...listSources({ serial: require('./serial.cjs'), ssh: require('./ssh.cjs') }) }),
    start: args => getService().start(args), mark: args => getService().mark(args), stop: args => getService().stop(args), retrySave: args => getService().retrySave(args), open: openSession,
    read: async args => {
      const session = await getService().load(args?.id);
      if (!session.files.some(file => file.name === args?.name) || args.name === 'video.mp4') throw new Error(tr('该证据文件不属于所选复现会话。'));
      return { ok: true, ...await getService().store.readTail(args.id, args.name, 64 * 1024) };
    }, analyze: analyzeSession, export: exportSession,
  };
  for (const [name, operation] of Object.entries(operations)) ipcMain.handle(`reproduction:${name}`, async (event, args) => {
    const owner = require('./app-context.cjs').getMainWindow();
    if (!owner || owner.isDestroyed() || event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) return { ok: false, error: tr('仅允许在应用主窗口管理复现会话。') };
    try { return await operation(args); } catch (error) { return { ok: false, error: String(error.message || tr('复现会话操作未完成。')).slice(0, 2000) }; }
  });
}
async function confirmQuit(ask) {
  if (!singleton?.hasActive() && !singleton?.hasUnpersisted()) return true;
  const answer = await ask({ type: 'question', title: tr('结束复现采集后退出？'), message: tr('将停止本次复现所拥有的采集并保存已有证据，不会断开其他会话。'),
    buttons: [tr('返回应用'), tr('结束采集并退出')], defaultId: 0, cancelId: 0 });
  if (answer.response !== 1) return false;
  const result = await singleton.stopCurrent();
  if (!result.ok) throw new Error(result.error);
  return true;
}
module.exports = { register, getService, openSession, analyzeSession, exportSession, confirmQuit,
  hasActive: () => singleton?.hasActive() || singleton?.hasUnpersisted() || false, cleanup: async () => singleton?.cleanup() };
