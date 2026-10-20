import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { findEvidenceReferences } from '../shared/logWorkspace';

export default function LogEvidence({ content, allowedRefs, evidence, isDark }) {
  const [selected, setSelected] = useState(null);
  const allowedIndex = useMemo(() => new Set(allowedRefs || []), [allowedRefs]);
  const references = useMemo(() => findEvidenceReferences(content, allowedIndex, evidence), [content, allowedIndex, evidence]);
  if (!references.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {references.map(({ ref, entry }) => entry ? (
        <button key={ref} type="button" onClick={() => setSelected(entry)} className={`rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs ${isDark ? 'text-emerald-300' : 'text-emerald-700'}`}>查看依据 [{ref}]</button>
      ) : <span key={ref} className="text-xs text-amber-500">[{ref}] 未匹配到提供的证据，不能核实</span>)}
      {selected && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4">
          <section role="dialog" aria-modal="true" aria-label={`原始日志证据 ${selected.ref}`} className={`w-full max-w-4xl rounded-xl border p-5 shadow-2xl ${isDark ? 'bg-[#202124] border-[#5F6368] text-[#E8EAED]' : 'bg-white border-slate-300 text-slate-800'}`}>
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold">{selected.source === 'diagnostic-snapshot' ? '规则诊断时保存的上下文' : '原始日志'} [{selected.ref}]</h2>
              <button type="button" aria-label="关闭证据" onClick={() => setSelected(null)}><X size={18} /></button>
            </div>
            <p className="my-3 text-xs opacity-75">设备：{selected.deviceId || '未记录'} · {Number.isFinite(selected.ts) ? new Date(selected.ts).toLocaleString('zh-CN') : '时间未知'} · 此内容在分析时冻结，不随过滤变化。</p>
            <pre className={`max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded-lg border p-3 text-xs ${isDark ? 'bg-[#2D2F33] border-emerald-500/40' : 'bg-emerald-50 border-emerald-200'}`}>{selected.raw}</pre>
            <p className="mt-3 text-xs opacity-75">引用存在不等于推测成立；请结合原文核对 AI 结论。</p>
          </section>
        </div>
      )}
    </div>
  );
}
