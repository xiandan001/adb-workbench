const { randomUUID } = require('node:crypto');
const { tr } = require('./localization.cjs');

const ACTIVE = new Set(['running', 'cancelling']);
const KINDS = new Set(['ai', 'task', 'guard', 'recording', 'reproduction', 'export', 'inspection', 'performance']);
const PAGES = new Set(['ai-workspace', 'logs', 'tasks', 'quality', 'devices', 'reproduction', 'artifacts', 'performance']);
const text = (value, length = 240) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, length) : '';

function createActivityRegistry({ broadcast = () => {}, now = Date.now, limit = 40 } = {}) {
  const records = new Map();
  let olderCount = 0;
  function publicItem(item) {
    const { cancel: _cancel, ...visible } = item;
    return { ...visible, target: { ...visible.target } };
  }
  function list() {
    return { items: [...records.values()].sort((a, b) => Number(ACTIVE.has(b.status)) - Number(ACTIVE.has(a.status)) || b.updatedAt - a.updatedAt).map(publicItem), olderCount };
  }
  function publish() {
    const terminal = [...records.values()].filter(item => !ACTIVE.has(item.status)).sort((a, b) => b.updatedAt - a.updatedAt);
    for (const item of terminal.slice(limit)) { records.delete(item.id); olderCount++; }
    try { broadcast(list()); } catch { /* A closing renderer cannot break an underlying operation. */ }
  }
  function begin(input) {
    const id = input.id || randomUUID();
    if (!/^[\w:.-]{1,180}$/.test(id) || records.has(id) || !KINDS.has(input.kind) || !PAGES.has(input.target?.page)) throw new Error(tr('后台活动参数无效。'));
    if ([...records.values()].filter(item => ACTIVE.has(item.status)).length >= 32) throw new Error(tr('正在进行的后台活动过多，请稍后重试。'));
    const item = { id, kind: input.kind, title: text(input.title), deviceId: text(input.deviceId),
      target: { page: input.target.page, id: text(input.target.id, 180), deviceId: text(input.target.deviceId) },
      status: 'running', stage: text(input.stage), detail: '', startedAt: now(), updatedAt: now(),
      canCancel: typeof input.cancel === 'function', cancel: typeof input.cancel === 'function' ? input.cancel : null };
    records.set(id, item); publish(); return id;
  }
  function update(id, patch = {}) {
    const item = records.get(id);
    if (!item || !ACTIVE.has(item.status)) return false;
    for (const key of ['stage', 'detail']) if (Object.hasOwn(patch, key)) item[key] = text(patch[key], key === 'detail' ? 1000 : 240);
    if (Number.isFinite(patch.progress) && patch.progress >= 0 && patch.progress <= 100) item.progress = patch.progress;
    else if (Object.hasOwn(patch, 'progress')) delete item.progress;
    item.updatedAt = now(); publish(); return true;
  }
  function finish(id, patch = {}) {
    const item = records.get(id);
    if (!item || !ACTIVE.has(item.status)) return false;
    update(id, patch);
    item.status = ['failed', 'cancelled'].includes(patch.status) ? patch.status : 'completed';
    item.endedAt = now(); item.updatedAt = now(); item.canCancel = false; item.cancel = null;
    delete item.progress;
    publish(); return true;
  }
  async function cancel(id) {
    const item = records.get(id);
    if (!item || item.status !== 'running' || !item.cancel) return { ok: false, error: tr('该活动当前不能取消。') };
    const callback = item.cancel;
    item.status = 'cancelling'; item.updatedAt = now(); publish();
    try {
      const result = await callback();
      if (result?.ok === false || result?.success === false) throw new Error(result.error || tr('取消未完成，请重试。'));
      // Only the operation owner can declare completion; acceptance of cancellation is not completion.
      return { ok: true };
    } catch (error) {
      if (records.get(id) === item && item.status === 'cancelling') {
        item.status = 'running'; item.detail = text(error.message, 1000); item.updatedAt = now(); publish();
      }
      return { ok: false, error: text(error.message, 1000) || tr('取消未完成，请重试。') };
    }
  }
  function dismiss(id) {
    if (!records.has(id) || ACTIVE.has(records.get(id).status)) return false;
    records.delete(id); publish(); return true;
  }
  return { begin, update, finish, list, cancel, dismiss, cleanup: () => records.clear() };
}

const registry = createActivityRegistry({ broadcast: payload => require('./app-context.cjs').broadcastToAllWindows('workbench:activity', payload) });
function register(ipcMain) {
  const { getMainWindow } = require('./app-context.cjs');
  for (const [name, operation] of Object.entries({ list: () => ({ ok: true, ...registry.list() }), cancel: args => registry.cancel(args?.id), dismiss: args => ({ ok: registry.dismiss(args?.id) }) })) {
    ipcMain.handle(`workbench-activity:${name}`, async (event, args) => {
      const owner = getMainWindow();
      if (!owner || owner.isDestroyed() || event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) return { ok: false, error: tr('仅允许在应用主窗口管理后台活动。') };
      return operation(args);
    });
  }
}
module.exports = { createActivityRegistry, register, ...registry };
