import { tr } from './i18n';

export function joinAiContextRows(rows, read = row => row.raw) {
  const parts = []; let bytes = 0;
  for (const row of rows) {
    const text = String(read(row) || '');
    if (text.length > 512 * 1024) throw new Error(tr('AI 上下文超过 512 KiB，请缩小选段；未静默截断。'));
    bytes += new TextEncoder().encode(text).byteLength + (parts.length ? 1 : 0);
    if (bytes > 512 * 1024) throw new Error(tr('AI 上下文超过 512 KiB，请缩小选段；未静默截断。'));
    parts.push(text);
  }
  return parts.join('\n');
}

export async function bringAiContext(context, api = globalThis.window?.electronAPI) {
  const payload = typeof context === 'function' ? context() : context;
  if (!payload || Boolean(payload.reference) === Boolean(payload.view)) throw new Error(tr('AI 上下文格式无效或超过大小限制。'));
  if (payload.view && (typeof payload.view.text !== 'string' || payload.view.text.length > 512 * 1024 || new TextEncoder().encode(payload.view.text).byteLength > 512 * 1024)) {
    throw new Error(tr('AI 上下文超过 512 KiB，请缩小选段；未静默截断。'));
  }
  if (!api?.aiHandoffCreate) throw new Error(tr('AI 工作区暂不可用。'));
  const result = await api.aiHandoffCreate(payload);
  if (!result?.ok) throw new Error(result?.error || tr('带入 AI 上下文失败。'));
  return result;
}
