import { ArrowUpRight, ChevronDown, CircleAlert, ClipboardCheck, Database, FileSearch, Layers3, Loader2, RefreshCw, RotateCcw, ShieldCheck, Sparkles, Square, Stethoscope } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n';
import { isDarkTheme } from '../shared/theme';
import useAiWorkspace from './AiWorkspaceController';
import { toggleWorkspaceSelection, workspaceDeviceOnline } from './AiWorkspaceState';
import { AiWorkspaceUsage } from './AiWorkspaceEvidence';
import { AiWorkspaceReport, AiWorkspaceTask } from './AiWorkspaceResults';
import { AiWorkspaceContext, AiWorkspaceRequirements, AiWorkspaceSelection } from './AiWorkspaceControls';
import { AiWorkspaceReportActions, AiWorkspaceNextActions } from './AiWorkspaceHistory';
import AiWorkspaceDiagnostics from './AiWorkspaceDiagnostics';
import AiWorkspaceHandoff from './AiWorkspaceHandoff';
import AiWorkspaceRelated from './AiWorkspaceRelated';
import { focusWorkspaceRequiredField, workspaceApplicationChecks, workspaceHasAlternateEvidence, workspacePhase, workspaceReadiness, workspaceTaskTarget } from './AiWorkspaceFlow';
import SelectMenu from './SelectMenu';
import AiContextTextInput from './AiContextTextInput';
import { useEffect, useRef, useState } from 'react';
import useAiMaterialBudget from '../shared/useAiMaterialBudget.js';
import AiMaterialBudget from './AiMaterialBudget.jsx';
import AiWorkspaceTools from './AiWorkspaceTools';
import './AiWorkspaceLayout.css';

function WorkspaceRules({ theme }) {
  return <details className={`min-w-0 text-xs ${theme.textMuted}`}>
    <summary className="cursor-pointer">{tr('查看使用规则')}</summary>
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
  return <div className="max-h-48 space-y-1.5 overflow-y-auto pr-1">{items.map(item => <label key={item.id} className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 ${selected.includes(item.id) ? 'border-emerald-500/40 bg-emerald-500/5' : theme.input} ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}>
    <input type="checkbox" checked={selected.includes(item.id)} disabled={disabled} onChange={() => onToggle(item.id)} className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-emerald-500" />
    <span className="min-w-0"><span className="block break-words text-xs font-medium">{item.label}</span>{(item.description || item.detail) && <span className={`mt-1 block break-all text-[11px] leading-5 ${theme.textMuted}`}>{item.description || item.detail}</span>}</span>
  </label>)}</div>;
}

function applicationCheckReason(checks, availableChecks) {
  const appChecks = workspaceApplicationChecks(checks);
  if (!appChecks.length) return '';
  const labels = {
    app_package: tr('应用版本与安装状态'), app_process: tr('应用进程状态'),
    app_memory: tr('应用内存快照'), app_activity: tr('应用页面状态'),
  };
  const names = appChecks.map(id => availableChecks?.find(check => check.id === id)?.label || labels[id] || id);
  return tr('以下检查需要指定目标应用：{0}。不选应用时，可取消这些检查。', { 0: names.join(' · ') });
}

function taskDefaultDeviceLabel(target, devices) {
  if (!target.deviceId) return tr('暂不指定设备（Android 草案）');
  const model = devices.find(device => device.id === target.deviceId)?.model;
  const name = model && model !== target.deviceId ? `${model} · ${target.deviceId}` : target.deviceId;
  const label = workspaceDeviceOnline(devices, target.deviceId) ? name : tr('{0} · 已断开', { 0: name });
  return target.source === 'controls' ? tr('沿用控件设备：{0}', { 0: label }) : tr('沿用报告设备：{0}', { 0: label });
}

