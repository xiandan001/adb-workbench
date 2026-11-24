import { useState } from 'react';
import { ArrowLeftRight, BookCheck, History } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n';
import AiWorkspaceHistory, { AiWorkspaceComparison } from './AiWorkspaceHistory';
import AiWorkspaceCasebook from './AiWorkspaceCasebook';

export default function AiWorkspaceTools({ state, theme }) {
  useLocale();
  const [tool, setTool] = useState('history');
  const tools = [
    { id: 'history', label: tr('历史记录'), icon: History },
    { id: 'casebook', label: tr('本地验证案例库'), icon: BookCheck },
    { id: 'compare', label: tr('前后对比'), icon: ArrowLeftRight },
  ];
  const canCompare = state.mode !== 'task' && Boolean(state.current.preview || state.current.reportView);
  const selected = !canCompare && tool === 'compare' ? 'history' : tool;
  return <div className="min-w-0 space-y-3">
    <div className={`flex flex-wrap gap-1 rounded-lg border p-1 ${theme.input}`}>
      {tools.filter(item => canCompare || item.id !== 'compare').map(item => (
        <button key={item.id} type="button" aria-pressed={selected === item.id} onClick={() => setTool(item.id)}
          className={`flex min-w-0 items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium focus-visible:outline-2 focus-visible:outline-emerald-500 ${selected === item.id ? theme.button.primary : theme.button.secondary}`}>
          <item.icon size={14} aria-hidden="true" className="shrink-0" /><span className="break-words">{item.label}</span>
        </button>
      ))}
    </div>
    <div hidden={selected !== 'history'}><AiWorkspaceHistory state={state} theme={theme} /></div>
    <div hidden={selected !== 'casebook'}><AiWorkspaceCasebook state={state} theme={theme} /></div>
    {canCompare && <div hidden={selected !== 'compare'}><AiWorkspaceComparison state={state} theme={theme} /></div>}
  </div>;
}
