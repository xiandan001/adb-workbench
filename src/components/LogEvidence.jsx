import { tr, useLocale, getLocale } from '../shared/i18n';
import { useMemo, useState } from 'react';
import { Crosshair, X } from 'lucide-react';
import { findEvidenceReferences } from '../shared/logWorkspace';

export default function LogEvidence({ content, allowedRefs, evidence, isDark, onLocate }) {
  const locale = useLocale();
  const [selected, setSelected] = useState(null);
  const [locateMessage, setLocateMessage] = useState('');
  const allowedIndex = useMemo(() => { void locale; return new Set(allowedRefs || []); }, [allowedRefs, locale]);
  const references = useMemo(() => { void locale; return findEvidenceReferences(content, allowedIndex, evidence); }, [content, allowedIndex, evidence, locale]);
  if (!references.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {references.map(({ ref, entry }) => entry ? (
        <button key={ref} type="button" onClick={() => { setLocateMessage(''); setSelected(entry); }} className={`rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs ${isDark ? 'text-emerald-300' : 'text-emerald-700'}`}>{tr("查看依据 [{0}]", { 0: ref })}</button>
      ) : <span key={ref} className="text-xs text-amber-500">{tr("[{0}] 未匹配到提供的证据，不能核实", { 0: ref })}</span>)}
      {selected && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4">
          <section role="dialog" aria-modal="true" aria-label={tr("原始日志证据 {0}", { 0: selected.ref })} className={`w-full max-w-4xl rounded-xl border p-5 shadow-2xl ${isDark ? 'bg-[#202124] border-[#5F6368] text-[#E8EAED]' : 'bg-white border-slate-300 text-slate-800'}`}>
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold">{selected.source === 'diagnostic-snapshot' ? tr("规则诊断时保存的上下文") : tr("原始日志")} [{selected.ref}]</h2>
              <button type="button" aria-label={tr("关闭证据")} onClick={() => setSelected(null)}><X size={18} /></button>
            </div>
            <p className="my-3 text-xs opacity-75">{tr("设备：")}{selected.deviceId || tr("未记录")} · {Number.isFinite(selected.ts) ? new Date(selected.ts).toLocaleString(getLocale()) : tr("时间未知")}{tr(" · 此内容在分析时冻结，不随过滤变化。")}</p>
            <pre className={`max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded-lg border p-3 text-xs ${isDark ? 'bg-[#2D2F33] border-emerald-500/40' : 'bg-emerald-50 border-emerald-200'}`}>{selected.raw}</pre>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 text-xs opacity-75">{tr("引用存在不等于推测成立；请结合原文核对 AI 结论。")}</p>
              {onLocate && <button type="button" onClick={() => {
                const result = onLocate(selected);
                if (result === true) setSelected(null);
                else setLocateMessage(result);
              }} className={`inline-flex items-center gap-2 rounded-md border border-emerald-500/40 px-3 py-2 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 ${isDark ? 'text-emerald-300 hover:bg-emerald-500/15' : 'text-emerald-700 hover:bg-emerald-50'}`}>
                <Crosshair size={14} aria-hidden="true" />{tr("定位原始日志")}
              </button>}
            </div>
            {locateMessage && <p role="status" className={`mt-2 text-xs ${isDark ? 'text-amber-300' : 'text-amber-800'}`}>{locateMessage}</p>}
          </section>
        </div>
      )}
    </div>
  );
}
