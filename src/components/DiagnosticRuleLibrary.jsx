import { tr, useLocale } from '../shared/i18n';
import { isDarkTheme } from '../shared/theme';
// 日志诊断规则库面板：管理内置规则与会员自定义规则。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Clipboard, Download, Edit3, Lock, Plus, RefreshCw, RotateCcw, Save, SearchCheck, Trash2, Upload, X } from 'lucide-react';
import DangerConfirmModal from './DangerConfirmModal';
import SelectMenu from './SelectMenu';
import { isConfirmSuppressed, rememberConfirmSuppressed } from '../shared/confirmMemory';

const EMPTY_RULE = {
  id: '',
  label: '',
  type: 'custom',
  severity: 'error',
  pattern: '',
  flags: 'i',
  keywords: '',
  description: '',
  enabled: true
};

function DiagnosticRuleLibrary({ theme, open, onClose, isVip, onVipRequired }) {
  const locale = useLocale();
  const t = theme || { primary: 'tech' };
  const isDark = isDarkTheme(t);
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editingRule, setEditingRule] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testLine, setTestLine] = useState('');
  const [testResult, setTestResult] = useState(null);
  const [transferText, setTransferText] = useState('');
  const [error, setError] = useState('');
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [confirmLoading, setConfirmLoading] = useState(false);

  const sortedRules = useMemo(() => {
    void locale;
    return [...rules].sort((a, b) => Number(a.builtIn) - Number(b.builtIn) || a.label.localeCompare(b.label));
  }, [rules, locale]);

  const loadRules = useCallback(async () => {
    if (!window.electronAPI?.autoDiagnoseRulesList) return;
    setLoading(true);
    setError('');
    try {
      const res = await window.electronAPI.autoDiagnoseRulesList();
      if (res.ok) setRules(res.rules || []);
      else setError(res.error || tr("规则读取失败"));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) loadRules();
  }, [open, loadRules]);

  if (!open) return null;

  const saveRule = async (rule) => {
    if (!rule.builtIn && !isVip) {
      onVipRequired?.(tr("自定义诊断规则"));
      return;
    }
    setSaving(true);
    setError('');
    try {
      const payload = {
        ...rule,
        id: rule.id || `custom-${Date.now()}`,
        keywords: Array.isArray(rule.keywords) ? rule.keywords : String(rule.keywords || '').split(/[,，\n]/).map(item => item.trim()).filter(Boolean)
      };
      const res = await window.electronAPI.autoDiagnoseRulesSave({ rule: payload });
      if (res.ok) {
        setRules(res.rules || []);
        setEditingRule(null);
      } else {
        setError(res.error || tr("保存失败"));
        if (res.code === 'vip_required') onVipRequired?.(tr("自定义诊断规则"));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const deleteRule = async (rule) => {
    if (!isVip) {
      onVipRequired?.(tr("删除自定义规则"));
      return;
    }
    openConfirmDialog({
      title: tr("删除诊断规则"),
      message: tr("确定删除「{0}」吗？", { 0: rule.label }),
      detail: tr("删除后该规则不会再参与自动诊断；如需恢复，只能重新创建或导入规则备份。"),
      confirmLabel: tr("删除规则"),
      rememberKey: 'diagnosticRule.delete',
      onConfirm: async () => {
        setSaving(true);
        try {
          const res = await window.electronAPI.autoDiagnoseRulesDelete({ id: rule.id });
          if (res.ok) setRules(res.rules || []);
          else setError(res.error || tr("删除失败"));
        } catch (err) {
          setError(err.message);
        } finally {
          setSaving(false);
        }
      }
    });
  };

  const resetRules = async () => {
    openConfirmDialog({
      title: tr("重置诊断规则"),
      message: tr("确定恢复默认诊断规则吗？"),
      detail: tr("重置会覆盖当前规则配置。建议先导出备份，再执行重置。"),
      confirmLabel: tr("重置规则"),
      rememberKey: 'diagnosticRule.reset',
      onConfirm: async () => {
        setSaving(true);
        try {
          const res = await window.electronAPI.autoDiagnoseRulesReset();
          if (res.ok) {
            setRules(res.rules || []);
            setEditingRule(null);
          } else {
            setError(res.error || tr("重置失败"));
          }
        } catch (err) {
          setError(err.message);
        } finally {
          setSaving(false);
        }
      }
    });
  };

  const openConfirmDialog = (dialog) => {
    const next = {
      ...dialog,
      rememberChoice: false,
      rememberLabel: dialog.rememberLabel || tr("下次不再提示")
    };
    if (next.rememberKey && isConfirmSuppressed(next.rememberKey)) {
      Promise.resolve()
        .then(() => next.onConfirm?.())
        .catch((err) => setError(err?.message || tr("操作失败")));
      return;
    }
    setConfirmDialog(next);
  };

  const runConfirmDialog = async () => {
    if (!confirmDialog?.onConfirm) return;
    setConfirmLoading(true);
    try {
      const result = await confirmDialog.onConfirm();
      if (result !== false) {
        if (confirmDialog.rememberKey && confirmDialog.rememberChoice) {
          rememberConfirmSuppressed(confirmDialog.rememberKey);
        }
        setConfirmDialog(null);
      }
    } finally {
      setConfirmLoading(false);
    }
  };

  const testRules = async (rule = null) => {
    setTestResult(null);
    setError('');
    try {
      const res = await window.electronAPI.autoDiagnoseRulesTest({ line: testLine, rule });
      if (res.ok) setTestResult(res);
      else setError(res.error || tr("测试失败"));
    } catch (err) {
      setError(err.message);
    }
  };

  const exportRules = async () => {
    if (!isVip) {
      onVipRequired?.(tr("导出诊断规则"));
      return;
    }
    const res = await window.electronAPI.autoDiagnoseRulesExport();
    if (res.ok) setTransferText(JSON.stringify({ rules: res.rules }, null, 2));
    else setError(res.error || tr("导出失败"));
  };

  const importRules = async () => {
    if (!isVip) {
      onVipRequired?.(tr("导入诊断规则"));
      return;
    }
    try {
      const parsed = JSON.parse(transferText);
      const res = await window.electronAPI.autoDiagnoseRulesImport({ rules: parsed.rules || parsed });
      if (res.ok) {
        setRules(res.rules || []);
        setTransferText('');
      } else {
        setError(res.error || tr("导入失败"));
      }
    } catch (err) {
      setError(tr("导入失败：{0}", { 0: err.message }));
    }
  };

  const panelBg = isDark ? 'bg-[#202124] border-[#3E4145]' : 'bg-white border-slate-200';
  const muted = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';

  return (
    <>
    <DangerConfirmModal
      open={!!confirmDialog}
      theme={theme}
      title={confirmDialog?.title}
      message={confirmDialog?.message}
      detail={confirmDialog?.detail}
      confirmLabel={confirmDialog?.confirmLabel || tr("确定")}
      loading={confirmLoading}
      rememberChoice={!!confirmDialog?.rememberChoice}
      rememberLabel={confirmDialog?.rememberLabel || tr("下次不再提示")}
      onRememberChoiceChange={confirmDialog?.rememberKey ? (checked) => {
        setConfirmDialog(prev => prev ? { ...prev, rememberChoice: checked } : prev);
      } : undefined}
      onCancel={() => setConfirmDialog(null)}
      onConfirm={runConfirmDialog}
    />
    <div className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className={`w-full max-w-6xl max-h-[90vh] overflow-hidden rounded-xl border shadow-2xl ${panelBg}`} onClick={(e) => e.stopPropagation()}>
        <div className={`px-5 py-4 border-b flex items-center justify-between ${isDark ? 'border-[#3E4145]' : 'border-slate-100'}`}>
          <div>
            <h3 className={`text-lg font-semibold ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>{tr("诊断规则库")}</h3>
            <div className={`text-xs mt-1 ${muted}`}>{tr("{0}/{1} 启用", { 0: rules.filter(rule => rule.enabled).length, 1: rules.length })}</div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setEditingRule({ ...EMPTY_RULE })} className={`px-3 py-2 rounded-lg text-sm flex items-center gap-1.5 ${isVip ? 'bg-emerald-500 text-white hover:bg-emerald-600' : 'bg-amber-500/15 text-amber-400 border border-amber-500/20'}`}>
              {isVip ? <Plus size={15} /> : <Lock size={15} />}{tr("新建")}</button>
            <button onClick={resetRules} disabled={saving} className={`px-3 py-2 rounded-lg border text-sm flex items-center gap-1.5 ${isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-100'}`}>
              <RotateCcw size={15} />{tr("重置")}</button>
            <button onClick={onClose} className={`p-2 rounded-lg ${isDark ? 'text-[#9AA0A6] hover:bg-[#3E4145]' : 'text-slate-500 hover:bg-slate-100'}`}>
              <X size={18} />
            </button>
          </div>
        </div>

        {error && <div className="mx-5 mt-4 px-3 py-2 rounded-lg text-xs bg-red-500/10 text-red-400 border border-red-500/20">{tr(error)}</div>}

        <div className="grid lg:grid-cols-[minmax(0,1fr)_360px] max-h-[calc(90vh-74px)] overflow-hidden">
          <div className="overflow-y-auto p-5 space-y-3">
            {loading ? (
              <div className={`py-16 text-center text-sm ${muted}`}><RefreshCw size={18} className="inline animate-spin mr-2" />{tr("加载中...")}</div>
            ) : sortedRules.map(rule => (
              <div key={rule.id} className={`p-5 rounded-lg border ${isDark ? 'bg-[#2D2F33] border-[#3E4145]' : 'bg-slate-50 border-slate-200'}`}>
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <button
                        onClick={() => saveRule({ ...rule, enabled: !rule.enabled })}
                        disabled={saving}
                        aria-pressed={rule.enabled}
                        className={`relative inline-flex h-6 w-11 flex-none items-center rounded-full p-0.5 transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400/40 disabled:opacity-60 ${rule.enabled ? 'bg-emerald-500' : isDark ? 'bg-[#5F6368]' : 'bg-slate-300'}`}
                        title={rule.enabled ? tr("关闭规则") : tr("启用规则")}
                      >
                        <span className={`h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${rule.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                      </button>
                      <span className={`text-base font-semibold ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>{rule.label}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${rule.builtIn ? 'bg-blue-500/10 text-blue-400' : 'bg-amber-500/10 text-amber-400'}`}>{rule.builtIn ? tr("内置") : tr("自定义")}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${rule.severity === 'fatal' ? 'bg-red-500/15 text-red-400' : rule.severity === 'error' ? 'bg-orange-500/15 text-orange-400' : 'bg-slate-500/15 text-slate-400'}`}>{rule.severity}</span>
                    </div>
                    <div className={`mt-3 text-xs font-mono break-all leading-relaxed ${muted}`}>{rule.pattern}</div>
                    {rule.keywords?.length > 0 && <div className={`mt-2 text-xs leading-relaxed ${muted}`}>{rule.keywords.join(' / ')}</div>}
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => testRules(rule)} className={`p-2 rounded-lg ${isDark ? 'text-[#9AA0A6] hover:bg-[#3E4145]' : 'text-slate-500 hover:bg-white'}`} title={tr("测试")}>
                      <SearchCheck size={15} />
                    </button>
                    <button onClick={() => setEditingRule({ ...rule, keywords: (rule.keywords || []).join(', ') })} className={`p-2 rounded-lg ${isDark ? 'text-[#9AA0A6] hover:bg-[#3E4145]' : 'text-slate-500 hover:bg-white'}`} title={tr("编辑")}>
                      <Edit3 size={15} />
                    </button>
                    {!rule.builtIn && (
                      <button onClick={() => deleteRule(rule)} className="p-2 rounded-lg text-red-400 hover:bg-red-500/10" title={tr("删除")}>
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className={`border-l p-5 overflow-y-auto space-y-5 ${isDark ? 'border-[#3E4145]' : 'border-slate-100'}`}>
            <div>
              <label className={`text-xs font-medium ${muted}`}>{tr("测试日志")}</label>
              <textarea value={testLine} onChange={(e) => setTestLine(e.target.value)} rows={4} className={`mt-2 w-full px-3 py-2 rounded-lg border text-xs font-mono resize-none ${isDark ? 'bg-[#2D2F33] border-[#5F6368] text-[#E8EAED]' : 'bg-slate-50 border-slate-200 text-slate-700'}`} />
              <button onClick={() => testRules(null)} className="mt-2 px-3 py-2 rounded-lg text-sm bg-emerald-500 text-white hover:bg-emerald-600 flex items-center gap-1.5">
                <SearchCheck size={15} />{tr("测试全部")}</button>
              {testResult && (
                <div className={`mt-3 px-3 py-2 rounded-lg text-xs border ${testResult.matched ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : isDark ? 'border-[#3E4145] text-[#9AA0A6]' : 'border-slate-200 text-slate-500'}`}>
                  {testResult.matched ? tr("命中：{0}", { 0: testResult.issue?.label || testResult.rule?.label || tr("规则") }) : tr("未命中")}
                </div>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className={`text-xs font-medium ${muted}`}>{tr("导入导出")}</label>
                {!isVip && <span className="text-xs text-amber-400 flex items-center gap-1"><Lock size={12} />{tr("会员")}</span>}
              </div>
              <textarea value={transferText} onChange={(e) => setTransferText(e.target.value)} rows={7} className={`w-full px-3 py-2 rounded-lg border text-xs font-mono resize-none ${isDark ? 'bg-[#2D2F33] border-[#5F6368] text-[#E8EAED]' : 'bg-slate-50 border-slate-200 text-slate-700'}`} />
              <div className="flex items-center gap-2 mt-2">
                <button onClick={exportRules} className={`px-3 py-2 rounded-lg border text-sm flex items-center gap-1.5 ${isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-100'}`}>
                  <Download size={14} />{tr("导出")}</button>
                <button onClick={importRules} disabled={!transferText.trim()} className="px-3 py-2 rounded-lg text-sm bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50 flex items-center gap-1.5">
                  <Upload size={14} />{tr("导入")}</button>
                <button onClick={() => navigator.clipboard.writeText(transferText)} disabled={!transferText.trim()} className={`p-2 rounded-lg border disabled:opacity-50 ${isDark ? 'border-[#5F6368] text-[#E8EAED]' : 'border-slate-200 text-slate-700'}`} title={tr("复制")}>
                  <Clipboard size={14} />
                </button>
              </div>
            </div>
          </div>
        </div>

        {editingRule && (
          <RuleEditor
            rule={editingRule}
            isDark={isDark}
            muted={muted}
            saving={saving}
            onCancel={() => setEditingRule(null)}
            onSave={saveRule}
          />
        )}
      </div>
    </div>
    </>
  );
}

function RuleEditor({ rule, isDark, muted, saving, onCancel, onSave }) {
  useLocale();
  const [draft, setDraft] = useState(rule);
  const fieldClass = `w-full px-3 py-2 rounded-lg border text-sm ${isDark ? 'bg-[#2D2F33] border-[#5F6368] text-[#E8EAED]' : 'bg-white border-slate-200 text-slate-700'}`;
  return (
    <div className="fixed inset-0 z-[95] bg-black/60 flex items-center justify-center p-4" onClick={onCancel}>
      <div className={`w-full max-w-2xl rounded-xl border shadow-2xl ${isDark ? 'bg-[#202124] border-[#3E4145]' : 'bg-white border-slate-200'}`} onClick={(e) => e.stopPropagation()}>
        <div className={`px-5 py-4 border-b flex items-center justify-between ${isDark ? 'border-[#3E4145]' : 'border-slate-100'}`}>
          <h4 className={`font-semibold ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>{draft.builtIn ? tr("编辑内置规则") : tr("编辑自定义规则")}</h4>
          <button onClick={onCancel} className={`p-2 rounded-lg ${isDark ? 'text-[#9AA0A6] hover:bg-[#3E4145]' : 'text-slate-500 hover:bg-slate-100'}`}><X size={18} /></button>
        </div>
        <div className="p-5 grid gap-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <label className="text-xs">
              <span className={muted}>{tr("名称")}</span>
              <input value={draft.label} onChange={(e) => setDraft(prev => ({ ...prev, label: e.target.value }))} disabled={draft.builtIn} className={`${fieldClass} mt-1 disabled:opacity-60`} />
            </label>
            <label className="text-xs">
              <span className={muted}>{tr("类型")}</span>
              <input value={draft.type} onChange={(e) => setDraft(prev => ({ ...prev, type: e.target.value }))} disabled={draft.builtIn} className={`${fieldClass} mt-1 disabled:opacity-60`} />
            </label>
          </div>
          <div className="grid sm:grid-cols-[1fr_120px] gap-4">
            <label className="text-xs">
              <span className={muted}>{tr("正则")}</span>
              <input value={draft.pattern} onChange={(e) => setDraft(prev => ({ ...prev, pattern: e.target.value }))} disabled={draft.builtIn} className={`${fieldClass} mt-1 font-mono disabled:opacity-60`} />
            </label>
            <div className="text-xs">
              <label htmlFor="diagnostic-rule-severity" className={muted}>{tr("严重级别")}</label>
              <SelectMenu id="diagnostic-rule-severity" value={draft.severity} onChange={severity => setDraft(prev => ({ ...prev, severity }))}
                disabled={draft.builtIn} isDark={isDark} className="mt-1"
                options={['info', 'warning', 'error', 'fatal'].map(value => ({ value, label: value }))} />
            </div>
          </div>
          <label className="text-xs">
            <span className={muted}>{tr("关键词")}</span>
            <input value={draft.keywords || ''} onChange={(e) => setDraft(prev => ({ ...prev, keywords: e.target.value }))} disabled={draft.builtIn} className={`${fieldClass} mt-1 disabled:opacity-60`} />
          </label>
          <label className="text-xs">
            <span className={muted}>{tr("备注")}</span>
            <textarea value={draft.description || ''} onChange={(e) => setDraft(prev => ({ ...prev, description: e.target.value }))} rows={3} className={`${fieldClass} mt-1 resize-none`} />
          </label>
        </div>
        <div className={`px-5 py-4 border-t flex items-center justify-end gap-2 ${isDark ? 'border-[#3E4145]' : 'border-slate-100'}`}>
          <button onClick={onCancel} className={`px-4 py-2 rounded-lg border text-sm ${isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-100'}`}>{tr("取消")}</button>
          <button onClick={() => onSave(draft)} disabled={saving} className="px-4 py-2 rounded-lg text-sm bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50 flex items-center gap-1.5">
            {saving ? <RefreshCw size={15} className="animate-spin" /> : <Save size={15} />}{tr("保存")}</button>
        </div>
      </div>
    </div>
  );
}

export default DiagnosticRuleLibrary;
