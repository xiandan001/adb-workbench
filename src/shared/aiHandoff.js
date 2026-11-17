import { tr } from './i18n.js';
import { AI_CONTEXT_BYTES, contextPayloadBytes } from './aiContextTextWindow.js';

export function joinAiContextRows(rows, read = row => row.raw) {
  const parts = []; let bytes = 0;
  for (const row of rows) {
    const text = String(read(row) || '');
    if (text.length > AI_CONTEXT_BYTES) throw new Error(tr('完整 AI 材料超过 20 MiB，请减少内容后重试；原文未替换或截断。'));
    bytes += new TextEncoder().encode(text).byteLength + (parts.length ? 1 : 0);
    if (bytes > AI_CONTEXT_BYTES) throw new Error(tr('完整 AI 材料超过 20 MiB，请减少内容后重试；原文未替换或截断。'));
    parts.push(text);
  }
  return parts.join('\n');
}

export async function bringAiContext(context, api = globalThis.window?.electronAPI) {
  const payload = typeof context === 'function' ? await context() : context;
  if (!payload || Boolean(payload.reference) === Boolean(payload.view)) throw new Error(tr('AI 上下文格式无效或超过大小限制。'));
  if (payload.view && typeof payload.view.text !== 'string') throw new Error(tr('AI 上下文格式无效或超过大小限制。'));
  if (payload.view) await contextPayloadBytes(payload.view);
  if (!api?.aiHandoffCreate) throw new Error(tr('AI 工作区暂不可用。'));
  const result = await api.aiHandoffCreate(payload);
  if (!result?.ok) throw new Error(result?.error || tr('带入 AI 上下文失败。'));
  return result;
}
