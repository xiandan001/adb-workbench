import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronDown, ClipboardList, FilePlus, FilePenLine, Layers3, Pencil, Play, Plus, Search, Smartphone, Upload, X } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n';
import { isDarkTheme } from '../shared/theme';
import { getTaskStatusLabel } from '../shared/taskCenterWorkspace';

export default function TaskCenterQuickStart({
  theme, navigation, targetPicker, scripts, readiness, devices, targetIds, history, draft, templates,
  onRecord, recordingGuide, onImport, onCreate, onTemplate, onOpenScript, onRunScript, onResume, running
}) {
  const locale = useLocale();
  const [query, setQuery] = useState('');
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const newMenuRef = useRef(null);
  const dark = isDarkTheme(theme);
  const panel = dark ? 'border-[#3E4145] bg-[#202124]' : 'border-slate-200 bg-white';
  const divider = dark ? 'border-[#3E4145]' : 'border-slate-200';
  const secondary = `inline-flex min-h-9 items-center gap-2 rounded-lg border px-3 py-2 text-sm ${theme.button.secondary}`;
  const search = query.trim().toLocaleLowerCase();
  const rows = scripts.filter(script => !search || [scriptLabel(script), script.description].some(value => String(value || '').toLocaleLowerCase().includes(search)));
  const latestById = new Map();
  for (const run of history) if (run.scriptId && !latestById.has(run.scriptId)) latestById.set(run.scriptId, run);

  useEffect(() => {
    const close = event => {
      const menu = newMenuRef.current;
      if (menu?.open && ((event.type === 'pointerdown' && !menu.contains(event.target)) || event.key === 'Escape')) {
        menu.open = false;
        if (event.key === 'Escape') menu.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);

  const newActions = [
    [Smartphone, tr('录制操作'), onRecord],
    [Layers3, tr('从模板新建'), () => setTemplatesOpen(open => !open)],
    [Upload, tr('导入脚本'), onImport],
    [FilePlus, tr('空白任务'), onCreate]
  ];
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      {navigation}
      <div className="flex items-center gap-2">
        {recordingGuide && <button type="button" data-task-center-guide="recording-entry" onClick={onRecord} className={secondary}><Smartphone size={16} />{tr('录制操作')}</button>}
        <details ref={newMenuRef} className="relative">
          <summary className={`flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden ${theme.button.primary}`}><Plus size={16} />{tr('新建任务')}<ChevronDown size={13} /></summary>
          <div className={`absolute right-0 top-full z-20 mt-2 min-w-48 rounded-xl border p-1.5 shadow-xl ${panel}`}>
            {newActions.map(([Icon, label, action]) => <button key={label} type="button" onClick={() => { newMenuRef.current.open = false; action(); }} className="flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-sm hover:bg-slate-500/10"><Icon size={16} className={theme.textMuted} />{label}</button>)}
          </div>
        </details>
      </div>
    </div>
    {templatesOpen && <section className={`rounded-xl border p-4 ${panel}`}>
      <div className="mb-3 flex items-center justify-between gap-3"><h3 className="font-semibold">{tr('选择场景')}</h3><button type="button" className={secondary} onClick={() => setTemplatesOpen(false)} aria-label={tr('关闭')}><X size={14} /></button></div>
      <div className="grid gap-2 sm:grid-cols-2 min-[1400px]:grid-cols-3">
        {templates.map(({ id, icon: Icon, title, description }) => <button type="button" className={`flex items-start gap-3 rounded-lg border p-3 text-left hover:bg-slate-500/10 ${divider}`} key={id} onClick={() => onTemplate(id)}>
          <Icon size={17} className="mt-0.5 shrink-0 text-emerald-500" /><span className="min-w-0"><span className="block text-sm font-medium">{title}</span><span className={`mt-1 block text-xs leading-5 ${theme.textMuted}`}>{description}</span></span>
        </button>)}
      </div>
    </section>}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="relative w-full sm:max-w-72">
        <Search size={16} className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 ${theme.textMuted}`} />
        <input value={query} maxLength={200} onChange={event => setQuery(event.target.value)} aria-label={tr('搜索任务名称')} placeholder={tr('搜索任务名称')} className={`w-full rounded-lg border py-2.5 pl-9 pr-9 text-sm ${theme.input}`} />
        {query && <button type="button" onClick={() => setQuery('')} className={`absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 hover:bg-slate-500/10 ${theme.textMuted}`} aria-label={tr('清空搜索')}><X size={14} /></button>}
      </div>
      {targetPicker}
    </div>
    <div className={`overflow-hidden rounded-xl border ${panel}`}>
      <div className={`hidden grid-cols-[minmax(0,2fr)_minmax(0,1.1fr)_minmax(0,1.3fr)_auto] gap-4 border-b px-4 py-3 text-xs lg:grid ${divider} ${theme.textMuted}`}>
        <span>{tr('任务')}</span><span>{tr('运行目标')}</span><span>{tr('最近结果')}</span><span>{tr('操作')}</span>
      </div>
      {rows.length ? <ul className="divide-y divide-current/10">
        {rows.map(script => {
          const { ready, issue } = readiness.get(script.id);
          const last = latestById.get(script.id);
          const ScriptIcon = script.mode === 'stress' ? Layers3 : ClipboardList;
          return <li key={script.id} className="grid items-center gap-3 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,2fr)_minmax(0,1.1fr)_minmax(0,1.3fr)_auto] lg:gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-emerald-500/10 text-emerald-500"><ScriptIcon size={18} /></span>
              <div className="min-w-0">
                <button type="button" onClick={() => onOpenScript(script)} className="max-w-full truncate text-left text-sm font-semibold hover:text-emerald-500" title={scriptLabel(script)}>{scriptLabel(script)}</button>
                <p className={`truncate text-xs ${theme.textMuted}`}>{tr('{0} 个步骤', { 0: script.steps?.length || 0 })}{issue?.name && ` · ${issue.label}`}</p>
              </div>
            </div>
            <p className={`min-w-0 truncate text-sm lg:block ${theme.textMuted}`} title={targetNames(targetIds, devices)}>{targetNames(targetIds, devices)}</p>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span className={`whitespace-nowrap rounded-md px-2 py-1 ${last?.status === 'success' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : last?.status === 'failed' ? 'bg-amber-500/10 text-amber-600 dark:text-amber-300' : `bg-slate-500/10 ${theme.textMuted}`}`}>{last ? getTaskStatusLabel(last.status) : tr('未执行')}</span>
              {last && formatDate(last.endedAt || last.createdAt, locale) && <span className={theme.textMuted}>{formatDate(last.endedAt || last.createdAt, locale)}</span>}
            </div>
            <div className="flex items-center gap-1.5 sm:justify-self-end">
              {ready ? <button type="button" disabled={running} className={`${secondary} disabled:opacity-50`} onClick={() => onRunScript(script)}><Play size={14} />{tr('运行')}</button> : <button type="button" className={secondary} onClick={() => onOpenScript(script, issue)} title={issue?.label}><Pencil size={14} />{tr('去配置')}</button>}
            </div>
          </li>;
        })}
      </ul> : <p className={`p-8 text-center text-sm ${theme.textMuted}`}>{search ? tr('没有符合条件的任务') : tr('暂无已保存测试')}</p>}
      <div className={`flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2.5 text-xs ${divider} ${theme.textMuted}`}><span>{tr('共 {0} 个任务', { 0: rows.length })}</span><span>{tr('点击任务名称可查看或编辑步骤')}</span></div>
    </div>
    {draft && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-4 py-3">
      <div className="flex min-w-0 items-center gap-2.5 text-sm"><FilePenLine size={16} className="shrink-0 text-emerald-500" /><span className="min-w-0 truncate">{tr('未保存草稿：{0}', { 0: draft.name })}</span><span className={`shrink-0 text-xs ${theme.textMuted}`}>{tr('{0} 个步骤', { 0: draft.steps?.length || 0 })}</span></div>
      <button type="button" onClick={onResume} className="flex items-center gap-1.5 text-sm font-medium text-emerald-600 hover:underline dark:text-emerald-400">{tr('继续编辑')}<ArrowRight size={14} /></button>
    </div>}
  </div>;
}

function scriptLabel(script) {
  return script.id === 'default-smoke-test' && script.createdAt === 'builtin' && script.updatedAt === 'builtin' ? tr(script.name) : script.name;
}

export function targetNames(ids, devices) {
  if (!ids.length) return tr('未指定');
  return ids.map(id => { const device = devices.find(item => item.id === id); return device?.model || device?.name || id; }).join(' · ');
}

function formatDate(value, locale) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
