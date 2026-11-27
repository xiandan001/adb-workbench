import { createElement, useCallback, useId, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bot, Cable, ClipboardList, Crown, Gauge, HardDriveDownload, MessageSquare,
  PanelLeftClose, PanelLeftOpen, Server, Settings, Smartphone, Sparkles,
} from 'lucide-react';
import { tr } from '../shared/i18n.js';
import '../styles/workbenchSidebar.css';

const modeKey = 'adb-workbench.sidebar-mode.v1';

function readWorkbenchSidebarMode() {
  try {
    return globalThis.localStorage?.getItem(modeKey) === 'rail' ? 'rail' : 'compact';
  } catch { return 'compact'; }
}

function saveMode(mode) {
  try { globalThis.localStorage?.setItem(modeKey, mode); } catch { /* storage may be unavailable */ }
}

const deviceItems = [
  ['devices', Smartphone, () => tr('设备列表')],
  ['firmware', HardDriveDownload, () => tr('固件刷机')],
  ['serial', Cable, () => tr('串口 / RS232')],
  ['ssh', Server, () => tr('SSH 工作区')],
];
const centerItems = [
  ['test-center', ClipboardList, () => tr('测试中心')],
  ['diagnostics-center', Gauge, () => tr('诊断中心')],
  ['ai-center', Sparkles, () => tr('AI 中心')],
  ['logs', Bot, () => tr('AI 日志助手')],
];
const utilityItems = [
  ['member', Crown, () => tr('会员中心')],
  ['settings', Settings, () => tr('偏好设置')],
];
const brandAccents = new Set(['cyan', 'blue', 'pink', 'green', 'orange']);

export function WorkbenchSidebarButton({ label, showHint = false, children, onClick, ...props }) {
  const [hint, setHint] = useState(null);
  const visible = showHint && hint !== null;
  const show = (event, keyboard = false) => {
    if (!showHint || (keyboard && !event.currentTarget.matches(':focus-visible'))) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setHint({
      top: Math.min(window.innerHeight - 12, Math.max(12, rect.top + rect.height / 2)),
      left: rect.right + 8,
      maxWidth: Math.max(40, Math.min(320, window.innerWidth - rect.right - 16)),
    });
  };
  const dismiss = useCallback(() => setHint(null), []);
  useLayoutEffect(() => {
    if (!visible) return undefined;
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [visible, dismiss]);
  return <>
    <button type="button" aria-label={label} {...props} onMouseEnter={show}
      onMouseLeave={event => { if (!event.currentTarget.matches(':focus-visible')) dismiss(); }}
      onFocus={event => show(event, true)}
      onBlur={dismiss}
      onKeyDown={event => { if (event.key === 'Escape') dismiss(); }}
      onClick={event => { dismiss(); onClick?.(event); }}>
      {children}
    </button>
    {visible && createPortal(
      <span aria-hidden="true" className="workbench-sidebar-tip" style={hint}>
        {label}
      </span>, document.body,
    )}
  </>;
}

export default function WorkbenchSidebar({
  activeTab, activeCenter, locale, primary, brandIcon, onNavigate, onFeedback, renderStatus,
}) {
  const [mode, setMode] = useState(readWorkbenchSidebarMode);
  const navId = useId();
  const rail = mode === 'rail';
  const toggleMode = () => {
    const next = rail ? 'compact' : 'rail';
    setMode(next);
    saveMode(next);
  };
  const renderItem = ([key, icon, title]) => {
    const label = title();
    const active = key === activeTab || key === activeCenter;
    return <WorkbenchSidebarButton key={key} className="workbench-sidebar-item" label={label} showHint={rail}
      aria-current={active ? 'page' : undefined} data-sidebar-destination={key} onClick={() => onNavigate(key)}>
      {createElement(icon, { size: 18, 'aria-hidden': true })}
      <span className="workbench-sidebar-label">{label}</span>
    </WorkbenchSidebarButton>;
  };
  const feedback = <WorkbenchSidebarButton className="workbench-sidebar-control" label={tr('打开问题反馈')}
    showHint onClick={onFeedback}><MessageSquare size={17} aria-hidden="true" /></WorkbenchSidebarButton>;

  return <div className="workbench-sidebar" data-locale={locale} data-mode={mode}
    data-accent={brandAccents.has(primary) ? primary : 'emerald'}>
    <div className="workbench-sidebar-brand">
      <img src={brandIcon} width={26} height={26} alt="" aria-hidden="true" />
      <h1 className="workbench-sidebar-label">{tr('卓控台')}</h1>
      {!rail && feedback}
      <WorkbenchSidebarButton className="workbench-sidebar-control" label={rail ? tr('展开侧栏') : tr('折叠侧栏')}
        showHint aria-controls={navId} aria-expanded={!rail} data-sidebar-toggle="" onClick={toggleMode}>
        {rail ? <PanelLeftOpen size={17} aria-hidden="true" /> : <PanelLeftClose size={17} aria-hidden="true" />}
      </WorkbenchSidebarButton>
    </div>
    <nav id={navId} aria-label={tr('导航')} className="workbench-sidebar-nav">
      <div className="workbench-sidebar-group" role="group" aria-label={tr('设备与连接')}>
        <div className="workbench-sidebar-group-label" aria-hidden="true">{tr('设备与连接')}</div>
        {deviceItems.map(renderItem)}
      </div>
      <div className="workbench-sidebar-group" role="group" aria-label={tr('工作中心')}>
        <div className="workbench-sidebar-group-label" aria-hidden="true">{tr('工作中心')}</div>
        {centerItems.map(renderItem)}
      </div>
    </nav>
    <footer className="workbench-sidebar-footer">
      {utilityItems.map(renderItem)}
      {rail && feedback}
      <div className="workbench-sidebar-status">{renderStatus?.(rail)}</div>
    </footer>
  </div>;
}
