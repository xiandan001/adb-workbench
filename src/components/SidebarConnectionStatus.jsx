import { useEffect, useState } from 'react';
import { Cable, Server } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';
import { hasConnectionActivity, subscribeConnectionStatus } from '../shared/connectionStatus.js';

export default function SidebarConnectionStatus({ onNavigate, onSummary }) {
  useLocale();
  const [states, setStates] = useState({});
  const [errors, setErrors] = useState({});
  useEffect(() => subscribeConnectionStatus({
    api: window.electronAPI, document, window,
    onStatus: (id, value) => setStates(previous => ({ ...previous, [id]: value })),
    onError: (id, value) => setErrors(previous => previous[id] === value ? previous : { ...previous, [id]: value })
  }), []);
  const items = [{ id: 'serial', name: tr('串口'), icon: Cable }, { id: 'ssh', name: 'SSH', icon: Server }]
    .filter(item => errors[item.id] || hasConnectionActivity(states[item.id]));
  useEffect(() => {
    onSummary?.({ connections: Object.values(states).reduce((sum, value) => sum + (value?.activeCount || 0), 0),
      issues: Object.values(states).reduce((sum, value) => sum + (value?.failedCount || 0), 0) + Object.values(errors).filter(Boolean).length });
  }, [states, errors, onSummary]);
  if (!items.length) return null;
  return <div aria-label={tr('后台连接状态')} className="space-y-1 border-t border-white/10 px-3 py-2">
    {items.map(item => {
      const status = states[item.id];
      const Icon = item.icon;
      const summary = errors[item.id] ? tr('状态暂不可用，点击查看') : [
        tr('连接 {0}', { 0: status.activeCount }),
        status.pendingCount ? tr('处理中 {0}', { 0: status.pendingCount }) : '',
        status.unsavedCount ? tr('未保存 {0}', { 0: status.unsavedCount }) : '',
        status.failedCount ? tr('异常 {0}', { 0: status.failedCount }) : '',
        status.transferCount ? tr('传输 {0}', { 0: status.transferCount }) : ''
      ].filter(Boolean).join(' · ');
      return <button key={item.id} type="button" onClick={() => onNavigate(item.id)} title={item.name + ' · ' + summary + (status?.labels.length ? '\n' + status.labels.join('、') : '')} className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] leading-4 text-slate-300 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400">
        <Icon size={13} className={errors[item.id] || status?.failedCount ? 'mt-0.5 shrink-0 text-amber-400' : 'mt-0.5 shrink-0 text-emerald-400'} />
        <span className="min-w-0"><span className="font-medium">{item.name}</span><span className="ml-1 break-words">{summary}</span></span>
      </button>;
    })}
  </div>;
}
