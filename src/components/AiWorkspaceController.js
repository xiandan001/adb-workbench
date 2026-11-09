import { useCallback, useEffect, useRef, useState } from 'react';
import { tr, useLocale } from '../shared/i18n';
import { AI_WORKSPACE_MODES, completeWorkspaceTurn, createWorkspaceCase, editWorkspaceCase, prepareWorkspaceContext, prepareWorkspaceHandoff, workspaceReportRef, workspaceRequestCurrent } from './AiWorkspaceState';
import { adoptWorkspaceDefaults, normalizeWorkspaceReportRequest, prepareWorkspaceVerification } from './AiWorkspaceFlow';

const newCase = (mode, deviceId = '') => createWorkspaceCase(mode, deviceId, crypto.randomUUID());
const api = () => window.electronAPI;

export default function useAiWorkspace({ active, devices = [], activeDeviceId, incomingHandoffId, incomingReportRef, onOpenTasks, showToast }) {
  const locale = useLocale();
  const [mode, setMode] = useState('diagnose');
  const [cases, setCases] = useState(() => Object.fromEntries(AI_WORKSPACE_MODES.map(item => [item, newCase(item, activeDeviceId)])));
  const [sources, setSources] = useState({ sources: [], checks: [], entitled: false });
  const [loading, setLoading] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const [history, setHistory] = useState([]);
  const [casebook, setCasebook] = useState([]);
  const [pendingHandoff, setPendingHandoff] = useState(null);
  const [pendingReport, setPendingReport] = useState(null);
  const [reportBusy, setReportBusy] = useState('');
  const [reportError, setReportError] = useState('');
  const casesRef = useRef(cases); const alive = useRef(true); const refreshTicket = useRef(0); const reportLock = useRef(false);
  const incomingHandled = useRef('');
  const reportRequestHandled = useRef('');
  const update = useCallback((key, change) => {
    const next = { ...casesRef.current, [key]: change(casesRef.current[key]) };
    casesRef.current = next;
    if (alive.current) setCases(next);
  }, []);

  useEffect(() => {
    if (reportLock.current) return;
    for (const key of AI_WORKSPACE_MODES) {
      const current = casesRef.current[key], next = adoptWorkspaceDefaults(current, devices, activeDeviceId);
      if (next !== current) update(key, () => next);
    }
  }, [devices, activeDeviceId, update]);

  const openRequestedReport = useCallback(async request => {
    const ref = normalizeWorkspaceReportRequest(request);
    if (!ref) { setReportError(tr('分析报告引用无效。')); return; }
    if (reportLock.current || Object.values(casesRef.current).some(value => value.busy)) { setPendingReport(request); return; }
    const key = ref.caseId ? AI_WORKSPACE_MODES.find(mode => casesRef.current[mode].caseId === ref.caseId) : 'analysis';
    if (!key) { setReportError(tr('原分析已不在当前会话中，请打开已保存的历史或案例。')); return; }
    const token = { caseId: casesRef.current[key].caseId, revision: casesRef.current[key].revision };
    reportLock.current = true; setReportBusy('load'); setReportError(''); setPendingReport(null);
    try {
      let report;
      if (ref.historyId || ref.casebookId) {
        const response = ref.historyId ? await api().aiWorkspaceHistoryLoad({ id: ref.historyId }) : await api().aiWorkspaceCasebookLoad({ id: ref.casebookId });
        if (!response?.ok) throw new Error(response?.error || tr('报告操作未完成，请重试。'));
        report = response.report;
      } else report = casesRef.current[key].turns.find(turn => turn.id === ref.turnId);
      if (!report) throw new Error(tr('原分析已不在当前会话中，请打开已保存的历史或案例。'));
      const current = casesRef.current[key];
      if (alive.current && current.caseId === token.caseId && current.revision === token.revision && !current.busy) {
        update(key, value => ({ ...value, preparing: false, reportView: { report, reportRef: ref } })); setMode(key);
      }
    } catch (error) { if (alive.current) setReportError(error.message); }
    finally { reportLock.current = false; if (alive.current) setReportBusy(''); }
  }, [update]);
  useEffect(() => {
    if (!incomingReportRef?.requestId || reportRequestHandled.current === incomingReportRef.requestId) return;
    reportRequestHandled.current = incomingReportRef.requestId;
    void openRequestedReport(incomingReportRef);
  }, [incomingReportRef, openRequestedReport]);

  const refreshHistory = useCallback(async () => {
    const result = await api()?.aiWorkspaceHistoryList?.();
    if (!result?.ok) throw new Error(result?.error || tr('无法读取本地分析历史。'));
    if (alive.current) setHistory(result.items || []);
    const stored = await api()?.aiWorkspaceCasebookList?.({});
    if (stored?.ok && alive.current) setCasebook(stored.items || []);
  }, []);
  const sourceDeviceId = cases[mode].deviceId;
  const refresh = useCallback(async () => {
    const ticket = ++refreshTicket.current;
    setLoading(true); setSourceError('');
    try {
      const result = await api()?.aiWorkspaceSources?.({ deviceId: sourceDeviceId });
      if (!result?.ok) throw new Error(result?.error || tr('无法读取 AI 工作区状态，请刷新后重试。'));
      if (alive.current && ticket === refreshTicket.current) setSources(result);
      await refreshHistory();
    } catch (error) {
      if (alive.current && ticket === refreshTicket.current) setSourceError(error.message);
    } finally { if (alive.current && ticket === refreshTicket.current) setLoading(false); }
  }, [refreshHistory, sourceDeviceId]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const value of Object.values(casesRef.current)) void api()?.aiWorkspaceClose?.({ caseId: value.caseId }).catch(() => {});
    };
  }, []);
  useEffect(() => { if (active) void refresh(); }, [active, locale, refresh]);
  const acceptHandoff = useCallback((metadata, force = false) => {
    const targets = metadata.taskTargets || [];
    const key = targets.length ? 'task' : 'analysis';
    const current = casesRef.current[key];
    if (current.busy || reportLock.current || (!force && (current.question.trim() || current.draft))) { setPendingHandoff(metadata); return; }
    update(key, value => prepareWorkspaceHandoff(value, metadata));
    setPendingHandoff(null); setMode(key);
  }, [update]);
  useEffect(() => {
    if (!incomingHandoffId || incomingHandled.current === incomingHandoffId) return;
    let valid = true;
    void api()?.aiHandoffGet?.({ handoffId: incomingHandoffId }).then(response => {
      if (!valid || !alive.current) return;
      if (!response?.ok) throw new Error(response?.error || tr('所选上下文已过期，请重新带入。'));
      incomingHandled.current = incomingHandoffId;
      acceptHandoff(response.handoff);
    }).catch(error => { if (valid && alive.current) setSourceError(error.message); });
    return () => { valid = false; };
  }, [incomingHandoffId, acceptHandoff]);

  const run = async (operation, invoke, accept) => {
    const key = mode; const current = casesRef.current[key];
    if (current.busy || reportLock.current) return;
    const token = { caseId: current.caseId, revision: current.revision, operation };
    update(key, value => ({ ...value, busy: operation, error: '',
      ...(['collect', 'compare'].includes(operation) ? { preview: null, result: null, usage: null, reportView: null } : {}),
      ...(operation === 'generate' ? { draft: null, usage: null } : {}),
    }));
    const isCurrent = () => alive.current && workspaceRequestCurrent(casesRef.current[key], token);
    try {
      const response = await invoke(current);
      if (!isCurrent() || response?.cancelled || response?.code === 'CANCELLED') return;
      if (!response?.ok) throw new Error(response?.error || tr('操作未完成，请重试。'));
      update(key, value => ({ ...accept(value, response), error: '' }));
      if (operation === 'save' && response.script?.id) {
        showToast?.(tr('测试任务已保存，尚未执行。'));
        onOpenTasks?.(response.script.id);
      }
    } catch (error) {
      if (isCurrent()) update(key, value => ({ ...value, error: error.message || tr('操作未完成，请重试。') }));
    } finally {
      if (isCurrent()) update(key, value => ({ ...value, busy: '' }));
    }
  };
  const edit = changes => update(mode, current => editWorkspaceCase(current, changes));
  const cancel = async () => {
    const key = mode; const current = casesRef.current[key];
    if (!current.busy || current.busy === 'cancelling') return;
    update(key, value => ({ ...value, revision: value.revision + 1, busy: 'cancelling', error: '' }));
    try {
      const response = await api()?.aiWorkspaceCancel?.({ caseId: current.caseId });
      if (alive.current && casesRef.current[key].caseId === current.caseId && response?.ok === false) {
        update(key, value => ({ ...value, error: response.error || tr('取消未完成，请稍后重试。') }));
      }
    } catch {
      if (alive.current && casesRef.current[key].caseId === current.caseId) update(key, value => ({ ...value, error: tr('取消未完成，请稍后重试。') }));
    } finally {
      if (alive.current && casesRef.current[key].caseId === current.caseId) update(key, value => ({ ...value, busy: '' }));
    }
  };
  const reset = () => update(mode, current => current.busy ? current : {
    ...adoptWorkspaceDefaults(createWorkspaceCase(mode, current.deviceId, current.caseId), devices, activeDeviceId), revision: current.revision + 1,
    turns: current.turns,
  });
  const plan = () => run('plan', value => api().aiWorkspacePlan({ caseId: value.caseId, question: value.question, deviceId: value.deviceId, diagnostic: value.diagnostic }), (value, response) => ({
    ...value, plan: response.plan, checks: response.plan.checks, preview: null, result: null, planUsage: response.usage, usage: null, cached: false,
  }));
  const collect = () => run('collect', value => api().aiWorkspaceCollect({ caseId: value.caseId, mode, deviceId: mode === 'diagnose' ? value.deviceId : '',
    checks: mode === 'diagnose' ? value.checks : [], sourceIds: mode === 'analysis' ? value.sourceIds : [], text: mode === 'analysis' ? value.text : '',
    question: value.question, ...(!value.contextRef || value.selectionChanged ? { selection: value.selection } : {}),
    ...(value.contextRef ? { contextRef: value.contextRef } : {}),
    ...(mode === 'diagnose' ? { diagnostic: value.diagnostic } : {}), ...(value.handoffId ? { handoffId: value.handoffId } : {}),
  }), (value, response) => ({ ...value, preparing: false, preview: response.preview, result: null, usage: null, cached: false }));
  const analyze = () => run('analyze', value => api().aiWorkspaceAnalyze({ caseId: value.caseId, previewId: value.preview.id, consent: true }), completeWorkspaceTurn);
  const generate = () => run('generate', value => api().aiWorkspaceGenerateTask({ caseId: value.caseId, deviceId: value.deviceId, goal: value.question, requirements: value.requirements,
    ...(value.contextRef ? { contextRef: value.contextRef } : {}), ...(Number.isInteger(value.findingIndex) ? { findingIndex: value.findingIndex } : {}),
    ...(value.targetSelection.tokens.length ? { targetSelection: value.targetSelection } : {}), ...(value.handoffId ? { handoffId: value.handoffId } : {}),
  }), (value, response) => ({ ...value, preparing: false, draft: response.draft, usage: response.usage }));
  const save = () => run('save', value => api().aiWorkspaceSaveTask({ caseId: value.caseId, draftId: value.draft.id }), value => ({ ...value, draft: null }));
  const compare = () => run('compare', value => api().aiWorkspaceComparisonPreview({ caseId: value.caseId,
    beforeRef: workspaceReportRef(value.baseline), afterRef: value.reportView?.reportRef || { caseId: value.caseId, previewId: value.preview?.id },
  }), (value, response) => ({ ...value, preparing: false, preview: response.preview, result: null, usage: null, cached: false }));
  const selectTurn = id => update(mode, current => {
    const report = current.turns.find(turn => turn.id === id);
    return report && !current.busy ? { ...current, preparing: false, reportView: { report, reportRef: { caseId: current.caseId, turnId: id } } } : current;
  });
  const useContext = (kind, findingIndex = null) => {
    const view = casesRef.current[mode].reportView;
    const target = kind === 'task' ? 'task' : 'analysis';
    if (!view || casesRef.current[target].busy) return;
    update(target, current => prepareWorkspaceContext(current, view, kind, findingIndex));
    setMode(target);
    showToast?.(tr('已带入上下文，请补充目标后手动继续；尚未调用 AI。'));
  };
  const prepareVerification = index => {
    if (reportLock.current || Object.values(casesRef.current).some(value => value.busy)) return;
    const view = casesRef.current[mode].reportView;
    const prepared = prepareWorkspaceVerification(casesRef.current.diagnose, view, view?.report.result.verificationChecks?.[index], sources.checks);
    if (prepared.reason) {
      setReportError(prepared.reason === 'package' ? tr('专项检查需要明确选择应用包名。') : tr('无法准备此验证，请重新选择有效的检查建议。')); return;
    }
    setReportError(''); update('diagnose', () => prepared.state); setMode('diagnose');
    showToast?.(tr('验证检查已准备，请核对后采集；尚未读取设备或发送 AI。'));
  };
  const reportAction = async (operation, action) => {
    if (reportLock.current || Object.values(casesRef.current).some(value => value.busy)) return;
    reportLock.current = true; setReportBusy(operation); setReportError('');
    try { await action(); }
    catch (error) { if (alive.current) setReportError(error.message || tr('报告操作未完成，请重试。')); }
    finally { reportLock.current = false; if (alive.current) setReportBusy(''); }
  };
  const checked = response => {
    if (!response?.ok) throw new Error(response?.error || tr('报告操作未完成，请重试。'));
    return response;
  };
  const loadHistory = id => {
    const key = mode;
    const token = { caseId: casesRef.current[key].caseId, revision: casesRef.current[key].revision };
    return reportAction('load', async () => {
      const response = checked(await api().aiWorkspaceHistoryLoad({ id }));
      if (alive.current) update(key, current => current.caseId === token.caseId && current.revision === token.revision && !current.busy
        ? { ...current, preparing: false, reportView: { report: response.report, reportRef: { historyId: id } } } : current);
    });
  };
  const saveReport = name => {
    const ref = casesRef.current[mode].reportView?.reportRef;
    if (!ref?.turnId) return;
    return reportAction('save', async () => {
      checked(await api().aiWorkspaceHistorySave({ ...ref, name })); await refreshHistory();
      showToast?.(tr('脱敏报告已保存到本地历史。'));
    });
  };
  const deleteHistory = id => reportAction('delete', async () => {
    const response = checked(await api().aiWorkspaceHistoryDelete({ id }));
    if (!response.cancelled) {
      await refreshHistory();
      for (const key of AI_WORKSPACE_MODES) update(key, value => ({ ...value,
        ...(value.reportView?.reportRef.historyId === id ? { reportView: null } : {}),
        ...(value.contextRef?.historyId === id ? { contextRef: null, context: null, findingIndex: null } : {}),
        ...(value.baseline === `history:${id}` ? { baseline: '' } : {}),
      }));
    }
  });
  const exportReport = (copy = false) => {
    const reportRef = casesRef.current[mode].reportView?.reportRef;
    if (!reportRef) return;
    return reportAction(copy ? 'copy' : 'export', async () => {
      if (copy) {
        const response = checked(await api().aiWorkspaceReportText({ reportRef }));
        await navigator.clipboard.writeText(response.text); showToast?.(tr('已复制脱敏报告。'));
      } else {
        const response = checked(await api().aiWorkspaceHistoryExport({ reportRef }));
        if (!response.cancelled) showToast?.(tr('脱敏报告已导出。'));
      }
    });
  };
  const searchCasebook = filters => reportAction('casebook', async () => {
    const response = checked(await api().aiWorkspaceCasebookList(filters)); if (alive.current) setCasebook(response.items || []);
  });
  const similarCases = () => {
    const reportRef = casesRef.current[mode].reportView?.reportRef; if (!reportRef) return;
    return reportAction('casebook', async () => { const response = checked(await api().aiWorkspaceCasebookSimilar({ reportRef, limit: 5 })); if (alive.current) setCasebook(response.items || []); });
  };
  const loadCase = id => {
    const key = mode, revision = casesRef.current[key].revision;
    return reportAction('casebook', async () => {
      const response = checked(await api().aiWorkspaceCasebookLoad({ id }));
      if (alive.current) update(key, current => current.revision === revision && !current.busy ? { ...current, preparing: false, reportView: { report: response.report, reportRef: { casebookId: id } } } : current);
    });
  };
  const saveCase = (name, review) => {
    const view = casesRef.current[mode].reportView; if (!view) return;
    return reportAction('casebook', async () => {
      if (view.reportRef.casebookId) {
        checked(await api().aiWorkspaceCasebookUpdate({ id: view.reportRef.casebookId, revision: view.report.revision, review }));
        const response = checked(await api().aiWorkspaceCasebookLoad({ id: view.reportRef.casebookId }));
        update(mode, current => ({ ...current, reportView: { report: response.report, reportRef: view.reportRef } }));
      } else checked(await api().aiWorkspaceCasebookSave({ reportRef: view.reportRef, name, review }));
      await refreshHistory(); showToast?.(tr('案例已保存；验证状态由你确认，不会自动调用 AI。'));
    });
  };
  const deleteCase = id => reportAction('casebook', async () => {
    const response = checked(await api().aiWorkspaceCasebookDelete({ id }));
    if (!response.cancelled) {
      await refreshHistory();
      for (const key of AI_WORKSPACE_MODES) update(key, value => ({ ...value,
        ...(value.reportView?.reportRef.casebookId === id ? { reportView: null } : {}),
        ...(value.contextRef?.casebookId === id ? { contextRef: null, context: null, findingIndex: null } : {}),
        ...(value.baseline === `casebook:${id}` ? { baseline: '' } : {}),
      }));
    }
  });
  return { mode, setMode, cases, current: cases[mode], sources, loading, sourceError, refresh, edit, cancel, reset, plan, collect, analyze, generate, save,
    history, reportBusy, reportError, selectTurn, loadHistory, saveReport, deleteHistory, exportReport, useContext, compare, prepareVerification,
    casebook, searchCasebook, similarCases, loadCase, saveCase, deleteCase, pendingHandoff,
    acceptPendingHandoff: () => pendingHandoff && acceptHandoff(pendingHandoff, true),
    pendingReport, acceptPendingReport: () => pendingReport && openRequestedReport(pendingReport), openRequestedReport,
    setBaseline: baseline => update(mode, value => ({ ...value, baseline })),
    showPreview: () => update(mode, value => ({ ...value, reportView: null })),
  };
}
