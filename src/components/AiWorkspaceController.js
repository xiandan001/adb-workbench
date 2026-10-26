import { useCallback, useEffect, useRef, useState } from 'react';
import { tr, useLocale } from '../shared/i18n';
import { AI_WORKSPACE_MODES, createWorkspaceCase, editWorkspaceCase, workspaceRequestCurrent } from './AiWorkspaceState';

const newCase = (mode, deviceId = '') => createWorkspaceCase(mode, deviceId, crypto.randomUUID());
const api = () => window.electronAPI;

export default function useAiWorkspace({ active, activeDeviceId, onOpenTasks, showToast }) {
  const locale = useLocale();
  const [mode, setMode] = useState('diagnose');
  const [cases, setCases] = useState(() => Object.fromEntries(AI_WORKSPACE_MODES.map(item => [item, newCase(item, activeDeviceId)])));
  const [sources, setSources] = useState({ sources: [], checks: [], entitled: false });
  const [loading, setLoading] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const casesRef = useRef(cases); const alive = useRef(true); const refreshTicket = useRef(0);
  const update = useCallback((key, change) => {
    const next = { ...casesRef.current, [key]: change(casesRef.current[key]) };
    casesRef.current = next;
    if (alive.current) setCases(next);
  }, []);

  const refresh = useCallback(async () => {
    const ticket = ++refreshTicket.current;
    setLoading(true); setSourceError('');
    try {
      const result = await api()?.aiWorkspaceSources?.();
      if (!result?.ok) throw new Error(result?.error || tr('无法读取 AI 工作区状态，请刷新后重试。'));
      if (alive.current && ticket === refreshTicket.current) setSources(result);
    } catch (error) {
      if (alive.current && ticket === refreshTicket.current) setSourceError(error.message);
    } finally { if (alive.current && ticket === refreshTicket.current) setLoading(false); }
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const value of Object.values(casesRef.current)) void api()?.aiWorkspaceClose?.({ caseId: value.caseId }).catch(() => {});
    };
  }, []);
  useEffect(() => { if (active) void refresh(); }, [active, locale, refresh]);

  const run = async (operation, invoke, accept) => {
    const key = mode; const current = casesRef.current[key];
    if (current.busy) return;
    const token = { caseId: current.caseId, revision: current.revision, operation };
    update(key, value => ({ ...value, busy: operation, error: '',
      ...(['collect', 'plan'].includes(operation) ? { preview: null, result: null, usage: null } : {}),
      ...(operation === 'generate' ? { draft: null, usage: null } : {}),
    }));
    const isCurrent = () => alive.current && workspaceRequestCurrent(casesRef.current[key], token);
    try {
      const response = await invoke(current);
      if (!isCurrent()) return;
      if (response?.cancelled || response?.code === 'CANCELLED') return;
      if (!response?.ok) throw new Error(response?.error || tr('操作未完成，请重试。'));
      update(key, value => ({ ...value, ...accept(response), error: '' }));
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
  const reset = () => {
    const current = casesRef.current[mode];
    if (current.busy) return;
    void api()?.aiWorkspaceClose?.({ caseId: current.caseId }).catch(() => {});
    update(mode, () => newCase(mode, current.deviceId));
  };
  const plan = () => run('plan', value => api().aiWorkspacePlan({ caseId: value.caseId, question: value.question, deviceId: value.deviceId }), response => ({
    plan: response.plan, checks: response.plan.checks, preview: null, result: null, planUsage: response.usage, usage: null, cached: false,
  }));
  const collect = () => run('collect', value => api().aiWorkspaceCollect({ caseId: value.caseId, mode, deviceId: mode === 'diagnose' ? value.deviceId : '',
    checks: mode === 'diagnose' ? value.checks : [], sourceIds: mode === 'analysis' ? value.sourceIds : [], text: mode === 'analysis' ? value.text : '', question: value.question,
  }), response => ({ preview: response.preview, result: null, usage: null, cached: false }));
  const analyze = () => run('analyze', value => api().aiWorkspaceAnalyze({ caseId: value.caseId, previewId: value.preview.id, consent: true }), response => ({
    result: response.result, usage: response.usage, cached: response.cached === true,
  }));
  const generate = () => run('generate', value => api().aiWorkspaceGenerateTask({ caseId: value.caseId, goal: value.question }), response => ({ draft: response.draft, usage: response.usage }));
  const save = () => run('save', value => api().aiWorkspaceSaveTask({ caseId: value.caseId, draftId: value.draft.id }), () => ({ draft: null }));
  return { mode, setMode, cases, current: cases[mode], sources, loading, sourceError, refresh, edit, cancel, reset, plan, collect, analyze, generate, save };
}
