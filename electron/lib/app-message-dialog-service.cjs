const { randomUUID } = require('node:crypto');

const CHANNEL = 'app-message-dialog:event';
const cancelled = options => ({ response: options.cancelId, checkboxChecked: options.checkboxChecked });
function normalizeOptions(input = {}) {
  const buttons = input.buttons || ['确定'];
  const validText = (value, max) => typeof value === 'string' && value.length <= max && !value.includes('\0');
  if (!Array.isArray(buttons) || !buttons.length || buttons.length > 6 || buttons.some(label => !validText(label, 160))) throw new Error('确认对话框按钮无效');
  const cancelId = input.cancelId ?? 0; const defaultId = input.defaultId ?? cancelId;
  if (![cancelId, defaultId].every(index => Number.isInteger(index) && index >= 0 && index < buttons.length)) throw new Error('确认对话框默认操作无效');
  const options = { title: input.title || '请确认', message: input.message || '', detail: input.detail || '', buttons: [...buttons], cancelId, defaultId,
    type: ['info', 'error', 'warning', 'question'].includes(input.type) ? input.type : 'question', checkboxLabel: input.checkboxLabel || '', checkboxChecked: input.checkboxChecked === true };
  for (const [key, max] of Object.entries({ title: 240, message: 8000, detail: 64000, checkboxLabel: 400 })) if (!validText(options[key], max)) throw new Error('确认对话框内容无效');
  if (!options.checkboxLabel) options.checkboxChecked = false;
  return options;
}

function createAppMessageDialogService({ getOwner, timeoutMs = 300000 } = {}) {
  let owner = null; let contents = null; let readyFrame = null; let active = null; let disposed = false;
  const queue = []; const detach = [];
  const usable = value => value && !value.isDestroyed() && value.webContents && !value.webContents.isDestroyed();
  function send(message) { if (contents && !contents.isDestroyed()) { try { contents.send(CHANNEL, message); return true; } catch { /* Cancellation remains authoritative if the renderer exits. */ } } return false; }
  function remove(entry, result, advance = true) {
    const index = queue.indexOf(entry); if (index < 0) return;
    queue.splice(index, 1); clearTimeout(entry.timer);
    if (active === entry) { active = null; send({ type: 'cancel', requestId: entry.requestId }); }
    entry.resolve(result); if (advance) pump();
  }
  function cancelAll() { readyFrame = null; for (const entry of [...queue]) remove(entry, cancelled(entry.options), false); }
  function bind(next) {
    if (owner === next) return;
    cancelAll(); for (const cleanup of detach.splice(0)) cleanup(); owner = next; contents = next?.webContents || null;
    if (!contents) return;
    const navigation = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) cancelAll(); };
    const gone = () => cancelAll();
    for (const [name, listener] of [['did-start-navigation', navigation], ['render-process-gone', gone], ['destroyed', gone]]) {
      contents.on(name, listener); const target = contents; detach.push(() => target.removeListener(name, listener));
    }
  }
  function authorize(event) {
    try { const current = getOwner(); return usable(current) && event?.sender === current.webContents && event.senderFrame === current.webContents.mainFrame && Boolean(event.senderFrame); }
    catch { return false; }
  }
  function pump() {
    if (disposed || active || !queue.length) return;
    if (!usable(owner) || owner !== getOwner() || readyFrame !== contents.mainFrame) { cancelAll(); return; }
    active = queue[0]; if (!send({ type: 'show', requestId: active.requestId, options: active.options })) cancelAll();
  }
  function ask(input, limits = {}) {
    const options = normalizeOptions(input); const current = getOwner();
    if (disposed || !usable(current)) return Promise.resolve(cancelled(options));
    bind(current);
    if (!readyFrame || readyFrame !== contents.mainFrame || queue.length >= 32) return Promise.resolve(cancelled(options));
    return new Promise(resolve => {
      const entry = { requestId: randomUUID(), options, resolve, frame: readyFrame };
      const duration = Number.isFinite(limits.timeoutMs) && limits.timeoutMs > 0 ? Math.min(timeoutMs, limits.timeoutMs) : timeoutMs;
      entry.timer = setTimeout(() => remove(entry, cancelled(options)), duration);
      queue.push(entry); pump();
    });
  }
  function register(ipcMain) {
    ipcMain.handle('app-message-dialog:ready', event => {
      if (disposed || !authorize(event)) return { ready: false };
      bind(getOwner()); readyFrame = event.senderFrame; pump(); return { ready: true };
    });
    ipcMain.handle('app-message-dialog:unready', event => {
      if (!authorize(event)) return { ready: false };
      cancelAll(); return { ready: false };
    });
    ipcMain.handle('app-message-dialog:reply', (event, value) => {
      if (disposed || !authorize(event) || !active || event.senderFrame !== active.frame || readyFrame !== active.frame) return { accepted: false };
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'checkboxChecked,requestId,response'
        || value.requestId !== active.requestId || !Number.isInteger(value.response) || value.response < 0 || value.response >= active.options.buttons.length
        || typeof value.checkboxChecked !== 'boolean' || value.checkboxChecked && !active.options.checkboxLabel) return { accepted: false };
      remove(active, { response: value.response, checkboxChecked: value.checkboxChecked }); return { accepted: true };
    });
  }
  return { ask, register, dispose() { disposed = true; cancelAll(); for (const cleanup of detach.splice(0)) cleanup(); owner = null; contents = null; } };
}

module.exports = { createAppMessageDialogService, normalizeOptions };
