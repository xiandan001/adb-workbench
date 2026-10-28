import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2, Send, X } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n';

export default function AiOutboundPreviewHost({ isDark = true }) {
  useLocale();
  const [state, setState] = useState({ pending: [], operations: [] });
  const [preview, setPreview] = useState(null);
  const [index, setIndex] = useState(0);
  const [visited, setVisited] = useState(new Set());
  const [confirmed, setConfirmed] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [usageOpen, setUsageOpen] = useState(false);
  const dialog = useRef(null), epoch = useRef(0), listEpoch = useRef(0), alive = useRef(true);
  const selected = state.pending[0];
  const selectedId = selected?.id;
  const panel = isDark ? 'border-slate-600 bg-[#202124] text-slate-100' : 'border-slate-300 bg-white text-slate-800';
  const button = `rounded-lg border px-3 py-2 text-xs disabled:opacity-40 ${panel}`;

  const refresh = useCallback(async () => {
    const request = ++listEpoch.current;
    try {
      const result = await window.electronAPI?.aiOutboundList?.();
      if (alive.current && request === listEpoch.current && result?.ok) setState({ pending: result.pending || [], operations: result.operations || [] });
    } catch { /* Closing IPC cannot authorize a send. */ }
  }, []);
  useEffect(() => {
    alive.current = true;
    const invalidate = () => { epoch.current++; listEpoch.current++; };
    const off = window.electronAPI?.onAiOutboundChanged?.(refresh);
    void refresh();
    return () => { alive.current = false; invalidate(); off?.(); };
  }, [refresh]);
  useEffect(() => {
    setIndex(0); setVisited(new Set()); setConfirmed(null); setPreview(null); setError('');
    const modal = dialog.current;
    if (selectedId && !modal.open) modal.showModal();
    if (!selectedId && modal.open) modal.close();
  }, [selectedId]);
  useEffect(() => {
    const request = ++epoch.current;
    if (!selectedId) return;
    setLoading(true); setError(''); setPreview(null);
    window.electronAPI.aiOutboundGet({ previewId: selectedId, index }).then(result => {
      if (!alive.current || request !== epoch.current) return;
      if (!result?.ok) throw new Error(result?.error || tr('AI 发送预览已过期，请重新准备。'));
      setPreview(result.preview); setVisited(previous => new Set([...previous, index]));
    }).catch(failure => { if (alive.current && request === epoch.current) setError(failure.message); })
      .finally(() => { if (alive.current && request === epoch.current) setLoading(false); });
  }, [selectedId, index]);

  async function decide(decision) {
    if (!selectedId || busy) return;
    if (decision === 'send' && (confirmed !== selectedId || visited.size !== selected.requestCount || loading || preview?.id !== selectedId)) return;
    setBusy(true); setError('');
    try {
      const result = await window.electronAPI.aiOutboundDecide({ previewId: selectedId, decision });
      if (!result?.ok) throw new Error(result?.error || tr('AI 发送确认失败。'));
      await refresh();
    } catch (failure) { if (alive.current) setError(failure.message); }
    finally { if (alive.current) setBusy(false); }
  }

  return <>
    <dialog ref={dialog} aria-labelledby="ai-outbound-title" onCancel={event => { event.preventDefault(); void decide('cancel'); }}
      className={`m-auto w-[min(1000px,94vw)] max-h-[92vh] overflow-hidden rounded-xl border p-0 shadow-2xl backdrop:bg-black/60 ${panel}`}>
      {selected && <div className="flex max-h-[90vh] flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-slate-500/30 p-4"><AlertTriangle className="text-amber-500" size={20} /><div className="min-w-0 flex-1"><h2 id="ai-outbound-title" className="font-semibold">{tr('确认 AI 发送预览')}</h2><p className="truncate text-xs opacity-70">{selected.title}</p></div><button type="button" disabled={busy} aria-label={tr('取消 AI 发送')} onClick={() => decide('cancel')}><X size={19} /></button></header>
        <div className="min-h-0 flex-1 overflow-y-auto space-y-3 p-4">
          <p className="text-sm leading-6">{tr('以下是脱敏后将发送给内置 AI 的完整消息。原始本地证据不会被修改；未确认前不会联网发送。')}</p>
          <p className="text-xs opacity-75">{tr('固定批次：{0} 个请求 · {1} KiB · 估算输入 {2} tokens · {3} 条消息已脱敏', { 0: selected.requestCount, 1: Math.ceil(selected.bytes / 1024), 2: selected.estimatedInputTokens, 3: selected.redactions })}</p>
          <p className="text-xs text-amber-500">{tr('自动脱敏不能保证识别所有敏感信息。请逐项检查；分块结果需要再次汇总时会生成新的预览，不会自动发送。')}</p>
          <nav className="flex items-center gap-2"><button type="button" className={button} disabled={index === 0 || loading} onClick={() => setIndex(value => value - 1)} aria-label={tr('上一个请求')}><ChevronLeft size={15} /></button><span className="text-xs">{tr('请求 {0} / {1} · 已查看 {2}', { 0: index + 1, 1: selected.requestCount, 2: visited.size })}</span><button type="button" className={button} disabled={index + 1 === selected.requestCount || loading} onClick={() => setIndex(value => value + 1)} aria-label={tr('下一个请求')}><ChevronRight size={15} /></button></nav>
          {loading && <p className="flex items-center gap-2 text-sm"><Loader2 className="animate-spin" size={16} />{tr('正在读取完整发送预览…')}</p>}
          {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
          {preview?.selectedRequest && <>
            <p className="text-xs opacity-70">{tr('本请求：{0} KiB · {1} · 思考模式：{2}', { 0: Math.ceil(preview.selectedRequest.bytes / 1024), 1: preview.selectedRequest.parameters.stream ? tr('流式回复') : tr('完整回复'), 2: preview.selectedRequest.parameters.thinking ? tr('开启') : tr('关闭') })}</p>
            {preview.selectedRequest.messages.map((message, messageIndex) => <section key={`${selectedId}:${index}:${messageIndex}`} className="space-y-1"><h3 className="text-xs font-semibold">{message.role}</h3><textarea readOnly aria-label={tr('发送消息 {0}', { 0: messageIndex + 1 })} value={message.content} className={`min-h-28 max-h-72 w-full resize-y rounded-lg border p-3 font-mono text-xs leading-5 ${panel}`} /></section>)}
          </>}
        </div>
        <footer className="shrink-0 border-t border-slate-500/30 p-4 space-y-3"><label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={confirmed === selectedId} disabled={visited.size !== selected.requestCount || busy || preview?.id !== selectedId} onChange={event => setConfirmed(event.target.checked ? selectedId : null)} />{tr('我已检查本批次的所有请求，同意发送上述完整脱敏内容。')}</label><div className="flex justify-end gap-2"><button type="button" className={button} disabled={busy} onClick={() => decide('cancel')}>{tr('取消，不发送')}</button><button type="button" className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white disabled:opacity-40" disabled={busy || loading || confirmed !== selectedId || visited.size !== selected.requestCount || preview?.id !== selectedId} onClick={() => decide('send')}><Send size={15} />{tr('明确发送本批次')}</button></div></footer>
      </div>}
    </dialog>
    {state.operations.length > 0 && <aside className={`fixed bottom-3 right-3 z-40 max-w-sm rounded-xl border shadow-lg ${panel}`}><button type="button" aria-expanded={usageOpen} onClick={() => setUsageOpen(value => !value)} className="px-3 py-2 text-xs">{tr('AI 发送与用量')}</button>{usageOpen && <div className="max-h-60 overflow-auto border-t border-slate-500/25 p-3 space-y-3">{state.operations.slice(-6).reverse().map(item => <OutboundUsage key={item.id} item={item} />)}</div>}</aside>}
  </>;
}

function OutboundUsage({ item }) {
  useLocale();
  const usage = item.usage || {};
  const status = { running: tr('进行中'), completed: tr('已完成'), failed: tr('失败'), cancelled: tr('已取消') }[item.status];
  return <div className="text-xs space-y-1"><p className="font-medium">{item.title} · {status}</p><p className="opacity-70">{item.stage}</p>{usage.observedRequests > 0 && <p>{tr('已报告实际用量：输入 {0} / 输出 {1} / 合计 {2} tokens（{3}/{4} 请求）', { 0: usage.actual?.inputTokens, 1: usage.actual?.outputTokens, 2: usage.actual?.totalTokens, 3: usage.observedRequests, 4: usage.sentRequests })}</p>}{!usage.complete && <p className="opacity-70">{tr('完整实际用量不可用；预览输入估算 {0} tokens，不代表实际扣费。', { 0: usage.estimatedInputTokens || 0 })}</p>}</div>;
}
