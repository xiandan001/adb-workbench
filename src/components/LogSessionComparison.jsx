import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n';

export default function LogSessionComparison({ request, isDark, onClose }) {
  useLocale();
  const dialog = useRef(null), [result, setResult] = useState(null), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const panel = isDark ? 'bg-[#202124] border-slate-600 text-slate-100' : 'bg-white border-slate-200 text-slate-800';
  useEffect(() => { const node = dialog.current, previous = document.activeElement; node.showModal(); return () => { node.close(); previous?.focus?.({ preventScroll: true }); }; }, []);
  useEffect(() => {
    let current = true; const requestId = crypto.randomUUID();
    void window.electronAPI.logSessionCompare({ ...request, requestId }).then(response => {
      if (!current) return;
      if (!response?.ok) throw new Error(response?.error || tr('会话比较失败，请重试。'));
      setResult(response.comparison); setError('');
    }).catch(failure => { if (current) setError(failure.message); });
    return () => { current = false; void window.electronAPI.logSessionCancel?.({ requestId }); };
  }, [request, retry]);
  return <dialog ref={dialog} onCancel={event => { event.preventDefault(); onClose(); }} aria-label={tr('本地会话比较')}
    className={`m-auto max-h-[85vh] w-[min(56rem,94vw)] overflow-y-auto rounded-xl border p-5 shadow-2xl backdrop:bg-black/50 ${panel}`}>
    <header className="flex items-center justify-between gap-3"><h2 className="font-semibold">{tr('本地会话比较')}</h2><button type="button" autoFocus aria-label={tr('关闭')} onClick={onClose}><X size={18} /></button></header>
    {!result && !error && <p role="status" className="mt-4 text-sm">{tr('正在本机比较，不调用 AI…')}</p>}
    {error && <div role="alert" className="mt-4 text-sm text-red-500"><p>{tr(error)}</p><button type="button" className="mt-2 underline" onClick={() => setRetry(value => value + 1)}>{tr('重试')}</button></div>}
    {result && <div className="mt-4 space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">{[result.before, result.after].map((item, index) => <section key={item.id} className="min-w-0 rounded-lg border border-current/15 p-3 text-sm"><p className="text-xs opacity-70">{index ? tr('之后') : tr('之前')}</p><h3 className="mt-1 break-words font-medium">{item.name}</h3><p className="mt-1 break-all text-xs opacity-70">{item.deviceId || tr('身份未知')} · {item.entryCount.toLocaleString()}{tr(' 条')}</p></section>)}</div>
      <p className={`text-sm font-medium ${result.comparable ? 'text-emerald-500' : 'text-amber-500'}`}>{result.comparable ? tr('目标身份一致，仅比较所保存范围内的数量。') : tr('来源不可直接比较，结论为无法判断。')}</p>
      {result.warnings.map(warning => <p key={warning} className="text-xs leading-5 opacity-75">{warning}</p>)}
      <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr><th className="p-2">{tr('问题线索')}</th><th className="p-2">{tr('之前')}</th><th className="p-2">{tr('之后')}</th><th className="p-2">{tr('数量变化')}</th></tr></thead><tbody>{result.groups.map(group => <tr key={group.id || group.signature} className="border-t border-current/10"><td className="max-w-md break-words p-2">{group.signature}</td><td className="p-2">{group.beforeCount}</td><td className="p-2">{group.afterCount}</td><td className="p-2">{group.delta > 0 ? '+' : ''}{group.delta}</td></tr>)}</tbody></table></div>
      {!result.groups.length && <p className="text-sm opacity-70">{tr('所保存范围内没有匹配的错误线索；不代表设备没有问题。')}</p>}
      {result.groupsLimited && <p className="text-xs text-amber-500">{tr('仅显示数量最多的 100 组；原始会话保持完整。')}</p>}
    </div>}
  </dialog>;
}
