import { useMemo, useState, useEffect } from 'react';
import {
  Activity,
  AlertCircle,
  ClipboardCheck,
  FileDiff,
  FileJson,
  FileText,
  FolderOpen,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Wrench
} from 'lucide-react';

const TYPE_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'troubleshooting', label: '问题排查' },
  { id: 'inspection', label: '设备巡检' },
  { id: 'regression', label: '回归差异' },
  { id: 'deviceGuard', label: '设备守护' },
  { id: 'performance', label: '性能报告' },
  { id: 'task', label: '任务中心' }
];

const TYPE_META = {
  troubleshooting: { icon: Wrench, color: 'text-emerald-400', bg: 'bg-emerald-500/15' },
  inspection: { icon: ClipboardCheck, color: 'text-cyan-400', bg: 'bg-cyan-500/15' },
  regression: { icon: FileDiff, color: 'text-blue-400', bg: 'bg-blue-500/15' },
  deviceGuard: { icon: ShieldCheck, color: 'text-teal-400', bg: 'bg-teal-500/15' },
  performance: { icon: Activity, color: 'text-purple-400', bg: 'bg-purple-500/15' },
  task: { icon: FileJson, color: 'text-amber-400', bg: 'bg-amber-500/15' }
};

function ArtifactCenter({ theme, showToast }) {
  const isDark = theme.primary === 'tech';
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [error, setError] = useState('');

  const text = isDark ? 'text-[#E8EAED]' : 'text-slate-800';
  const muted = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';
  const panel = isDark ? 'bg-[#2D2F33] border-[#3E4145]' : 'bg-white border-slate-200';
  const soft = isDark ? 'bg-[#202124] border-[#3E4145]' : 'bg-slate-50 border-slate-200';
  const input = isDark ? 'bg-[#202124] border-[#5F6368] text-[#E8EAED]' : 'bg-white border-slate-200 text-slate-700';

  useEffect(() => {
    let disposed = false;
    window.electronAPI?.artifactsList?.().then(res => {
      if (disposed) return;
      if (res?.ok) {
        setItems(res.items || []);
        setError('');
      } else {
        setError(res?.error || '产物列表加载失败');
      }
      setLoading(false);
    });
    return () => { disposed = true; };
  }, []);

  const filteredItems = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return items
      .filter(item => typeFilter === 'all' || item.type === typeFilter)
      .filter(item => {
        if (!keyword) return true;
        return [
          item.title,
          item.subtitle,
          item.typeLabel,
          item.deviceId,
          item.rootPath,
          item.reportPath
        ].some(value => String(value || '').toLowerCase().includes(keyword));
      });
  }, [items, query, typeFilter]);

  const refresh = async () => {
    setLoading(true);
    setError('');
    const res = await window.electronAPI?.artifactsList?.();
    if (res?.ok) {
      setItems(res.items || []);
    } else {
      setError(res?.error || '产物列表加载失败');
    }
    setLoading(false);
  };

  const openPath = async (targetPath) => {
    if (!targetPath) return;
    const res = await window.electronAPI?.artifactOpenPath?.(targetPath);
    if (res && !res.ok) showToast?.(`打开失败：${res.error || '未知错误'}`);
  };

  return (
    <div className="space-y-5">
      <section className={`rounded-xl border ${panel} overflow-hidden`}>
        <div className={`px-5 py-4 border-b flex items-center justify-between gap-4 ${isDark ? 'border-[#3E4145]' : 'border-slate-200'}`}>
          <div>
            <h3 className={`text-lg font-semibold ${text}`}>报告/产物中心</h3>
            <p className={`text-xs mt-1 ${muted}`}>统一查看问题排查、巡检、性能和任务中心产物</p>
          </div>
          <button
            onClick={refresh}
            disabled={loading}
            className={`px-3 py-2 rounded-lg border text-sm flex items-center gap-2 disabled:opacity-60 ${isDark ? 'border-[#5F6368] hover:bg-[#3E4145] text-[#E8EAED]' : 'border-slate-200 hover:bg-slate-100 text-slate-700'}`}
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            刷新
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid lg:grid-cols-[1fr_auto] gap-3">
            <div className="relative">
              <Search size={16} className={`absolute left-3 top-1/2 -translate-y-1/2 ${muted}`} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索标题、设备、路径"
                className={`w-full pl-9 pr-3 py-2.5 border rounded-lg text-sm outline-none focus:ring-2 focus:ring-emerald-500 ${input}`}
              />
            </div>
            <div className={`flex gap-1 p-1 rounded-lg border ${soft}`}>
              {TYPE_FILTERS.map(filter => (
                <button
                  key={filter.id}
                  onClick={() => setTypeFilter(filter.id)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    typeFilter === filter.id
                      ? 'bg-emerald-600 text-white'
                      : isDark ? 'text-[#BDC1C6] hover:bg-[#3E4145]' : 'text-slate-600 hover:bg-white'
                  }`}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid sm:grid-cols-6 gap-3">
            <Stat label="全部产物" value={items.length} isDark={isDark} />
            <Stat label="问题排查" value={items.filter(item => item.type === 'troubleshooting').length} isDark={isDark} />
            <Stat label="巡检报告" value={items.filter(item => item.type === 'inspection').length} isDark={isDark} />
            <Stat label="回归差异" value={items.filter(item => item.type === 'regression').length} isDark={isDark} />
            <Stat label="设备守护" value={items.filter(item => item.type === 'deviceGuard').length} isDark={isDark} />
            <Stat label="任务/性能" value={items.filter(item => item.type === 'task' || item.type === 'performance').length} isDark={isDark} />
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/25 bg-red-500/10 text-red-400 px-4 py-3 text-sm flex items-start gap-2">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loading ? (
            <div className={`rounded-xl border ${soft} py-12 flex items-center justify-center gap-2 ${muted}`}>
              <Loader2 size={18} className="animate-spin" />
              <span className="text-sm">正在加载产物...</span>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className={`rounded-xl border ${soft} py-12 text-center`}>
              <FileText size={28} className={`mx-auto mb-3 ${muted}`} />
              <div className={`text-sm ${muted}`}>暂无匹配产物</div>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredItems.map(item => (
                <ArtifactRow key={item.id} item={item} isDark={isDark} text={text} muted={muted} onOpenPath={openPath} />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function ArtifactRow({ item, isDark, text, muted, onOpenPath }) {
  const meta = TYPE_META[item.type] || TYPE_META.task;
  const Icon = meta.icon;
  return (
    <div className={`rounded-xl border p-4 ${isDark ? 'bg-[#202124] border-[#3E4145]' : 'bg-white border-slate-200'}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 gap-3">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${meta.bg}`}>
            <Icon size={20} className={meta.color} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`font-semibold truncate ${text}`}>{item.title}</span>
              <span className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] ${meta.bg} ${meta.color}`}>{item.typeLabel}</span>
            </div>
            <div className={`text-xs mt-1 ${muted}`}>{item.subtitle || '产物记录'}</div>
            <div className={`text-[11px] mt-2 font-mono truncate ${muted}`}>{item.rootPath}</div>
          </div>
        </div>
        <div className={`text-xs shrink-0 ${muted}`}>{formatDate(item.updatedAt || item.createdAt)}</div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className={`text-xs ${muted}`}>
          {item.deviceId ? `设备：${item.deviceId}` : '未记录设备'} · {item.artifactCount || 0} 项
        </div>
        <div className="flex flex-wrap gap-2">
          {item.reportPath && (
            <button onClick={() => onOpenPath(item.reportPath)} className={buttonClass(isDark)}>
              <FileText size={14} />打开报告
            </button>
          )}
          {item.summaryPath && (
            <button onClick={() => onOpenPath(item.summaryPath)} className={buttonClass(isDark)}>
              <FileJson size={14} />打开数据
            </button>
          )}
          {item.rootPath && (
            <button onClick={() => onOpenPath(item.rootPath)} className={buttonClass(isDark)}>
              <FolderOpen size={14} />打开目录
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, isDark }) {
  return (
    <div className={`rounded-lg border p-3 ${isDark ? 'bg-[#202124] border-[#3E4145]' : 'bg-slate-50 border-slate-200'}`}>
      <div className={`text-xs ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>{label}</div>
      <div className={`text-xl font-semibold mt-1 ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>{value}</div>
    </div>
  );
}

function buttonClass(isDark) {
  return `px-3 py-1.5 rounded-lg border text-xs flex items-center gap-1.5 ${
    isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-100'
  }`;
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', { hour12: false });
}

export default ArtifactCenter;
