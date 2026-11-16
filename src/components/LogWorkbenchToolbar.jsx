import { useState } from 'react';
import { Archive, ChevronDown, Download, Filter, FolderOpen, ListFilter, Loader2, Pause, Play, RefreshCw, Search, Sparkles, Square, Terminal } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';
import SelectMenu from './SelectMenu.jsx';
import ApplicationPicker from './ApplicationPicker.jsx';
import LogBufferPicker from './LogBufferPicker.jsx';
import ResultActionsMenu from './ResultActionsMenu.jsx';

export default function LogWorkbenchToolbar({ theme, isDark, devices, deviceId, filterDevice, onDeviceChange, onRefresh, running, busy, source,
  buffers, selectedBuffers, onToggleBuffer, filter, onApplication, onStart, onStop, onOpenFile, archive, archiveState,
  onArchiveChange, onArchiveFolder, sessionControls, markerControls, onExport, moreActions, entriesCount, shownCount, truncated,
  text, onText, smartQuery, onSmartQuery, onSmartSearch, onSmartStop, smartSearching, smartResult, onSmartClear, isVip,
  onAnalyze, analyzing, onStopAnalyze, panelOpen, onPanelToggle, hasAnalysis, historyReadOnly, analysisPending, filterOpen, onFilterToggle, filterCount, issuesCount, onIssuesToggle,
  paused, pendingCount, onPause, onLatest, queryPending, advancedControls }) {
  useLocale(); const [searchMode, setSearchMode] = useState('text'), [advanced, setAdvanced] = useState(false);
  const secondary = `inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs disabled:opacity-40 ${theme.button.secondary}`;
  const activeDevice = devices.find(device => device.id === deviceId);
  const archiveActive = archiveState?.status === 'recording';
  const effectiveArchive = running && typeof archiveState?.enabled === 'boolean' ? archiveState.enabled : archive.enabled;
  return <header className={`shrink-0 space-y-2 border-b px-4 py-3 ${isDark ? 'border-[#3E4145] bg-[#2D2F33]' : 'border-slate-200 bg-white'}`}>
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <div className="mr-2 flex shrink-0 items-center gap-2"><Terminal size={20} className="text-emerald-500" /><h1 className={`text-sm font-semibold ${theme.text}`}>{tr('设备日志分析')}</h1></div>
      <button type="button" onClick={onRefresh} disabled={running || busy} aria-label={tr('刷新设备列表')} className={secondary}><RefreshCw size={14} /></button>
      <SelectMenu ariaLabel={tr('采集设备')} value={deviceId} onChange={onDeviceChange} disabled={running || busy || analyzing || smartSearching} isDark={isDark} compact className="min-w-40 flex-1 sm:max-w-72"
        options={[{ value: '', label: devices.length ? tr('选择设备') : tr('无设备连接') }, ...(deviceId && !activeDevice ? [{ value: deviceId, label: deviceId + ' · ' + tr('已离线'), disabled: true }] : []), ...devices.map(device => ({ value: device.id, label: device.label || device.model || device.id }))]} />
      {source === 'realtime' && <div className="min-w-40 flex-1 sm:max-w-64"><ApplicationPicker device={filterDevice || activeDevice || null} value={filter.pkg || ''} onChange={onApplication} theme={theme} label={tr('当前应用')} disabled={!(filterDevice || activeDevice)?.id || busy} /></div>}
      <LogBufferPicker options={buffers} selected={selectedBuffers} onChange={onToggleBuffer} disabled={running || busy || analyzing || smartSearching} isDark={isDark} />
      <button type="button" onClick={running ? onStop : onStart} disabled={busy || (!running && (!activeDevice || analyzing || smartSearching))} className={`inline-flex min-h-9 items-center justify-center gap-2 rounded-lg px-4 py-2 text-xs font-medium text-white disabled:opacity-40 ${running ? 'bg-red-600 hover:bg-red-500' : 'bg-emerald-600 hover:bg-emerald-500'}`}>{busy ? <Loader2 size={14} className="animate-spin" /> : running ? <Square size={13} /> : <Play size={14} />}{running ? tr('停止抓取') : archive.enabled ? tr('抓取并归档') : tr('开始抓取')}</button>
      <button type="button" onClick={onOpenFile} disabled={running || busy || analyzing || smartSearching} title={running ? tr('请先停止抓取，再打开日志文件。') : tr('打开 .log 日志文件')} className={secondary}><FolderOpen size={14} />{tr('打开文件')}</button>
      <button type="button" onClick={onExport} disabled={busy || !shownCount || queryPending} className={secondary}><Download size={14} />{tr('导出')}</button>
      <ResultActionsMenu actions={moreActions} isDark={isDark} disabled={busy} />
    </div>
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <div className={`flex min-w-56 flex-1 items-center gap-2 rounded-lg border px-2 ${theme.input}`}>
        <Search size={14} className="shrink-0 opacity-60" />
        <input aria-label={searchMode === 'text' ? tr('包含文本') : tr('自然语言搜索日志')} value={searchMode === 'text' ? text : smartQuery} onChange={event => searchMode === 'text' ? onText(event.target.value) : onSmartQuery(event.target.value)}
          onKeyDown={event => { if (searchMode === 'semantic' && event.key === 'Enter' && !event.isComposing && !smartSearching) { event.preventDefault(); onSmartSearch(); } }}
          placeholder={searchMode === 'text' ? tr('过滤日志文本，或点击包名 / Tag 快速筛选') : tr('自然语言搜索日志，如「所有内存相关的错误」')} maxLength={1000} className="min-w-0 flex-1 bg-transparent py-2 text-xs outline-none" />
        {isVip && <SelectMenu ariaLabel={tr('搜索方式')} compact value={searchMode} isDark={isDark} className="w-24 shrink-0" onChange={value => { setSearchMode(value); if (value === 'text') onSmartClear(); }} options={[{ value: 'text', label: tr('文本过滤') }, { value: 'semantic', label: tr('AI 搜索') }]} />}
        {searchMode === 'semantic' && <button type="button" onClick={smartSearching ? onSmartStop : onSmartSearch} disabled={!smartSearching && !smartQuery.trim()} className="shrink-0 rounded px-2 py-1 text-xs text-emerald-500 disabled:opacity-40">{smartSearching ? tr('中止') : tr('搜索')}</button>}
      </div>
      <button type="button" onClick={onFilterToggle} aria-expanded={filterOpen} className={secondary}><Filter size={14} />{tr('过滤')}{filterCount > 0 && <span className="text-emerald-500">{filterCount}</span>}</button>
      <button type="button" onClick={onIssuesToggle} className={secondary}><ListFilter size={14} />{tr('问题列表')}{issuesCount > 0 && <span className="text-amber-500">{issuesCount}</span>}</button>
      <button type="button" onClick={analyzing ? onStopAnalyze : onAnalyze} disabled={!analyzing && (!shownCount || (analysisPending ?? queryPending))} className={`inline-flex min-h-9 items-center gap-2 rounded-lg px-4 py-2 text-xs font-medium text-white disabled:opacity-40 ${analyzing ? 'bg-red-600' : 'bg-emerald-600 hover:bg-emerald-500'}`}><Sparkles size={14} />{analyzing ? tr('停止分析') : historyReadOnly ? tr('查看历史分析') : tr('分析当前筛选')}</button>
      {(panelOpen || hasAnalysis) && <button type="button" onClick={onPanelToggle} className={secondary}>{panelOpen ? tr('收起分析') : tr('查看分析')}</button>}
    </div>
    <div className={`flex flex-wrap items-center gap-2 text-[11px] ${theme.textMuted}`}>
      {sessionControls}{markerControls}
      <label className="inline-flex items-center gap-2"><input type="checkbox" checked={effectiveArchive} disabled={running || busy} onChange={event => onArchiveChange({ ...archive, enabled: event.target.checked })} className="accent-emerald-500" /><Archive size={14} />{tr('同时保存完整原始日志到本机')}</label>
      <span>{tr('已加载 {0} 条 · 当前显示 {1} 条', { 0: entriesCount.toLocaleString(), 1: shownCount.toLocaleString() })}</span>
      {truncated && <span className="text-amber-500">{tr('仅显示最近日志')}</span>}
      {smartResult && <button type="button" onClick={onSmartClear} className="rounded px-2 py-1 text-violet-500 underline">{tr('返回原日志')}</button>}
      <div className="flex-1" />
      <button type="button" onClick={onPause} aria-pressed={paused} className="inline-flex items-center gap-1 rounded border border-current/20 px-2 py-1"><Pause size={12} />{paused ? running ? tr('已暂停查看，采集仍在继续') : tr('已暂停查看当前快照') : tr('暂停查看')}</button>
      <button type="button" onClick={onLatest} className="rounded border border-current/20 px-2 py-1">{pendingCount ? tr('回到最新（新增 {0} 条）', { 0: pendingCount }) : tr('跟随最新')}</button>
      <button type="button" onClick={() => setAdvanced(value => !value)} aria-expanded={advanced} className="inline-flex items-center gap-1 rounded px-2 py-1">{tr('高级')}<ChevronDown size={12} /></button>
    </div>
    {advanced && <div role="group" aria-label={tr('日志高级设置')} className={`flex flex-wrap items-center gap-3 rounded-lg border p-3 text-xs ${theme.input}`}>
      <SelectMenu ariaLabel={tr('本机归档总配额')} compact value={String(archive.maxBytes)} onChange={value => onArchiveChange({ ...archive, maxBytes: Number(value) })} disabled={running || busy} isDark={isDark} className="w-36" options={[128, 256, 512, 1024].map(value => ({ value: String(value * 1024 * 1024), label: tr('{0} MiB', { 0: value }) }))} />
      <button type="button" onClick={onArchiveFolder} className={secondary}>{tr('打开归档目录')}</button>
      <span className="w-full text-[11px] opacity-70">{tr('达到配额将停止归档并提示，不自动删除旧日志；不调用 AI。')}</span>
      {advancedControls}
    </div>}
    {(archive.enabled || archiveActive || archiveState?.partial) && <p role="status" className={`text-[11px] ${archiveState?.partial ? 'text-amber-500' : theme.textMuted}`}>{archiveState?.partial ? tr('归档未完整，后续日志仍可在当前显示窗口查看；请检查磁盘和配额。') : archiveActive ? tr('原始日志正在本机归档') : tr('下次开始抓取将同时保存原始日志到本机')}</p>}
  </header>;
}
