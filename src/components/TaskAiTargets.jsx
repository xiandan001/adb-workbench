import { useEffect, useRef, useState } from 'react';
import { tr, useLocale } from '../shared/i18n';
import { Sparkles, Plus, X } from 'lucide-react';
import SelectMenu from './SelectMenu';

export default function TaskAiTargets({ recorder, busy, isDark }) {
  useLocale();
  const [selected, setSelected] = useState([]);
  const [nodeId, setNodeId] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const options = (recorder.nodes || []).filter(node => node.aiSelectable).map(node => ({ value: node.targetNodeId, label: node.label || node.resourceId || node.contentDesc }));
  const validNode = options.some(option => option.value === nodeId) ? nodeId : '';
  const button = `inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs disabled:opacity-40 ${isDark ? 'border-[#5F6368] hover:bg-[#3E4145]' : 'border-slate-200 hover:bg-slate-50'}`;
  async function select() {
    if (!validNode || working || busy) return;
    setWorking(true); setError('');
    try {
      const result = await window.electronAPI?.taskAiTargetSelect?.({ snapshotId: recorder.snapshotId, nodeId: validNode });
      if (!mounted.current) return;
      if (!result?.ok) throw new Error(result?.error || tr('控件选择失败，请重新读取界面。'));
      setSelected(previous => previous.some(item => item.token === result.target.token) ? previous : [...previous, result.target].slice(0, 10));
    } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { if (mounted.current) setWorking(false); }
  }
  async function handoff() {
    if (!selected.length || working || busy) return;
    setWorking(true); setError('');
    try {
      const result = await window.electronAPI?.taskAiTargetsHandoff?.({ tokens: selected.map(item => item.token) });
      if (!result?.ok) throw new Error(result?.error || tr('控件交接失败，请重新选择。'));
    } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { if (mounted.current) setWorking(false); }
  }
  return <section className={`space-y-3 rounded-lg border p-4 ${isDark ? 'border-emerald-500/25 bg-[#202124]' : 'border-emerald-200 bg-emerald-50/30'}`}>
    <h4 className="flex items-center gap-2 text-sm font-medium"><Sparkles size={15} />{tr('为 AI 选择真实控件')}</h4>
    <p className="text-xs leading-5 opacity-70">{tr('这里仅选择控件，不点击设备、不录制步骤、不调用 AI。读取界面后可选最多 10 个控件。')}</p>
    <SelectMenu id="task-ai-target" ariaLabel={tr('选择界面控件')} value={validNode} onChange={setNodeId} options={options} isDark={isDark} disabled={working || busy} placeholder={tr('先读取界面，再选择可唯一定位的控件')} />
    <div className="flex flex-wrap gap-2"><button type="button" disabled={!validNode || working || busy || selected.length >= 10} onClick={select} className={button}><Plus size={13} />{tr('加入选择')}</button>
      <button type="button" disabled={!selected.length || working || busy} onClick={handoff} className={button}><Sparkles size={13} />{tr('交给 AI 生成测试')}</button></div>
    {selected.map(target => <div key={target.token} className="flex min-w-0 items-center gap-2 rounded border border-current/10 px-2 py-1 text-xs"><span className="min-w-0 flex-1 truncate">{target.label}</span><button type="button" aria-label={tr('移除所选控件')} disabled={working} onClick={() => setSelected(items => items.filter(item => item.token !== target.token))}><X size={13} /></button></div>)}
    {error && <p role="alert" className="break-words text-xs text-red-500">{error}</p>}
  </section>;
}
