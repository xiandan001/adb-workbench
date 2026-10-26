import { Bot, ClipboardCheck, Database, FileSearch, Layers3, Loader2, RefreshCw, RotateCcw, ShieldCheck, Sparkles, Square, Stethoscope } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n';
import { isDarkTheme } from '../shared/theme';
import useAiWorkspace from './AiWorkspaceController';
import { toggleWorkspaceSelection, workspaceDeviceOnline } from './AiWorkspaceState';
import AiWorkspaceEvidence, { AiWorkspaceUsage } from './AiWorkspaceEvidence';
import { AiWorkspaceAnalysis, AiWorkspaceTask } from './AiWorkspaceResults';
import SelectMenu from './SelectMenu';

function WorkspaceRules({ theme }) {
  return <details className={`rounded-xl border px-4 py-3 ${theme.card}`}>
    <summary className="cursor-pointer text-xs"><ShieldCheck size={15} className="mr-2 inline text-emerald-500" /><span className="font-medium">{tr('内置 AI 优先 · 先预览再发送 · 不自动执行')}</span><span className={`ml-3 ${theme.textMuted}`}>{tr('查看使用规则')}</span></summary>
    <ol className={`mt-3 list-decimal space-y-1.5 pl-5 text-xs leading-5 ${theme.textMuted}`}>
      <li>{tr('沿用本软件内置 AI 和会员权益，不需新账号或密钥，不会静默切换服务。')}</li>
      <li>{tr('三个工作区分别保存状态，设备和证据来源显式选择，不随其他页面切换。')}</li>
      <li>{tr('采集仅在本机完成；发送前可逐项核对脱敏内容，不自动上传其他会话或文件。')}</li>
      <li>{tr('调用有大小与超时限制，不自动重试，也不在后台定时调用 AI；无用量数据时明确显示未知。')}</li>
      <li>{tr('排障只执行所选的固定只读检查；测试任务先审阅再保存，禁止任意命令和自动执行。')}</li>
      <li>{tr('日志只是证据，不是操作指令。推测与事实分开显示，时间未同步时不作确定因果判断。')}</li>
    </ol>
  </details>;
}

function SelectionCards({ items, selected, onToggle, disabled, theme, empty }) {
  if (!items.length) return <p className={`rounded-lg border border-dashed border-slate-400/25 p-4 text-xs leading-5 ${theme.textMuted}`}>{empty}</p>;
  return <div className="max-h-64 space-y-2 overflow-y-auto pr-1">{items.map(item => <label key={item.id} className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 ${selected.includes(item.id) ? 'border-emerald-500/40 bg-emerald-500/5' : theme.input} ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}>
    <input type="checkbox" checked={selected.includes(item.id)} disabled={disabled} onChange={() => onToggle(item.id)} className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-emerald-500" />
    <span className="min-w-0"><span className="block break-words text-xs font-medium">{item.label}</span>{(item.description || item.detail) && <span className={`mt-1 block break-all text-[11px] leading-5 ${theme.textMuted}`}>{item.description || item.detail}</span>}</span>
  </label>)}</div>;
}

