import { isDarkTheme } from '../shared/theme';
// 激活记录增强面板：激活记录、备注、复制历史、到期时间与重签说明。

import { useCallback, useEffect, useState } from 'react';
import { Check, ClipboardCopy, Clock, FileText, History, RefreshCw, Save, Trash2 } from 'lucide-react';

function ActivationRecordsPanel({ theme, showToast, refreshKey, recordData }) {
  const t = theme || { primary: 'tech' };
  const isDark = isDarkTheme(t);
  const [records, setRecords] = useState([]);
  const [copyHistory, setCopyHistory] = useState([]);
  const [notes, setNotes] = useState({});
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState('');

  const applyRecordData = useCallback((data) => {
    if (!data?.ok) return;
    setRecords(data.records || []);
    setCopyHistory(data.copyHistory || []);
    setNotes(Object.fromEntries((data.records || []).map(record => [record.id, record.note || ''])));
  }, []);

  const loadRecords = useCallback(async () => {
    if (!window.electronAPI?.vipGetActivationRecords) return;
    setLoading(true);
    try {
      const res = await window.electronAPI.vipGetActivationRecords();
      applyRecordData(res);
    } finally {
      setLoading(false);
    }
  }, [applyRecordData]);

  useEffect(() => {
    if (recordData?.ok) applyRecordData(recordData);
  }, [recordData, applyRecordData]);

  useEffect(() => {
    loadRecords();
  }, [refreshKey, loadRecords]);

  const saveNote = async (recordId) => {
    setSavingId(recordId);
    try {
      const res = await window.electronAPI.vipUpdateActivationRecordNote({ id: recordId, note: notes[recordId] || '' });
      if (res.ok) {
        applyRecordData(res);
        showToast?.('备注已保存');
      } else {
        showToast?.(`备注保存失败：${res.error || '未知错误'}`);
      }
    } catch (error) {
      showToast?.(`备注保存异常：${error.message}`);
    } finally {
      setSavingId('');
    }
  };

  const copyValue = async (kind, value) => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    const res = await window.electronAPI.vipAddCopyHistory({ kind, value });
    applyRecordData(res);
    showToast?.('已复制');
  };

  const clearCopyHistory = async () => {
    const res = await window.electronAPI.vipClearCopyHistory();
    if (res.ok) {
      applyRecordData(res);
      showToast?.('复制历史已清除');
    }
  };

  const panelClass = `p-6 rounded-xl border shadow-sm ${isDark ? 'bg-slate-800/80 border-[#3E4145]' : 'bg-white border-slate-200'}`;
  const muted = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';

  return (
    <div className={panelClass}>
      <div className="flex items-center justify-between mb-5">
        <h3 className={`text-lg font-semibold flex items-center gap-2 ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>
          <FileText size={19} className="text-amber-500" />
          激活记录
        </h3>
        <button onClick={loadRecords} disabled={loading} className={`px-3 py-2 rounded-lg border text-sm flex items-center gap-1.5 ${isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-100'}`}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          刷新
        </button>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-3">
          {records.length === 0 ? (
            <div className={`py-10 text-center text-sm rounded-lg border border-dashed ${isDark ? 'border-[#3E4145] text-[#80868B]' : 'border-slate-200 text-slate-400'}`}>
              暂无激活记录
            </div>
          ) : records.map(record => (
            <div key={record.id} className={`p-4 rounded-lg border ${isDark ? 'bg-[#2D2F33] border-[#3E4145]' : 'bg-slate-50 border-slate-200'}`}>
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <span className="px-2 py-1 rounded text-xs font-semibold bg-amber-500/15 text-amber-500">
                  {record.type === 'lifetime' ? '终身' : record.type || '会员'}
                </span>
                <span className={`text-xs ${muted}`}>{formatDateTime(record.activatedAt)}</span>
                <span className={`text-xs ${record.expiresAt ? 'text-orange-400' : 'text-emerald-400'}`}>
                  {record.expiresAt ? `到期 ${formatDate(record.expiresAt)}` : '永久有效'}
                </span>
              </div>
              <div className={`grid gap-2 text-xs ${muted}`}>
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-16 shrink-0">机器码</span>
                  <code className={`min-w-0 flex-1 break-all ${isDark ? 'text-[#E8EAED]' : 'text-slate-700'}`}>{record.machineId}</code>
                  <button onClick={() => copyValue('machineId', record.machineId)} className={`p-1.5 rounded ${isDark ? 'hover:bg-[#3E4145]' : 'hover:bg-white'}`} title="复制机器码">
                    <ClipboardCopy size={14} />
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-16 shrink-0">签名</span>
                  <code className={isDark ? 'text-[#E8EAED]' : 'text-slate-700'}>{record.tokenHash}</code>
                  <button onClick={() => copyValue('tokenHash', record.tokenHash)} className={`p-1.5 rounded ${isDark ? 'hover:bg-[#3E4145]' : 'hover:bg-white'}`} title="复制签名摘要">
                    <ClipboardCopy size={14} />
                  </button>
                </div>
              </div>
              <div className="mt-4">
                <label className={`text-xs ${muted}`}>备注</label>
                <div className="mt-1 flex gap-2">
                  <input
                    value={notes[record.id] || ''}
                    onChange={(e) => setNotes(prev => ({ ...prev, [record.id]: e.target.value }))}
                    className={`min-w-0 flex-1 px-3 py-2 rounded-lg border text-sm ${isDark ? 'bg-[#202124] border-[#5F6368] text-[#E8EAED]' : 'bg-white border-slate-200 text-slate-700'}`}
                  />
                  <button onClick={() => saveNote(record.id)} disabled={savingId === record.id} className="px-3 py-2 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50 flex items-center gap-1.5">
                    {savingId === record.id ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
                    保存
                  </button>
                </div>
              </div>
              <div className={`mt-3 text-xs rounded-lg px-3 py-2 ${isDark ? 'bg-[#202124] text-[#9AA0A6]' : 'bg-white text-slate-500'}`}>
                {record.reSignNote || '如需重签，请复制机器码并联系开发者。'}
              </div>
            </div>
          ))}
        </div>

        <div className={`rounded-lg border overflow-hidden ${isDark ? 'border-[#3E4145]' : 'border-slate-200'}`}>
          <div className={`px-4 py-3 border-b flex items-center justify-between ${isDark ? 'border-[#3E4145] bg-[#2D2F33]' : 'border-slate-100 bg-slate-50'}`}>
            <div className={`text-sm font-semibold flex items-center gap-2 ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>
              <History size={16} />
              复制历史
            </div>
            {copyHistory.length > 0 && (
              <button onClick={clearCopyHistory} className={`p-1.5 rounded ${isDark ? 'text-[#9AA0A6] hover:bg-[#3E4145]' : 'text-slate-500 hover:bg-slate-100'}`} title="清除复制历史">
                <Trash2 size={14} />
              </button>
            )}
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            {copyHistory.length === 0 ? (
              <div className={`py-12 text-center text-sm ${muted}`}>
                <Clock size={22} className="mx-auto mb-2 opacity-60" />
                暂无复制历史
              </div>
            ) : copyHistory.map(item => (
              <div key={item.id} className={`px-4 py-3 border-b last:border-b-0 ${isDark ? 'border-[#3E4145]' : 'border-slate-100'}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-xs font-medium ${isDark ? 'text-[#E8EAED]' : 'text-slate-700'}`}>{item.kind}</span>
                  <span className={`text-[11px] ${muted}`}>{formatDateTime(item.copiedAt)}</span>
                </div>
                <div className={`mt-1 text-xs font-mono break-all ${muted}`}>{item.value}</div>
                <button onClick={() => copyValue(item.kind, item.value)} className="mt-2 text-xs text-emerald-400 hover:underline inline-flex items-center gap-1">
                  <Check size={12} />
                  再次复制
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatDateTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function formatDate(value) {
  if (!value) return '-';
  if (typeof value === 'number') return new Date(value * 1000).toLocaleDateString('zh-CN');
  return new Date(value).toLocaleDateString('zh-CN');
}

export default ActivationRecordsPanel;
