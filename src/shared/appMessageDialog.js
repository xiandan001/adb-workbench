let sequence = 0;
const pending = new Map(); const listeners = new Set();
export function normalizeAppMessageOptions(input = {}) {
  const buttons = input.buttons || ['确定']; const cancelId = input.cancelId ?? 0; const defaultId = input.defaultId ?? cancelId;
  if (!Array.isArray(buttons) || !buttons.length || buttons.length > 6 || buttons.some(value => typeof value !== 'string' || value.length > 160)
    || ![cancelId, defaultId].every(value => Number.isInteger(value) && value >= 0 && value < buttons.length)) throw new Error('确认对话框选项无效');
  const options = { type: ['info', 'error', 'warning', 'question'].includes(input.type) ? input.type : 'question', title: input.title || '请确认', message: input.message || '', detail: input.detail || '',
    buttons: [...buttons], defaultId, cancelId, checkboxLabel: input.checkboxLabel || '', checkboxChecked: Boolean(input.checkboxLabel && input.checkboxChecked) };
  for (const [key, max] of Object.entries({ title: 240, message: 8000, detail: 64000, checkboxLabel: 400 })) if (typeof options[key] !== 'string' || options[key].length > max || options[key].includes('\0')) throw new Error('确认对话框内容无效');
  return options;
}
export function subscribeAppMessages(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) for (const requestId of [...pending.keys()]) {
      const item = pending.get(requestId); resolveAppMessage(requestId, { response: item.options.cancelId, checkboxChecked: item.options.checkboxChecked });
    }
  };
}
export function showAppMessage(input) {
  const options = normalizeAppMessageOptions(input);
  if (!listeners.size) return Promise.resolve({ response: options.cancelId, checkboxChecked: options.checkboxChecked });
  return new Promise(resolve => {
    const requestId = `local-dialog-${++sequence}`; pending.set(requestId, { options, resolve });
    for (const listener of listeners) listener({ type: 'show', requestId, options });
  });
}
export function resolveAppMessage(requestId, result) {
  const item = pending.get(requestId);
  if (!item || !Number.isInteger(result?.response) || result.response < 0 || result.response >= item.options.buttons.length || typeof result.checkboxChecked !== 'boolean'
    || result.checkboxChecked && !item.options.checkboxLabel) return false;
  pending.delete(requestId); item.resolve({ response: result.response, checkboxChecked: result.checkboxChecked });
  for (const listener of listeners) listener({ type: 'cancel', requestId }); return true;
}
export async function confirmAppMessage({ confirmLabel = '确定', cancelLabel = '取消', confirmId = 1, ...input }) {
  const result = await showAppMessage({ ...input, buttons: input.buttons || [cancelLabel, confirmLabel], defaultId: input.defaultId ?? 0, cancelId: input.cancelId ?? 0 });
  return result.response === confirmId;
}
export function trapAppMessageFocus(event) {
  if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
  const dialog = event.currentTarget;
  const controls = [...dialog.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')]
    .filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length > 0);
  if (!controls.length) { event.preventDefault(); dialog.focus(); return; }
  const current = dialog.ownerDocument.activeElement;
  const first = controls[0]; const last = controls.at(-1);
  if (event.shiftKey && (current === first || !dialog.contains(current))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (current === last || !dialog.contains(current))) { event.preventDefault(); first.focus(); }
}