export default function AiWorkspace({ theme, active = true, devices = [], activeDeviceId = '', onOpenTasks, onOpenMembership, showToast }) {
  useLocale();
  const state = useAiWorkspace({ active, activeDeviceId, onOpenTasks, showToast });
  const { mode, current, sources, loading, sourceError } = state;
  const dark = isDarkTheme(theme); const busy = Boolean(current.busy);
  const entitled = sources.entitled === true;
  const online = workspaceDeviceOnline(devices, current.deviceId);
  const onlineDevices = devices.filter(device => device.status === 'device');
  const availableSources = new Set((sources.sources || []).map(source => source.id));
  const staleSources = current.sourceIds.some(id => !availableSources.has(id));
  const input = `w-full min-w-0 rounded-lg border px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-emerald-500/25 disabled:opacity-60 ${theme.input}`;
  const button = `inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${theme.button.secondary}`;
  const primary = `inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${theme.button.primary}`;
  const modes = [
    { id: 'diagnose', title: tr('AI 排障助手'), detail: tr('从问题到检查，再到证据结论'), icon: Stethoscope },
    { id: 'analysis', title: tr('AI 多源联合分析'), detail: tr('关联日志、串口和 SSH 终端'), icon: Layers3 },
    { id: 'task', title: tr('AI 生成测试任务'), detail: tr('把测试目标变成可审阅的步骤'), icon: ClipboardCheck },
  ];
  const currentMode = modes.find(item => item.id === mode);
  const busyLabel = {
    plan: tr('正在生成只读检查计划…'), collect: tr('正在本机采集并脱敏…'), analyze: tr('正在使用内置 AI 分析…'),
    generate: tr('正在生成测试任务草案…'), save: tr('正在确认并保存任务…'), cancelling: tr('正在取消…'),
  }[current.busy];
  const canCollect = current.question.trim() && !busy && !loading && (mode === 'diagnose' ? online && current.checks.length > 0 : !staleSources && (current.sourceIds.length > 0 || current.text.trim()));

  return <section aria-label={tr('AI 工作区')} className={`min-w-0 space-y-4 ${theme.text}`}>
    <div className={`flex flex-wrap items-center gap-3 rounded-xl border p-4 ${theme.card}`}>
      <Bot size={23} className="text-emerald-500" /><div className="min-w-0 flex-1"><h2 className="text-base font-semibold">{tr('AI 工作区')}</h2><p className={`mt-1 text-xs ${theme.textMuted}`}>{tr('复用内置 AI，让排障、证据分析和测试准备连贯完成。')}</p></div>
      <button type="button" onClick={state.refresh} disabled={loading} className={button} title={tr('只刷新本地来源与会员状态，不调用 AI')}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} />{tr('刷新来源')}</button>
    </div>
    <WorkspaceRules theme={theme} />
    {sourceError && <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/5 px-3 py-2 text-xs text-red-500">{tr(sourceError)}</p>}
    {!entitled && !loading && <div className={`flex flex-wrap items-center gap-3 rounded-xl border p-4 ${theme.card}`}><ShieldCheck size={21} className="shrink-0 text-emerald-500" /><p className={`min-w-0 flex-1 text-xs leading-5 ${theme.textMuted}`}>{tr('AI 调用沿用本软件会员权限。请在会员中心确认激活；无需新建 AI 账号。')}</p><button type="button" onClick={onOpenMembership} disabled={!onOpenMembership} className={button}>{tr('打开会员中心')}</button></div>}
    <div role="tablist" aria-label={tr('AI 工作区功能')} className="grid gap-2 md:grid-cols-3">{modes.map(item => <button key={item.id} type="button" role="tab" id={`ai-workspace-tab-${item.id}`} aria-selected={mode === item.id} aria-controls={`ai-workspace-panel-${item.id}`} onClick={() => state.setMode(item.id)} className={`flex items-center gap-3 rounded-xl border p-3 text-left ${mode === item.id ? (dark ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700') : theme.card}`}>
      <item.icon size={20} className="shrink-0" /><span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{item.title}</span><span className={`mt-1 block text-[11px] ${theme.textMuted}`}>{item.detail}</span></span>{state.cases[item.id].busy && <Loader2 size={15} className="shrink-0 animate-spin" />}
    </button>)}</div>
    <div role="tabpanel" id={`ai-workspace-panel-${mode}`} aria-labelledby={`ai-workspace-tab-${mode}`} className="grid items-start gap-4 xl:grid-cols-[minmax(300px,0.85fr)_minmax(0,1.4fr)]">
      <div className="min-w-0 space-y-4">
        <section className={`space-y-4 rounded-xl border p-4 ${theme.card}`}>
          <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">{currentMode.title}</h3><button type="button" onClick={state.reset} disabled={busy} className={button} title={tr('清空本工作区的输入与结果，不影响其他工作区')}><RotateCcw size={13} />{tr('新建')}</button></div>
          <label className="block space-y-2"><span className="text-xs font-medium">{mode === 'task' ? tr('测试目标') : tr('描述你要分析的问题')}</span><textarea value={current.question} onChange={event => state.edit({ question: event.target.value })} disabled={busy} maxLength={4000} rows={4} className={`${input} resize-y leading-6`} placeholder={mode === 'task' ? tr('例如：等待首页出现“设置”，点击坐标 100, 200，截图并采集性能。请给出可核对的参数。') : tr('说明现象、复现条件和期望结果。不要填写密码、密钥或账号信息。')} /></label>
          {mode === 'diagnose' && <>
            <div className="space-y-2"><p className="text-xs font-medium">{tr('本次排障设备')}</p><SelectMenu ariaLabel={tr('本次排障设备')} value={current.deviceId} disabled={busy} onChange={deviceId => state.edit({ deviceId })} isDark={dark} className="w-full" options={[
              { value: '', label: tr('请选择在线设备') },
              ...(current.deviceId && !online ? [{ value: current.deviceId, label: tr('{0} · 已断开', { 0: current.deviceId }) }] : []),
              ...onlineDevices.map(device => ({ value: device.id, label: device.model ? `${device.model} · ${device.id}` : device.id })),
            ]} /></div>
            {current.deviceId && !online && <p className="text-xs leading-5 text-amber-600">{tr('所选设备已断开，不会自动改用其他设备。已有证据仍属于原设备。')}</p>}
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-medium">{tr('只读检查项目')}</span><button type="button" onClick={state.plan} disabled={busy || !entitled || !online || !current.question.trim()} className={button}><Sparkles size={14} />{tr('AI 建议检查计划')}</button></div>
            <SelectionCards items={sources.checks || []} selected={current.checks} onToggle={id => state.edit({ checks: toggleWorkspaceSelection(current.checks, id) })} disabled={busy} theme={theme} empty={loading ? tr('正在读取可用检查…') : tr('未读取到检查项目，请刷新来源。')} />
            {current.plan && <div className="space-y-2 rounded-lg bg-emerald-500/5 p-3"><p className={`whitespace-pre-wrap break-words text-xs leading-5 ${theme.textMuted}`}>{current.plan.reason}</p><AiWorkspaceUsage usage={current.planUsage} theme={theme} /></div>}
            <p className={`text-xs leading-5 ${theme.textMuted}`}>{tr('可直接手选检查，无需先调用 AI。点击采集只执行固定读取，不修改设备或清空日志。')}</p>
          </>}
          {mode === 'analysis' && <>
            <div className="space-y-2"><h4 className="text-xs font-medium">{tr('选择已有证据来源')}</h4><SelectionCards items={sources.sources || []} selected={current.sourceIds} onToggle={id => state.edit({ sourceIds: toggleWorkspaceSelection(current.sourceIds, id) })} disabled={busy} theme={theme} empty={tr('暂无可用来源。可先打开日志、串口或 SSH 终端，再刷新；也可粘贴文本分析。')} /></div>
            {staleSources && <div className="space-y-2 rounded-lg border border-amber-500/25 p-3"><p className="text-xs text-amber-600">{tr('部分所选来源已不可用，请移除后重新采集。')}</p><button type="button" disabled={busy} onClick={() => state.edit({ sourceIds: current.sourceIds.filter(id => availableSources.has(id)) })} className={button}>{tr('移除不可用来源')}</button></div>}
            <label className="block space-y-2"><span className="text-xs font-medium">{tr('补充文本（可选）')}</span><textarea value={current.text} onChange={event => state.edit({ text: event.target.value })} disabled={busy} rows={4} maxLength={12000} className={`${input} resize-y font-mono text-xs leading-5`} placeholder={tr('仅粘贴本次需要分析的片段；采集后会显示脱敏预览。')} /></label>
          </>}
          {mode === 'task' ? <><p className={`text-xs leading-5 ${theme.textMuted}`}>{tr('支持受控的点击、滑动、输入、按键、文本校验、等待、截图和性能采样。不会生成任意 Shell 或安装、删除操作。')}</p><button type="button" onClick={state.generate} disabled={busy || !entitled || !current.question.trim()} className={primary}><Sparkles size={15} />{tr('生成任务草案')}</button></> : <button type="button" onClick={state.collect} disabled={!canCollect} className={primary}><Database size={15} />{tr('采集并预览')}</button>}
          {busy && <div role="status" className="flex items-center gap-2 border-t border-slate-400/15 pt-3"><Loader2 size={16} className="shrink-0 animate-spin text-emerald-500" /><span className={`flex-1 text-xs ${theme.textMuted}`}>{busyLabel}</span>{current.busy !== 'save' && <button type="button" onClick={state.cancel} disabled={current.busy === 'cancelling'} className={button}><Square size={12} />{tr('取消')}</button>}</div>}
          {current.error && <p role="alert" className="break-words rounded-lg border border-red-500/25 bg-red-500/5 px-3 py-2 text-xs leading-5 text-red-500">{tr(current.error)}</p>}
        </section>
      </div>
      <div className="min-w-0 space-y-4">
        {current.preview && <AiWorkspaceEvidence preview={current.preview} busy={current.busy} entitled={entitled} onAnalyze={state.analyze} theme={theme} />}
        {current.result && current.preview && <AiWorkspaceAnalysis result={current.result} preview={current.preview} usage={current.usage} cached={current.cached} theme={theme} />}
        {current.draft && <AiWorkspaceTask draft={current.draft} busy={current.busy} onSave={state.save} usage={current.usage} theme={theme} />}
        {!current.preview && !current.draft && <div className={`flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed p-8 text-center ${theme.card}`}><FileSearch size={36} className="mb-4 text-emerald-500/50" /><h3 className="text-sm font-semibold">{mode === 'task' ? tr('先生成，再审阅，最后保存') : tr('先看证据，再让 AI 分析')}</h3><p className={`mt-2 max-w-sm text-xs leading-6 ${theme.textMuted}`}>{mode === 'task' ? tr('草案将逐步展示操作和参数。保存到任务中心后，你仍可以编辑并决定何时运行。') : tr('采集后会在这里显示完整发送预览。不同工作区与目标相互独立，切换页面不会丢失本次内容。')}</p></div>}
      </div>
    </div>
  </section>;
}