export default function AiWorkspace({ theme, active = true, devices = [], activeDeviceId = '', applicationContext, incomingHandoffId = '', incomingReportRef, onOpenTasks, onOpenRelatedTask, onOpenMembership, membershipActive, showToast, usageTargetRef }) {
  useLocale();
  const state = useAiWorkspace({ active, devices, activeDeviceId, applicationContext, incomingHandoffId, incomingReportRef, onOpenTasks, showToast });
  const { mode, current, sources, loading, sourceError } = state;
  const { summary: draftBudget, retry: retryBudget } = useAiMaterialBudget({ current, mode, active });
  const [toolsMounted, setToolsMounted] = useState(false);
  const toolsRef = useRef(null);
  const outputHeading = useRef(null);
  const questionRef = useRef(null);
  const modeTabs = useRef(null);
  const preparingRef = useRef(null), [adjusting, setAdjusting] = useState('');
  const preparationKey = `${current.caseId}:${current.revision}`;
  const adjustMaterials = () => {
    setAdjusting(preparationKey);
    requestAnimationFrame(() => {
      const section = preparingRef.current;
      const selection = section?.querySelector('[data-ai-material-selection] details');
      if (selection) {
        selection.closest('[data-ai-advanced-materials]').open = true;
        selection.open = true;
        selection.scrollIntoView({ block: 'nearest' });
        selection.querySelector('summary')?.focus({ preventScroll: true });
      }
    });
  };
  const editInput = () => {
    setAdjusting(preparationKey);
    requestAnimationFrame(() => {
      questionRef.current?.scrollIntoView({ block: 'center' });
      questionRef.current?.focus({ preventScroll: true });
    });
  };
  const dark = isDarkTheme(theme); const busy = Boolean(current.busy || state.reportBusy);
  const entitled = (membershipActive ?? sources.entitled) === true;
  const online = workspaceDeviceOnline(devices, current.deviceId);
  const onlineDevices = devices.filter(device => device.status === 'device');
  const availableSources = new Set((sources.sources || []).map(source => source.id));
  const staleSources = current.sourceIds.some(id => !availableSources.has(id));
  const analysisHasAlternateEvidence = mode === 'analysis' && workspaceHasAlternateEvidence(current, availableSources);
  const evidenceTextField = availableSources.size ? 'text' : 'source';
  const taskTarget = mode === 'task' ? workspaceTaskTarget(current) : null;
  const taskTargetNote = taskTarget?.source !== 'selected' && taskTarget?.deviceId.startsWith('hdc:') && !workspaceDeviceOnline(devices, taskTarget.deviceId)
    ? tr('原设备未连接。请重新连接，或移除带入的内容后重新选择。')
    : taskTarget?.source === 'controls' ? tr('控件已绑定到上述设备。要更换设备，请先移除控件。') : '';
  const input = `w-full min-w-0 rounded-lg border px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-emerald-500/25 disabled:opacity-60 ${theme.input}`;
  const button = `inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${theme.button.secondary}`;
  const primary = `inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${theme.button.primary}`;
  const modes = [
    { id: 'diagnose', title: tr('AI 排障助手'), icon: Stethoscope },
    { id: 'analysis', title: tr('AI 多源联合分析'), icon: Layers3 },
    { id: 'task', title: tr('AI 生成测试任务'), icon: ClipboardCheck },
  ];
  const busyLabel = {
    plan: tr('正在生成只读检查计划…'), collect: tr('正在本机采集并脱敏…'), analyze: tr('正在使用内置 AI 分析…'),
    generate: tr('正在生成测试任务草案…'), save: tr('正在确认并保存任务…'), cancelling: tr('正在取消…'), compare: tr('正在本机准备对比预览…'),
  }[current.busy];
  const { missing, status: readinessStatus } = workspaceReadiness(current, { devices, sources: sources.sources, loading, entitled, reportBusy: state.reportBusy });
  const blocked = Boolean(missing.length || readinessStatus);
  const canCollect = !blocked && draftBudget?.status !== 'over-limit';
  const phase = workspacePhase(current);
  const noDeviceHint = tr('暂无在线设备，请连接并授权设备后刷新。');
  const applicationLabel = current.deviceId.startsWith('hdc:') ? tr('目标应用 Bundle 名称') : tr('目标应用包名');
  const applicationReason = mode === 'diagnose' ? applicationCheckReason(current.checks, sources.checks) : '';
  const materialReason = tr('选择已有来源、带入上下文或证据篮材料，或补充文本，任选一种即可。');
  const missingFields = {
    question: [mode === 'task' ? tr('测试目标') : tr('描述你要分析的问题'), tr('先描述要分析的问题或测试目标。')],
    device: mode === 'task'
      ? [tr('任务准备设备（不会执行）'), taskTargetNote || tr('请选择在线设备；不会自动替换已选目标。')]
      : [tr('本次排障设备'), onlineDevices.length ? tr('请选择在线设备；不会自动替换已选目标。') : noDeviceHint],
    checks: [tr('只读检查项目'), tr('至少选择一项只读检查。')],
    package: [applicationLabel, applicationReason],
    source: [tr('证据材料'), materialReason],
    stale: [tr('移除不可用来源'), tr('请移除已失效的来源，再准备预览。')],
  };
  const readinessMessages = { loading: tr('正在读取可用来源，请稍候。'), membership: tr('生成任务需要现有会员权限。'), busy: tr('当前操作尚未完成，可等待或取消。') };
  const view = current.reportView;
  const output = view || current.preview || current.draft || current.savedTask;
  const previousOutput = useRef({ mode, output });
  useEffect(() => {
    const previous = previousOutput.current;
    previousOutput.current = { mode, output };
    if (!active || previous.mode !== mode || !output || previous.output === output) return;
    // Do not take keyboard focus from the outbound consent dialog.
    if (document.querySelector('dialog[open]')) return;
    if (toolsRef.current) toolsRef.current.open = false;
    const heading = outputHeading.current;
    heading?.scrollIntoView({ block: 'nearest' });
    heading?.focus({ preventScroll: true });
  }, [active, mode, output]);

  const selectMode = (id, focus = false) => {
    if (toolsRef.current) toolsRef.current.open = false;
    state.setMode(id);
    if (focus) modeTabs.current?.querySelector(`#ai-workspace-tab-${id}`)?.focus();
  };
  const moveMode = event => {
    const index = modes.findIndex(item => item.id === mode);
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
    if (!step && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next = event.key === 'Home' ? modes[0] : event.key === 'End' ? modes.at(-1) : modes[(index + step + modes.length) % modes.length];
    selectMode(next.id, true);
  };
  const budgetVisible = mode !== 'task' && (!view || current.preparing || view.report.preview.id === current.preview?.id);
  const overBudget = budgetVisible && draftBudget?.status === 'over-limit';
  const budget = budgetVisible && <AiMaterialBudget draft={draftBudget} collected={state.materialBudget} busy={busy} onAdjust={adjustMaterials} onRetry={retryBudget} theme={theme} />;
  const phaseSteps = [
    ['prepare', tr('准备材料')], ['review', tr('核对预览')], ['result', tr('查看结果')],
  ];

  const showTools = () => {
    const panel = toolsRef.current;
    if (!panel) return;
    panel.open = true;
    setToolsMounted(true);
    panel.scrollIntoView({ block: 'nearest' });
    panel.querySelector('summary')?.focus({ preventScroll: true });
  };

  return <section aria-label={tr('AI 工作区')} className={`ai-workspace-shell min-w-0 space-y-4 ${theme.text}`}>
    <div className={`space-y-3 rounded-xl border p-3 sm:p-4 ${theme.card}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={`flex min-w-0 items-center gap-1.5 text-xs ${theme.textMuted}`}>
          <ShieldCheck size={15} aria-hidden="true" className="shrink-0 text-emerald-500" />{tr('内置 AI 优先 · 先预览再发送 · 不自动执行')}
        </p>
        <div className="flex min-w-0 flex-wrap gap-2">
          <button type="button" onClick={state.refresh} disabled={loading} className={button} title={tr('只刷新本地来源与会员状态，不调用 AI')}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} />{tr('刷新来源')}</button>
          <button type="button" onClick={showTools} aria-controls="ai-workspace-tools" className={button}>{tr('报告与工具')}<ChevronDown size={14} aria-hidden="true" /></button>
        </div>
      </div>
      <div ref={modeTabs} role="tablist" aria-label={tr('AI 工作区功能')} onKeyDown={moveMode} className={`ai-workspace-mode-tabs gap-1 rounded-lg border p-1 ${theme.input}`}>
        {modes.map(item => (
          <button key={item.id} type="button" role="tab" id={`ai-workspace-tab-${item.id}`} aria-selected={mode === item.id}
            aria-controls={`ai-workspace-panel-${item.id}`} tabIndex={mode === item.id ? 0 : -1} onClick={() => selectMode(item.id)}
            className={`flex min-w-0 items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm font-medium focus-visible:outline-2 focus-visible:outline-emerald-500 ${mode === item.id ? (dark ? 'bg-emerald-500/15 text-emerald-300' : 'bg-emerald-500/12 text-emerald-800') : 'hover:bg-emerald-500/5'}`}>
            <item.icon size={17} aria-hidden="true" className="shrink-0" /><span className="min-w-0 flex-1 break-words">{item.title}</span>
            {state.cases[item.id].busy && <Loader2 size={14} aria-hidden="true" className="shrink-0 animate-spin" />}
          </button>
        ))}
      </div>
      <ol aria-label={tr('当前处理步骤')} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs">
        {phaseSteps.map(([id, label], index) => (
          <li key={id} aria-current={phase === id ? 'step' : undefined} className={`flex items-center gap-1.5 ${phase === id ? (dark ? 'font-semibold text-emerald-300' : 'font-semibold text-emerald-700') : theme.textMuted}`}>
            <span aria-hidden="true" className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ${phase === id ? 'bg-emerald-500/15' : 'bg-current/5'}`}>{index + 1}</span>{label}
          </li>
        ))}
      </ol>
    </div>
    {state.draftNotice && <div role="status" className={`flex flex-wrap items-center gap-2 rounded-lg border p-3 text-xs ${theme.card}`}><span className="min-w-0 flex-1">{tr('已恢复设备和检查选择；问题描述、日志及发送授权未保留，请重新采集后核对。')}</span><button type="button" onClick={state.dismissDraftNotice} className={button}>{tr('知道了')}</button></div>}
    {state.draftPersistenceError && <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/25 p-3 text-xs text-amber-600"><span className="min-w-0 flex-1">{tr(state.draftPersistenceError)}</span><button type="button" onClick={state.retryDraftPersistence} className={button}>{tr('重试保存选择项')}</button></div>}
    {sourceError && <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/5 px-3 py-2 text-xs text-red-500">{tr(sourceError)}</p>}
    {current.error && <p role="alert" className="break-words rounded-lg border border-red-500/25 bg-red-500/5 px-3 py-2 text-xs leading-5 text-red-500">{tr(current.error)}</p>}
    {state.reportError && <p role="alert" className="rounded-lg border border-red-500/25 p-3 text-xs text-red-500">{state.reportError}</p>}
    {state.pendingReport && <div className={`flex items-center gap-3 rounded-xl border p-3 ${theme.card}`}><p className="flex-1 text-xs">{tr('有一份报告等待查看；当前输入和进行中的操作会保留。')}</p><button type="button" disabled={busy || Object.values(state.cases).some(value => value.busy)} onClick={state.acceptPendingReport} className={button}>{tr('打开待查看报告')}</button></div>}
    {(state.pendingHandoff || state.pendingBasket) && <div className={`flex items-center gap-3 rounded-xl border p-3 ${theme.card}`}><p className="flex-1 text-xs">{state.pendingHandoff && !state.pendingHandoff.basketItem ? tr('带入新上下文会替换当前输入；已完成报告会保留。') : tr('新材料已加入本地证据篮；应用后保留问题与报告，重新核对预览。')}</p><button type="button" disabled={Boolean(state.reportBusy) || Object.values(state.cases).some(value => value.busy)} onClick={state.pendingHandoff ? state.acceptPendingHandoff : state.refreshBasket} className={button}>{tr('带入等待中的上下文')}</button></div>}
    {!entitled && !loading && <div className={`flex flex-wrap items-center gap-3 rounded-xl border p-4 ${theme.card}`}><ShieldCheck size={21} className="shrink-0 text-emerald-500" /><p className={`min-w-0 flex-1 text-xs leading-5 ${theme.textMuted}`}>{tr('AI 调用沿用本软件会员权限。请在会员中心确认激活；无需新建 AI 账号。')}</p><button type="button" onClick={() => onOpenMembership?.({ deviceId: current.deviceId, feature: tr('AI 工作区'), capability: 'ai-workspace' })} disabled={!onOpenMembership} className={button}>{tr('打开会员中心')}</button></div>}
    {current.busy && <div role="status" className={`flex items-center gap-2 rounded-lg border p-3 ${theme.card}`}><Loader2 size={16} className="shrink-0 animate-spin text-emerald-500" /><span className={`flex-1 text-xs ${theme.textMuted}`}>{busyLabel}</span>{current.busy !== 'save' && <button type="button" onClick={state.cancel} disabled={current.busy === 'cancelling'} className={button}><Square size={12} />{tr('取消')}</button>}</div>}
    <div role="tabpanel" id={`ai-workspace-panel-${mode}`} aria-labelledby={`ai-workspace-tab-${mode}`} data-ai-preparing={!output || undefined} className="ai-workspace-grid">
      <div className="min-w-0 space-y-4">
        <section ref={preparingRef} aria-labelledby="ai-workspace-input-label" className={`rounded-xl border ${theme.card}`}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-current/10 px-4 py-3">
            <h3 id="ai-workspace-input-label" className="text-sm font-semibold">{mode === 'task' ? tr('测试目标') : tr('问题与材料')}</h3>
            <div className="flex flex-wrap items-center gap-2">
              {phase !== 'prepare' && adjusting !== preparationKey && <button type="button" onClick={editInput} disabled={busy} className={button}>{tr('调整输入')}</button>}
              <button type="button" onClick={state.reset} disabled={busy} className={button} title={tr('开始新问题，保留本会话已完成分析')}><RotateCcw size={13} />{tr('新建')}</button>
            </div>
          </div>
          {phase !== 'prepare' && adjusting !== preparationKey && current.question && <p className={`line-clamp-3 break-words px-4 py-3 text-sm leading-6 ${theme.textMuted}`}>{current.question}</p>}
          <div hidden={phase !== 'prepare' && adjusting !== preparationKey} className="space-y-4 p-4">
          <label id="ai-workspace-required-question" className="block space-y-2"><span className="sr-only">{missingFields.question[0]}</span><textarea ref={questionRef} value={current.question} onChange={event => state.edit({ question: event.target.value })} disabled={busy} maxLength={4000} rows={4} className={`${input} resize-y leading-6`} placeholder={mode === 'task' ? tr('例如：等待首页出现“设置”，点击坐标 (100, 200)，截图并采集性能。请给出可核对的参数。') : tr('说明现象、复现条件和期望结果。不要填写密码、密钥或账号信息。')} /></label>
          <AiWorkspaceContext context={current.context} disabled={busy} onClear={() => state.edit({ contextRef: null, context: null, findingIndex: null })} theme={theme} />
          <AiWorkspaceHandoff handoff={current.handoff} targets={current.targets} disabled={busy} onClear={() => state.edit({ handoffId: '', handoff: null, targets: [], targetSelection: { tokens: [] } })} theme={theme} />
          {mode === 'analysis' && <AiWorkspaceHandoff basket={current.basketItems} disabled={busy} onRemove={state.removeBasketItem} onClearBasket={state.clearBasket} theme={theme} />}
          {mode === 'task' && <div id="ai-workspace-required-device" className="space-y-2"><p className="text-xs font-medium">{tr('任务准备设备（不会执行）')}</p>
            {taskTarget.source === 'controls'
              ? <p data-ai-required-input tabIndex={-1} className={`break-words rounded-lg border px-3 py-2 text-sm ${theme.input}`}>{taskDefaultDeviceLabel(taskTarget, devices)}</p>
              : <SelectMenu ariaLabel={tr('任务准备设备（不会执行）')} value={current.deviceId} disabled={busy} onChange={deviceId => state.edit({ deviceId })} isDark={dark} className="w-full" options={[
                { value: '', label: taskDefaultDeviceLabel(workspaceTaskTarget({ ...current, deviceId: '' }), devices) }, ...(current.deviceId && !online ? [{ value: current.deviceId, label: tr('{0} · 已断开', { 0: current.deviceId }) }] : []),
                ...onlineDevices.map(device => ({ value: device.id, label: `${device.model || device.id} · ${device.id}` })),
              ]} />}
            <p className={`text-xs ${theme.textMuted}`}>{taskTarget.deviceId.startsWith('hdc:') ? tr('按鸿蒙原生能力准备草案，不使用 Android 命令。') : tr('按 Android 能力准备草案，保存后仍需核对设备再执行。')}</p>
            {taskTargetNote && <p className={`text-xs leading-5 ${missing.includes('device') ? 'text-amber-700 dark:text-amber-400' : theme.textMuted}`}>{taskTargetNote}</p>}
          </div>}
          {mode === 'diagnose' && <>
            <div id="ai-workspace-required-device" className="space-y-2"><p className="text-xs font-medium">{tr('本次排障设备')}</p><SelectMenu ariaLabel={tr('本次排障设备')} value={current.deviceId} disabled={busy} onChange={deviceId => state.edit({ deviceId })} isDark={dark} className="w-full" options={[
              { value: '', label: tr('请选择在线设备') },
              ...(current.deviceId && !online ? [{ value: current.deviceId, label: tr('{0} · 已断开', { 0: current.deviceId }) }] : []),
              ...onlineDevices.map(device => ({ value: device.id, label: device.model ? `${device.model} · ${device.id}` : device.id })),
            ]} />{!onlineDevices.length && <p data-ai-required-input tabIndex={-1} className={`text-xs leading-5 ${theme.textMuted}`}>{noDeviceHint}</p>}</div>
            {current.deviceId && !online && <p className="text-xs leading-5 text-amber-600">{tr('所选设备已断开，不会自动改用其他设备。已有证据仍属于原设备。')}</p>}
            <details className={`rounded-lg border p-3 ${theme.input}`}><summary className="cursor-pointer text-xs font-medium">{tr('调整只读检查与专项排查')}</summary><div className="mt-3 space-y-3">
            <AiWorkspaceDiagnostics current={current} presets={sources.diagnosticPresets || []} onChange={state.edit} disabled={busy} online={online} device={devices.find(item => item.id === current.deviceId)} theme={theme} applicationLabel={applicationLabel} applicationReason={applicationReason} />
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-medium">{tr('只读检查项目')}</span><button type="button" onClick={state.plan} disabled={busy || !entitled || !online || !current.question.trim()} className={button}><Sparkles size={14} />{tr('AI 建议检查计划')}</button></div>
            <div id="ai-workspace-required-checks" tabIndex={-1}><SelectionCards items={sources.checks || []} selected={current.checks} onToggle={id => state.edit({ checks: toggleWorkspaceSelection(current.checks, id) })} disabled={busy} theme={theme} empty={loading ? tr('正在读取可用检查…') : tr('未读取到检查项目，请刷新来源。')} /></div>
            {current.plan && <div className="space-y-2 rounded-lg bg-emerald-500/5 p-3"><p className={`whitespace-pre-wrap break-words text-xs leading-5 ${theme.textMuted}`}>{current.plan.reason}</p><AiWorkspaceUsage usage={current.planUsage} theme={theme} /></div>}
            <p className={`text-xs leading-5 ${theme.textMuted}`}>{tr('可直接手选检查，无需先调用 AI。点击采集只执行固定读取，不修改设备或清空日志。')}</p>
            </div></details><p className={`text-xs leading-5 ${theme.textMuted}`}>{tr('本次检查：{0}', { 0: current.checks.map(id => sources.checks?.find(check => check.id === id)?.label || id).join(' · ') })}</p>
          </>}
          {mode === 'analysis' && <section id="ai-workspace-evidence-materials" aria-labelledby="ai-workspace-evidence-title" className={`space-y-3 rounded-lg border p-3 ${theme.card}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2"><h4 id="ai-workspace-evidence-title" className="text-xs font-semibold">{tr('证据材料')}</h4><span className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">{tr('至少一种')}</span></div>
                <p className={`text-xs leading-5 ${theme.textMuted}`}>{materialReason}</p>
              </div>
              {missing.includes('source') && <button type="button" aria-controls={`ai-workspace-required-${evidenceTextField}`} onClick={() => focusWorkspaceRequiredField(preparingRef.current, evidenceTextField)} className={button}>{tr('填写或粘贴文本')}</button>}
            </div>
            {current.contextRef && <p className={`text-xs leading-5 ${theme.textMuted}`}>{tr('不选择新来源时复用所选报告的冻结证据；只有主动选择的来源或补充文本会加入新预览。')}</p>}
            <div id={availableSources.size ? 'ai-workspace-required-source' : undefined} className="space-y-2"><h5 className="text-xs font-medium">{tr('选择已有证据来源')}</h5><SelectionCards items={sources.sources || []} selected={current.sourceIds} onToggle={id => state.edit({ sourceIds: toggleWorkspaceSelection(current.sourceIds, id) })} disabled={busy} theme={theme} empty={tr('暂无可用来源。可先打开日志、串口或 SSH 终端，再刷新；也可粘贴文本分析。')} /></div>
            {staleSources && <div id="ai-workspace-required-stale" className="space-y-2 rounded-lg border border-amber-500/25 p-3"><p className="text-xs text-amber-600">{tr('部分所选来源已不可用，请移除后重新采集。')}</p><button type="button" disabled={busy} onClick={() => state.edit({ sourceIds: current.sourceIds.filter(id => availableSources.has(id)) })} className={button}>{tr('移除不可用来源')}</button></div>}
            <div id={`ai-workspace-required-${evidenceTextField}`}><AiContextTextInput key={current.caseId} value={current.text} onChange={text => state.edit({ text })} disabled={busy} className={input} label={analysisHasAlternateEvidence ? tr('补充文本（可选）') : tr('补充文本')} placeholder={tr('仅粘贴本次需要分析的片段；采集后会显示脱敏预览。')} /></div>
          </section>}
          {mode === 'task' ? <details className={`rounded-lg border p-3 ${theme.input}`}>
            <summary className="cursor-pointer text-xs font-medium">{tr('补充测试参数（可选）')}</summary>
            <div className="mt-3 space-y-2">
              <AiWorkspaceRequirements requirements={current.requirements} onChange={requirements => state.edit({ requirements })} disabled={busy} theme={theme} />
              <p className={`text-xs leading-5 ${theme.textMuted}`}>{tr('支持受控的点击、滑动、输入、按键、文本校验、等待、截图和性能采样。不会生成任意 Shell 或安装、删除操作。')}</p>
            </div>
          </details> : <details key={mode} data-ai-advanced-materials className={`rounded-lg border p-3 ${theme.input}`}>
            <summary className="cursor-pointer text-xs font-medium">{tr('材料选段与预算')}</summary>
            <div className="mt-3 space-y-3">
              <div data-ai-material-selection><AiWorkspaceSelection selection={current.selection} onChange={selection => state.edit({ selection })} disabled={busy} theme={theme} /></div>
              {!overBudget && budget}
            </div>
          </details>}
          {overBudget && budget}
          </div>
        </section>
      </div>
      <div className="min-w-0 space-y-3">
        {(phase === 'prepare' || adjusting === preparationKey) && <section aria-labelledby="ai-workspace-readiness-label" className={`overflow-hidden rounded-xl border ${theme.card}`}>
          <h3 id="ai-workspace-readiness-label" className="border-b border-current/10 px-4 py-3 text-sm font-semibold">{tr('继续前检查')}</h3>
          <div className="space-y-3 p-4">
            {missing.length > 0 && <section aria-labelledby="ai-workspace-guide-title" className="space-y-2 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 id="ai-workspace-guide-title" className="flex items-center gap-1.5 text-xs font-semibold"><CircleAlert size={15} aria-hidden="true" className="text-amber-600 dark:text-amber-400" />{tr('继续前请补全')}</h4>
                <span role="status" className={`text-xs ${theme.textMuted}`}>{tr('还差 {0} 项', { 0: missing.length })}</span>
              </div>
              <ul className="divide-y divide-current/10">{missing.map(key => <li key={key} className="flex items-center gap-2 py-2 last:pb-0">
                <div className="min-w-0 flex-1"><p className="text-xs font-medium">{missingFields[key][0]}</p><p className={`mt-0.5 text-xs leading-5 ${theme.textMuted}`}>{missingFields[key][1]}</p></div>
                <button type="button" aria-label={`${tr('去补全')} · ${missingFields[key][0]}`} aria-controls={`ai-workspace-required-${key}`} onClick={() => focusWorkspaceRequiredField(preparingRef.current, key)} className={`shrink-0 whitespace-nowrap ${button}`}>{tr('去补全')}<ArrowUpRight size={13} aria-hidden="true" /></button>
              </li>)}</ul>
            </section>}
            {readinessStatus && !(readinessStatus === 'busy' && current.busy) && <p role="status" className={`text-xs leading-5 ${theme.textMuted}`}>{readinessMessages[readinessStatus]}</p>}
            {mode === 'task'
              ? <button type="button" onClick={state.generate} disabled={blocked} className={`w-full ${primary}`}><Sparkles size={15} />{tr('生成任务草案')}</button>
              : <button type="button" onClick={state.collectAndReview} disabled={!canCollect} className={`w-full ${primary}`}><Database size={15} />{tr('采集并核对发送')}</button>}
          </div>
        </section>}
        <details ref={toolsRef} id="ai-workspace-tools" onToggle={event => { if (event.currentTarget.open) setToolsMounted(true); }}
          className={`ai-workspace-section-link rounded-xl border px-4 py-3 ${theme.card}`}>
          <summary className="cursor-pointer text-xs font-medium">{tr('报告与工具')}</summary>
          {toolsMounted && <div className="mt-3 space-y-3"><AiWorkspaceTools state={state} theme={theme} /><WorkspaceRules theme={theme} /></div>}
        </details>
        {output && <h3 ref={outputHeading} tabIndex={-1} className={`ai-workspace-section-link px-1 text-xs font-medium focus:outline-none ${theme.textMuted}`}>{phase === 'review' ? tr('核对预览') : tr('查看结果')}</h3>}
        {view ? <>
          <AiWorkspaceReport key={view.report.preview.id} preview={view.report.preview} result={view.report.result} usage={view.report.usage} cached={view.cached} theme={theme} readOnly onRegression={!busy && !state.cases.task.busy ? index => state.useContext('task', index) : undefined} checks={sources.checks} onPrepareVerification={!busy && !Object.values(state.cases).some(value => value.busy) ? state.prepareVerification : undefined} actions={<AiWorkspaceNextActions state={state} theme={theme} />} />
          <AiWorkspaceReportActions key={view.reportRef.casebookId || view.reportRef.historyId || view.reportRef.turnId} view={view} state={state} theme={theme} />
          <AiWorkspaceRelated key={view.report.id} view={view} onOpen={onOpenRelatedTask} disabled={busy} theme={theme} active={active} />
        </> : current.preview && <AiWorkspaceReport key={current.preview.id} preview={current.preview} result={current.result} usage={current.usage} cached={current.cached} busy={current.busy} entitled={entitled} onAnalyze={state.analyze} theme={theme} />}
        {current.draft && <AiWorkspaceTask key={current.draft.id} draft={current.draft} editedDraft={current.draftEdits} onEditDraft={state.editDraft} busy={current.busy} onSave={state.save} usage={current.usage} theme={theme} />}
        {current.savedTask && <div role="status" className={`space-y-3 rounded-xl border border-emerald-500/30 p-4 ${theme.card}`}><p className="text-sm font-medium">{tr('测试任务已保存，尚未执行。')}</p><p className={`text-xs ${theme.textMuted}`}>{tr('可继续当前分析，或主动打开任务后核对运行。')}</p><button type="button" onClick={state.openSavedTask} disabled={busy} className={primary}>{tr('查看已保存任务')}</button></div>}
        {!output && <div className={`flex min-h-36 flex-col items-center justify-center rounded-xl border border-dashed px-5 py-6 text-center ${theme.card}`}><FileSearch size={25} aria-hidden="true" className="mb-2 text-emerald-500/65" /><h3 className="text-sm font-medium">{mode === 'task' ? tr('先生成，再审阅，最后保存') : tr('先看证据，再让 AI 分析')}</h3><p className={`mt-1 max-w-sm text-xs leading-5 ${theme.textMuted}`}>{mode === 'task' ? tr('草案将逐步展示操作和参数。保存到任务中心后，你仍可以编辑并决定何时运行。') : tr('采集后会在这里显示完整发送预览。不同工作区与目标相互独立，切换页面不会丢失本次内容。')}</p></div>}
        <div ref={usageTargetRef} className="empty:hidden" />
      </div>
    </div>
  </section>;
}
