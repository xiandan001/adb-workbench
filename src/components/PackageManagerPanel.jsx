// App 包管理增强面板：保留安装/推送/浏览，并新增应用列表、详情和会员操作。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  CheckSquare,
  ClipboardCheck,
  ChevronRight,
  Copy,
  Database,
  Download,
  Eye,
  EyeOff,
  File,
  Folder,
  FolderOpen,
  Info,
  Lock,
  FileText,
  Package,
  Play,
  Power,
  RefreshCw,
  Search,
  ShieldCheck,
  Star,
  Trash2,
  Upload,
  XCircle
} from 'lucide-react';
import DangerConfirmModal from './DangerConfirmModal';
import SelectMenu from './SelectMenu';
import { isConfirmSuppressed, rememberConfirmSuppressed } from '../shared/confirmMemory';
import { isDarkTheme } from '../shared/theme';
import { executePersistedPackageBatch, readPackageBatchResult, storePackageBatchResult, PACKAGE_BATCH_RESULT_EVENT } from '../shared/packageBatchStore';
import { FAVORITE_PACKAGES_EVENT, FAVORITE_PACKAGES_KEY, filterPackages, readFavoritePackages, saveShortcutList } from '../shared/deviceShortcuts';

function OperationResult({ isDark, loading, loadingText, result }) {
  const status = loading ? 'loading' : result?.status;
  const message = loading ? loadingText : result?.message;
  if (!status || !message) return null;

  const styles = {
    loading: isDark ? 'border-blue-400/30 bg-blue-400/10 text-blue-300' : 'border-blue-200 bg-blue-50 text-blue-700',
    success: isDark ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-emerald-200 bg-emerald-50 text-emerald-700',
    error: isDark ? 'border-red-400/30 bg-red-400/10 text-red-300' : 'border-red-200 bg-red-50 text-red-700'
  };
  const Icon = status === 'loading' ? RefreshCw : status === 'success' ? CheckCircle2 : XCircle;

  return (
    <div role="status" aria-live="polite" className={`mt-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${styles[status]}`}>
      <Icon size={15} className={`mt-0.5 shrink-0 ${status === 'loading' ? 'animate-spin' : ''}`} />
      <span className="min-w-0 break-words">{message}</span>
    </div>
  );
}

function PackageManagerPanel({
  device,
  theme,
  vipStatus,
  showToast,
  onOpenMemberCenter,
  onInspectApplication,
  onViewApplicationLogs,
  onSelectApkForInstall,
  recentApks = [],
  onSelectRecentApk,
  onSelectApkForPush,
  onInstallApk,
  onPushApk,
  onBrowsePath,
  onPullFile,
  onPushPathChange,
  apkInstallPath,
  apkPushPath,
  apkInstallResult,
  apkPushResult,
  apkPushRemotePath,
  pushRemotePathHistory,
  apkBrowserPath,
  apkBrowserItems,
  apkBrowserLoading,
  operationLoading
}) {
  const t = theme;
  const isDark = isDarkTheme(t);
  const isVip = vipStatus?.activated === true;
  const isOnline = device.status === 'device';
  const [packages, setPackages] = useState([]);
  const [query, setQuery] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [favoritePackages, setFavoritePackages] = useState(readFavoritePackages);
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [loadingPackages, setLoadingPackages] = useState(false);
  const [selectedPackage, setSelectedPackage] = useState(null);
  const [detail, setDetail] = useState(null);
  const [permissions, setPermissions] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState('');
  const [selectedPackageNames, setSelectedPackageNames] = useState(new Set());
  const [batchLoading, setBatchLoading] = useState('');
  const [operationError, setOperationError] = useState('');
  const [batchResult, setBatchResult] = useState(() => readPackageBatchResult(device.id));
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [packageSearchVisible, setPackageSearchVisible] = useState(() => {
    try {
      return localStorage.getItem('packageSearchVisible') !== 'false';
    } catch {
      return true;
    }
  });
  const showToastRef = useRef(showToast);
  const detailRequestRef = useRef(0);
  const onlineRef = useRef(isOnline);
  const mountedRef = useRef(true);

  const reportFailure = useCallback((message) => {
    setOperationError(message);
    showToastRef.current?.(message);
  }, []);

  useEffect(() => {
    onlineRef.current = isOnline;
  }, [isOnline]);

  useEffect(() => {
    mountedRef.current = true;
    const onBatchResult = (event) => {
      if (event.detail?.deviceId !== device.id) return;
      setBatchResult(event.detail.result);
      if (event.detail.storageError) reportFailure(event.detail.storageError);
    };
    window.addEventListener(PACKAGE_BATCH_RESULT_EVENT, onBatchResult);
    return () => {
      mountedRef.current = false;
      window.removeEventListener(PACKAGE_BATCH_RESULT_EVENT, onBatchResult);
    };
  }, [device.id, reportFailure]);

  const isLoading = (key) => operationLoading?.[key];
  const packageCount = packages.length;
  const userPackageCount = packages.filter(item => !item.system).length;
  const filteredPackages = useMemo(() => filterPackages(packages, { query, showSystem, onlyFavorites, favorites: favoritePackages }), [packages, query, showSystem, onlyFavorites, favoritePackages]);
  const visiblePackageNames = useMemo(() => filteredPackages.map(item => item.packageName), [filteredPackages]);
  const selectedCount = selectedPackageNames.size;
  const allVisibleSelected = visiblePackageNames.length > 0 && visiblePackageNames.every(name => selectedPackageNames.has(name));

  useEffect(() => {
    showToastRef.current = showToast;
  }, [showToast]);

  useEffect(() => {
    const refreshFavorites = () => setFavoritePackages(readFavoritePackages());
    window.addEventListener(FAVORITE_PACKAGES_EVENT, refreshFavorites);
    window.addEventListener('storage', refreshFavorites);
    return () => {
      window.removeEventListener(FAVORITE_PACKAGES_EVENT, refreshFavorites);
      window.removeEventListener('storage', refreshFavorites);
    };
  }, []);

  const toggleFavorite = (packageName) => {
    const current = readFavoritePackages();
    const next = current.includes(packageName) ? current.filter(name => name !== packageName) : [...current, packageName];
    if (!saveShortcutList(FAVORITE_PACKAGES_KEY, next)) {
      reportFailure('收藏未能保存，请检查本地存储空间');
      return;
    }
    setFavoritePackages(next);
    window.dispatchEvent(new Event(FAVORITE_PACKAGES_EVENT));
  };

  useEffect(() => {
    try {
      localStorage.setItem('packageSearchVisible', packageSearchVisible ? 'true' : 'false');
    } catch {
      // localStorage can be unavailable in constrained webviews; keep the runtime state.
    }
  }, [packageSearchVisible]);

  useEffect(() => {
    setSelectedPackageNames(prev => {
      const valid = new Set(packages.map(item => item.packageName));
      batchResult?.failures?.forEach(item => valid.add(item.packageName));
      const next = new Set(Array.from(prev).filter(name => valid.has(name)));
      return next.size === prev.size ? prev : next;
    });
  }, [packages, batchResult]);

  const loadPackages = useCallback(async () => {
    if (!window.electronAPI?.packageList || !isOnline) return;
    setLoadingPackages(true);
    try {
      const res = await window.electronAPI.packageList({ deviceId: device.id });
      if (res.ok) {
        setPackages(res.packages || []);
      } else {
        reportFailure(`应用列表加载失败：${res.error || '未知错误'}`);
      }
    } catch (error) {
      reportFailure(`应用列表加载异常：${error.message}`);
    } finally {
      setLoadingPackages(false);
    }
  }, [device.id, isOnline, reportFailure]);

  useEffect(() => {
    loadPackages();
  }, [loadPackages]);

  const selectPackage = async (pkg) => {
    setSelectedPackage(pkg);
    setPermissions([]);
    setDetail(null);
    const requestId = ++detailRequestRef.current;
    if (!window.electronAPI?.packageDetail || !isOnline) return;
    setDetailLoading(true);
    try {
      const res = await window.electronAPI.packageDetail({ deviceId: device.id, packageName: pkg.packageName });
      if (requestId !== detailRequestRef.current) return;
      if (res.ok) setDetail(res.detail);
      else reportFailure(`应用详情加载失败：${res.error || '未知错误'}`);
    } catch (error) {
      if (requestId === detailRequestRef.current) reportFailure(`应用详情加载异常：${error.message}`);
    } finally {
      if (requestId === detailRequestRef.current) setDetailLoading(false);
    }
  };

  const requireVip = () => {
    if (isVip) return true;
    showToast?.('该包管理操作需要会员版');
    onOpenMemberCenter?.();
    return false;
  };

  const runPackageAction = async (key, label, action, refresh = true) => {
    if (!selectedPackage || !onlineRef.current || !requireVip()) return;
    setActionLoading(key);
    try {
      const res = await action(selectedPackage.packageName);
      if (res.ok) {
        showToast?.(`${label}完成`);
        if (refresh) await loadPackages();
        if (selectedPackage) await selectPackage(selectedPackage);
      } else {
        reportFailure(`${label}失败：${res.error || '未知错误'}`);
      }
    } catch (error) {
      reportFailure(`${label}异常：${error.message}`);
    } finally {
      setActionLoading('');
    }
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

  const confirmPackageAction = (options, onConfirm) => {
    const next = {
      ...options,
      onConfirm,
      rememberChoice: false,
      rememberLabel: options.rememberLabel || '下次不再提示'
    };
    if (next.rememberKey && isConfirmSuppressed(next.rememberKey)) {
      Promise.resolve()
        .then(() => onConfirm?.())
        .catch((err) => showToastRef.current?.(`操作失败: ${err?.message || '未知错误'}`));
      return;
    }
    setConfirmDialog(next);
  };

  const exportApk = async () => {
    if (!selectedPackage || !isOnline || !requireVip()) return;
    const result = await window.electronAPI.showSaveDialog({
      title: '导出 APK',
      defaultPath: `${selectedPackage.packageName}.apk`,
      filters: [{ name: 'APK Files', extensions: ['apk'] }]
    });
    if (result.canceled || !result.filePath) return;
    await runPackageAction('export', '导出 APK', (packageName) => window.electronAPI.packageExportApk({
      deviceId: device.id,
      packageName,
      localPath: result.filePath
    }), false);
  };

  const loadPermissions = async () => {
    if (!selectedPackage || !isOnline || !requireVip()) return;
    setActionLoading('permissions');
    try {
      const res = await window.electronAPI.packagePermissions({ deviceId: device.id, packageName: selectedPackage.packageName });
      if (res.ok) setPermissions(res.permissions || []);
      else reportFailure(`权限读取失败：${res.error || '未知错误'}`);
    } catch (error) {
      reportFailure(`权限读取异常：${error.message}`);
    } finally {
      setActionLoading('');
    }
  };

  const launchPackage = async () => {
    if (!selectedPackage || !isOnline) return;
    setActionLoading('launch');
    try {
      const res = await window.electronAPI.packageLaunch({ deviceId: device.id, packageName: selectedPackage.packageName });
      if (res.ok) showToast?.('启动完成');
      else reportFailure(`启动失败：${res.error || '未知错误'}`);
    } catch (error) {
      reportFailure(`启动异常：${error.message}`);
    } finally {
      setActionLoading('');
    }
  };

  const exportSnapshot = async () => {
    const res = await window.electronAPI.packageSnapshot({ deviceId: device.id });
    if (res.ok) showToast?.(`包快照已导出：${res.path}`);
    else showToast?.(`包快照导出失败：${res.error || '未知错误'}`);
  };

  const togglePackageSelection = (packageName) => {
    setSelectedPackageNames(prev => {
      const next = new Set(prev);
      if (next.has(packageName)) next.delete(packageName);
      else next.add(packageName);
      return next;
    });
  };

  const toggleVisibleSelection = () => {
    setSelectedPackageNames(prev => {
      const next = new Set(prev);
      if (allVisibleSelected) visiblePackageNames.forEach(name => next.delete(name));
      else visiblePackageNames.forEach(name => next.add(name));
      return next;
    });
  };

  const runBatchAction = async (action, label, confirmOptions) => {
    if (selectedCount === 0 || batchLoading || !isOnline || !requireVip()) return;
    const selectedNames = Array.from(selectedPackageNames);
    const targetDeviceId = device.id;
    const execute = async () => {
      if (!onlineRef.current) {
        reportFailure('设备已离线，批量操作未执行。恢复连接后请重新确认。');
        return false;
      }
      setBatchLoading(action);
      try {
        const { result: summary, requestError } = await executePersistedPackageBatch({
          deviceId: targetDeviceId,
          action, label, packageNames: selectedNames,
          request: (args) => window.electronAPI.packageBatch(args)
        });
        if (!mountedRef.current) return true;
        setBatchResult(summary);
        setSelectedPackageNames(new Set(summary.failures.map(item => item.packageName)));
        if (requestError) {
          reportFailure(`${label}异常：${requestError}；执行结果已保留，请先核实设备状态`);
          return true;
        }
        showToast?.(`${label}完成：成功 ${summary.successCount}，失败 ${summary.failures.length}`);
        await loadPackages();
        if (!mountedRef.current) return true;
        if (action === 'uninstall' && selectedPackage && summary.items.some(item => item.packageName === selectedPackage.packageName && item.ok)) {
          setSelectedPackage(null);
          setDetail(null);
          setPermissions([]);
        } else if (selectedPackage) {
          await selectPackage(selectedPackage);
        }
      } catch (error) {
        // Post-operation UI refresh must not replace the persisted execution result.
        if (mountedRef.current) reportFailure(`${label}结果刷新异常：${error.message}`);
      } finally {
        if (mountedRef.current) setBatchLoading('');
      }
    };
    if (confirmOptions) {
      confirmPackageAction(
        typeof confirmOptions === 'string' ? { title: label, message: confirmOptions, confirmLabel: label } : confirmOptions,
        execute
      );
      return;
    }
    await execute();
  };

  const packageActionButton = (key, label, icon, onClick, tone = 'normal', vipRequired = true) => {
    const toneClass = tone === 'danger'
      ? 'border-red-500/30 text-red-400 hover:bg-red-500/10'
      : isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-100';
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={!selectedPackage || !isOnline || Boolean(actionLoading) || Boolean(batchLoading)}
        className={`px-3 py-2 rounded-lg border text-xs font-medium transition-colors flex items-center gap-1.5 disabled:opacity-50 ${toneClass}`}
      >
        {actionLoading === key ? <RefreshCw size={13} className="animate-spin" /> : icon}
        {label}
        {!isVip && vipRequired && <Lock size={12} className="text-amber-400" />}
      </button>
    );
  };

  return (
    <>
    <DangerConfirmModal
      open={!!confirmDialog}
      theme={theme}
      title={confirmDialog?.title}
      message={confirmDialog?.message}
      detail={confirmDialog?.detail}
      bullets={confirmDialog?.bullets || []}
      confirmLabel={confirmDialog?.confirmLabel || '确定'}
      tone={confirmDialog?.tone || 'danger'}
      loading={confirmLoading}
      rememberChoice={!!confirmDialog?.rememberChoice}
      rememberLabel={confirmDialog?.rememberLabel || '下次不再提示'}
      onRememberChoiceChange={confirmDialog?.rememberKey ? (checked) => {
        setConfirmDialog(prev => prev ? { ...prev, rememberChoice: checked } : prev);
      } : undefined}
      onCancel={() => setConfirmDialog(null)}
      onConfirm={runConfirmDialog}
    />
    <div className={`border-t p-4 ${isDark ? 'bg-slate-800/30' : 'bg-slate-50'}`}>
      {operationError && (
        <div role="alert" className="mb-3 flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          <span className="min-w-0 flex-1 break-words">{operationError}</span>
          <button type="button" onClick={() => setOperationError('')} className="shrink-0 underline">收起</button>
        </div>
      )}
      {!isOnline && <p role="status" className="mb-3 text-xs text-amber-500">设备不可用，已保留应用列表与操作结果。恢复连接后才能执行操作。</p>}
      {batchResult && (
        <div role="status" className={`mb-3 rounded-lg border p-3 ${batchResult.failures.length ? 'border-amber-500/30 bg-amber-500/10' : 'border-emerald-500/30 bg-emerald-500/10'}`}>
          <div className={`flex flex-wrap items-center gap-2 text-xs ${t.text}`}>
            <span className="flex-1">{batchResult.label}：成功 {batchResult.successCount}，失败 {batchResult.failures.length}</span>
            {batchResult.failures.length > 0 && <button type="button" onClick={() => {
              setSelectedPackageNames(new Set(batchResult.failures.map(item => item.packageName)));
              setPackageSearchVisible(true);
            }} className="underline underline-offset-2">仅选择失败项</button>}
            <button type="button" onClick={() => {
              const error = storePackageBatchResult(device.id, null);
              if (!error) setBatchResult(null);
              else reportFailure(error);
            }} className={t.textMuted}>关闭结果</button>
          </div>
          {batchResult.failures.length > 0 && (
            <>
              <p className={`mt-2 text-xs ${t.textMuted}`}>失败项已保留；不会自动重试。请核实原因后再手动操作。</p>
              <ul className="mt-2 max-h-44 overflow-y-auto space-y-2">
                {batchResult.failures.map(item => <li key={item.packageName} className="text-xs">
                  <div className={`font-mono break-all ${t.text}`}>{item.packageName}</div>
                  <div className="mt-0.5 break-words text-amber-600">{item.error || item.message || '操作失败，未返回原因'}</div>
                </li>)}
              </ul>
            </>
          )}
        </div>
      )}
      <div className="flex items-center justify-between mb-4">
        <h4 className={`text-sm font-semibold flex items-center gap-2 ${t.text}`}>
          <Package size={16} />
          App 包管理
        </h4>
        <div className="flex items-center gap-2">
          <span className={`text-xs px-2 py-1 rounded ${isDark ? 'bg-[#3E4145] text-[#9AA0A6]' : 'bg-white text-slate-500 border border-slate-200'}`}>
            {userPackageCount}/{packageCount}
          </span>
          <button
            type="button"
            onClick={() => setPackageSearchVisible(prev => !prev)}
            className={`px-3 py-2 rounded-lg border text-xs transition-colors flex items-center gap-1.5 ${packageSearchVisible ? t.button.secondary : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500'}`}
            title={packageSearchVisible ? '隐藏应用列表和包名搜索' : '显示应用列表和包名搜索'}
          >
            {packageSearchVisible ? <EyeOff size={14} /> : <Eye size={14} />}
            {packageSearchVisible ? '隐藏列表' : '显示列表'}
          </button>
          <button
            type="button"
            onClick={exportSnapshot}
            disabled={!isOnline || loadingPackages || packages.length === 0}
            className={`px-3 py-2 rounded-lg border text-xs transition-colors flex items-center gap-1.5 disabled:opacity-50 ${t.button.secondary}`}
            title="导出包快照"
          >
            <Download size={14} />
            快照
          </button>
          <button
            type="button"
            onClick={loadPackages}
            disabled={!isOnline || loadingPackages}
            className={`p-2 rounded-lg border transition-colors ${t.button.secondary} disabled:opacity-50`}
            title="刷新应用列表"
          >
            <RefreshCw size={14} className={loadingPackages ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <div className="space-y-4">
        <div className="space-y-4">
          <div className={`p-4 rounded-lg border ${isDark ? 'bg-[#202124]/70 border-[#3E4145]' : 'bg-white border-slate-200'}`}>
            <div className="space-y-3">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Download size={14} className={t.primary === 'pink' ? 'text-pink-500' : t.primary === 'orange' ? 'text-orange-500' : 'text-emerald-500'} />
                  <span className={`text-sm font-medium ${t.text}`}>安装 APK</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={apkInstallPath}
                    readOnly
                    placeholder="选择 APK 文件"
                    className={`min-w-[260px] flex-[1_1_260px] px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 ${t.input}`}
                  />
                  <button onClick={onSelectApkForInstall} disabled={isLoading(`install_${device.id}`)} className={`px-3 py-2 text-sm border rounded-lg transition-colors flex items-center gap-1 ${t.button.secondary}`}>
                    <FolderOpen size={14} />
                    选择
                  </button>
                  <button onClick={onInstallApk} disabled={!isOnline || !apkInstallPath || isLoading(`install_${device.id}`)} className={`px-3 py-2 text-sm rounded-lg transition-colors flex items-center gap-1 ${t.button.primary.split(' ')[0]} ${t.button.primary.split(' ')[1] || ''} disabled:opacity-50`}>
                    {isLoading(`install_${device.id}`) ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />}
                    安装
                  </button>
                </div>
                {recentApks.length > 0 && <div className="mt-2">
                  <SelectMenu
                    id={`recent-apks-${device.id}`}
                    value={recentApks.includes(apkInstallPath) ? apkInstallPath : ''}
                    options={recentApks.map(path => ({ value: path, label: path }))}
                    onChange={onSelectRecentApk}
                    placeholder="最近使用的 APK"
                    isDark={isDark}
                    compact
                    disabled={isLoading(`install_${device.id}`)}
                  />
                  <p className={`mt-1 text-[11px] ${t.textMuted}`}>最近 5 个 APK · 选择后仅填入路径，点击“安装”才会执行</p>
                </div>}
                <OperationResult
                  isDark={isDark}
                  loading={isLoading(`install_${device.id}`)}
                  loadingText="APK 安装中"
                  result={apkInstallResult}
                />
              </div>

              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Upload size={14} className="text-blue-500" />
                  <span className={`text-sm font-medium ${t.text}`}>推送文件</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input type="text" value={apkPushPath} readOnly placeholder="选择本地文件" className={`min-w-[260px] flex-[1_1_260px] px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 ${t.input}`} />
                  <button onClick={onSelectApkForPush} disabled={isLoading(`push_${device.id}`)} className={`px-3 py-2 text-sm border rounded-lg transition-colors flex items-center gap-1 ${t.button.secondary}`}>
                    <FolderOpen size={14} />
                    选择
                  </button>
                  <input
                    type="text"
                    value={apkPushRemotePath}
                    onChange={(e) => onPushPathChange?.(e.target.value)}
                    list={`push-remote-path-history-${device.id}`}
                    placeholder="/sdcard/"
                    className={`w-40 px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 ${t.input}`}
                  />
                  <datalist id={`push-remote-path-history-${device.id}`}>
                    {(pushRemotePathHistory || []).map((item, idx) => <option key={idx} value={item} />)}
                  </datalist>
                  <button onClick={onPushApk} disabled={!isOnline || !apkPushPath || isLoading(`push_${device.id}`)} className={`px-3 py-2 text-sm rounded-lg transition-colors flex items-center gap-1 ${t.button.primary.split(' ')[0]} ${t.button.primary.split(' ')[1] || ''} disabled:opacity-50`}>
                    {isLoading(`push_${device.id}`) ? <RefreshCw size={14} className="animate-spin" /> : <Upload size={14} />}
                    推送
                  </button>
                </div>
                <OperationResult
                  isDark={isDark}
                  loading={isLoading(`push_${device.id}`)}
                  loadingText="文件推送中"
                  result={apkPushResult}
                />
              </div>
            </div>
          </div>

          <div className={`p-4 rounded-lg border ${isDark ? 'bg-[#202124]/70 border-[#3E4145]' : 'bg-white border-slate-200'}`}>
            <div className="flex items-center gap-2 mb-3">
              <Folder size={14} className="text-purple-500" />
              <span className={`text-sm font-medium ${t.text}`}>设备文件</span>
              <span className={`ml-auto text-xs font-mono px-2 py-1 rounded select-all ${isDark ? 'bg-[#3E4145] text-[#E8EAED]' : 'bg-slate-100 text-slate-600'}`}>{apkBrowserPath}</span>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(apkBrowserPath);
                  showToast?.(`路径已复制: ${apkBrowserPath}`);
                }}
                className={`p-1 transition-colors ${isDark ? 'text-[#9AA0A6] hover:text-cyan-400' : 'text-[#9AA0A6] hover:text-emerald-500'}`}
                title="复制路径"
              >
                <Copy size={14} />
              </button>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {['/', '/system/app', '/system_ext/app', '/data/app'].map(item => (
                <button key={item} disabled={!isOnline} onClick={() => onBrowsePath?.(item)} className={`px-3 py-2 text-sm border rounded-lg transition-colors disabled:opacity-50 ${t.button.secondary}`}>
                  {item === '/' ? '/ 根目录' : item}
                </button>
              ))}
            </div>
            <div className={`mt-3 border rounded-lg max-h-48 overflow-y-auto ${isDark ? 'bg-slate-800/50 border-[#3E4145]' : 'bg-white border-slate-200'}`}>
              {apkBrowserLoading ? (
                <div className="p-4 text-center text-sm text-[#9AA0A6]">加载中...</div>
              ) : apkBrowserItems.length === 0 ? (
                <div className="p-4 text-center text-sm text-[#9AA0A6]">暂无文件</div>
              ) : (
                <div className={`divide-y ${isDark ? 'divide-slate-700' : 'divide-slate-100'}`}>
                  {apkBrowserItems.map((item, index) => (
                    <div
                      key={index}
                      className={`px-3 py-2 flex items-center justify-between cursor-pointer group ${isDark ? 'hover:bg-[#3E4145]' : 'hover:bg-slate-50'}`}
                      onClick={() => isOnline && item.isDirectory && item.name !== '.' && onBrowsePath?.(item.path)}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {item.name === '.' ? <ArrowLeft size={14} className="text-slate-400" /> : item.name === '..' ? <ArrowLeft size={14} className="text-blue-400" /> : item.isDirectory ? <Folder size={14} className="text-amber-500" /> : <File size={14} className="text-slate-400" />}
                        <span className={`text-sm truncate ${item.name === '..' ? 'text-blue-500 font-medium' : item.name === '.' ? 'text-slate-400' : t.text}`}>
                          {item.name === '.' ? '当前目录' : item.name === '..' ? '上一级目录' : item.name}
                        </span>
                      </div>
                      {!item.isDirectory && item.name !== '.' && item.name !== '..' ? (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigator.clipboard.writeText(item.path);
                              showToast?.(`路径已复制: ${item.path}`);
                            }}
                            className={`px-2 py-1 text-xs border rounded opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 ${t.button.secondary}`}
                          >
                            <Copy size={12} />
                            复制
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onPullFile?.(item.path);
                            }}
                            disabled={!isOnline || isLoading(`pull_${device.id}_${item.path}`)}
                            className={`px-2 py-1 text-xs border rounded opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 ${t.button.secondary} disabled:opacity-50`}
                          >
                            {isLoading(`pull_${device.id}_${item.path}`) ? <RefreshCw size={12} className="animate-spin" /> : <Download size={12} />}
                            拉取
                          </button>
                        </div>
                      ) : item.isDirectory ? (
                        item.name !== '.' && <ChevronRight size={14} className="text-slate-400" />
                      ) : (
                        <span className="text-xs text-slate-400">{item.size}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {packageSearchVisible && (
          <div className={`rounded-lg border overflow-hidden ${isDark ? 'bg-[#202124]/70 border-[#3E4145]' : 'bg-white border-slate-200'}`}>
          <div className={`p-3 border-b ${isDark ? 'border-[#3E4145]' : 'border-slate-100'}`}>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1">
                <Search size={14} className={`absolute left-3 top-1/2 -translate-y-1/2 ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索包名"
                  className={`w-full pl-9 pr-3 py-2 text-sm border rounded-lg outline-none focus:ring-2 focus:ring-emerald-500 ${t.input}`}
                />
              </div>
              <button
                type="button"
                aria-pressed={onlyFavorites}
                onClick={() => setOnlyFavorites(prev => !prev)}
                className={`px-3 py-2 rounded-lg border text-xs flex items-center gap-1.5 ${onlyFavorites ? 'border-amber-500/30 bg-amber-500/10 text-amber-500' : t.button.secondary}`}
              >
                <Star size={13} fill={onlyFavorites ? 'currentColor' : 'none'} />
                收藏
              </button>
              <button
                type="button"
                onClick={() => setShowSystem(prev => !prev)}
                disabled={onlyFavorites}
                className={`px-3 py-2 rounded-lg border text-xs flex items-center gap-1.5 ${showSystem ? 'border-blue-500/30 bg-blue-500/10 text-blue-400' : t.button.secondary}`}
              >
                {showSystem ? <Eye size={13} /> : <EyeOff size={13} />}
                系统
              </button>
              <button
                type="button"
                onClick={toggleVisibleSelection}
                disabled={filteredPackages.length === 0}
                className={`px-3 py-2 rounded-lg border text-xs flex items-center gap-1.5 disabled:opacity-50 ${allVisibleSelected ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : t.button.secondary}`}
              >
                <CheckSquare size={13} />
                {allVisibleSelected ? '取消' : '全选'}
              </button>
            </div>
            {selectedCount > 0 && (
              <div className={`mt-3 rounded-lg border px-3 py-2 flex flex-wrap items-center gap-2 ${isDark ? 'bg-[#2D2F33] border-[#3E4145]' : 'bg-slate-50 border-slate-200'}`}>
                <span className={`text-xs mr-auto ${isDark ? 'text-[#E8EAED]' : 'text-slate-700'}`}>已选 {selectedCount} 个应用</span>
                <button type="button" onClick={() => runBatchAction('forceStop', '批量停止')} disabled={!isOnline || !!batchLoading || !!actionLoading} className={`px-2.5 py-1.5 rounded border text-xs flex items-center gap-1 disabled:opacity-50 ${t.button.secondary}`}>{batchLoading === 'forceStop' ? <RefreshCw size={12} className="animate-spin" /> : <Power size={12} />}停止</button>
                <button type="button" onClick={() => runBatchAction('clearData', '批量清数据', {
                  title: '批量清除应用数据',
                  message: `确定清除 ${selectedCount} 个应用的数据吗？`,
                  detail: '清数据会删除应用本地账号、缓存和配置，无法从本工具直接恢复。',
                  confirmLabel: '清除数据',
                  rememberKey: 'package.batchClearData'
                })} disabled={!isOnline || !!batchLoading || !!actionLoading} className={`px-2.5 py-1.5 rounded border text-xs flex items-center gap-1 disabled:opacity-50 ${t.button.secondary}`}>{batchLoading === 'clearData' ? <RefreshCw size={12} className="animate-spin" /> : <Database size={12} />}清数据</button>
                <button type="button" onClick={() => runBatchAction('disable', '批量停用', {
                  title: '批量停用应用',
                  message: `确定停用 ${selectedCount} 个应用吗？`,
                  detail: '停用后应用不会正常启动。可在包管理中重新启用作为回滚。',
                  confirmLabel: '停用应用',
                  rememberKey: 'package.batchDisable',
                  tone: 'warning'
                })} disabled={!isOnline || !!batchLoading || !!actionLoading} className={`px-2.5 py-1.5 rounded border text-xs flex items-center gap-1 disabled:opacity-50 ${t.button.secondary}`}>{batchLoading === 'disable' ? <RefreshCw size={12} className="animate-spin" /> : <EyeOff size={12} />}停用</button>
                <button type="button" onClick={() => runBatchAction('enable', '批量启用')} disabled={!isOnline || !!batchLoading || !!actionLoading} className={`px-2.5 py-1.5 rounded border text-xs flex items-center gap-1 disabled:opacity-50 ${t.button.secondary}`}>{batchLoading === 'enable' ? <RefreshCw size={12} className="animate-spin" /> : <Eye size={12} />}启用</button>
                <button type="button" onClick={() => runBatchAction('uninstall', '批量卸载', {
                  title: '批量卸载应用',
                  message: `确定卸载 ${selectedCount} 个应用吗？`,
                  detail: '卸载会从当前用户移除应用。需要回退时请保留 APK，并重新安装对应版本。',
                  confirmLabel: '卸载应用',
                  rememberKey: 'package.batchUninstall'
                })} disabled={!isOnline || !!batchLoading || !!actionLoading} className="px-2.5 py-1.5 rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 text-xs flex items-center gap-1 disabled:opacity-50">{batchLoading === 'uninstall' ? <RefreshCw size={12} className="animate-spin" /> : <Trash2 size={12} />}卸载</button>
              </div>
            )}
          </div>

          <div className="grid min-h-[420px] max-h-[720px] grid-cols-1">
            <div className={`max-h-[320px] overflow-y-auto border-b ${isDark ? 'border-[#3E4145]' : 'border-slate-100'}`}>
              {loadingPackages ? (
                <div className="h-full flex items-center justify-center text-sm text-[#9AA0A6]">
                  <RefreshCw size={16} className="animate-spin mr-2" />
                  加载中...
                </div>
              ) : filteredPackages.length === 0 ? (
                <div className="min-h-24 flex items-center justify-center px-4 text-center text-sm text-[#9AA0A6]">{onlyFavorites ? '暂无匹配的收藏应用；点击应用右侧的星标即可收藏' : '暂无应用'}</div>
              ) : filteredPackages.map(pkg => (
                <div
                  key={pkg.packageName}
                  role="button"
                  tabIndex={0}
                  onClick={() => selectPackage(pkg)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      selectPackage(pkg);
                    }
                  }}
                  className={`w-full text-left px-3 py-2.5 border-b transition-colors cursor-pointer ${selectedPackage?.packageName === pkg.packageName ? 'bg-emerald-500/10' : isDark ? 'hover:bg-[#2D2F33]' : 'hover:bg-slate-50'} ${isDark ? 'border-[#3E4145]' : 'border-slate-100'}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <input
                      type="checkbox"
                      checked={selectedPackageNames.has(pkg.packageName)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => togglePackageSelection(pkg.packageName)}
                      className="h-4 w-4 accent-emerald-500"
                    />
                    <Package size={14} className={pkg.system ? 'text-slate-400' : 'text-emerald-500'} />
                    <div className="min-w-0 flex-1">
                      <div className={`text-sm font-medium truncate ${t.text}`}>{pkg.packageName}</div>
                      <div className="text-xs text-[#9AA0A6] truncate">{pkg.apkName || pkg.path}</div>
                    </div>
                    {pkg.system && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-500/10 text-slate-400">SYS</span>}
                    <button
                      type="button"
                      aria-label={`${favoritePackages.includes(pkg.packageName) ? '取消收藏' : '收藏'} ${pkg.packageName}`}
                      aria-pressed={favoritePackages.includes(pkg.packageName)}
                      title={favoritePackages.includes(pkg.packageName) ? '取消收藏' : '收藏应用并优先显示'}
                      onClick={(event) => { event.stopPropagation(); toggleFavorite(pkg.packageName); }}
                      className={`shrink-0 rounded p-1.5 transition-colors ${favoritePackages.includes(pkg.packageName) ? 'text-amber-500 bg-amber-500/10' : 'text-slate-400 hover:text-amber-500'}`}
                    ><Star size={16} fill={favoritePackages.includes(pkg.packageName) ? 'currentColor' : 'none'} /></button>
                  </div>
                </div>
              ))}
            </div>

            <div className="p-4 overflow-y-auto">
              {!selectedPackage ? (
                <div className="h-full flex flex-col items-center justify-center text-center text-[#9AA0A6]">
                  <Info size={30} className="mb-2 opacity-60" />
                  <div className="text-sm">选择一个应用</div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <div className={`text-sm font-semibold break-all ${t.text}`}>{selectedPackage.packageName}</div>
                    <div className="text-xs text-[#9AA0A6] mt-1 break-all">{selectedPackage.path}</div>
                  </div>
                  {detailLoading ? (
                    <div className="flex items-center text-sm text-[#9AA0A6]">
                      <RefreshCw size={15} className="animate-spin mr-2" />
                      加载详情...
                    </div>
                  ) : detail && (
                    <div className={`text-xs rounded-lg border overflow-hidden ${isDark ? 'border-[#3E4145]' : 'border-slate-200'}`}>
                      {[
                        ['版本名', detail.versionName || '-'],
                        ['版本号', detail.versionCode || '-'],
                        ['UID', detail.userId || detail.uid || '-'],
                        ['安装器', detail.installer || '-'],
                        ['首次安装', detail.firstInstallTime || '-'],
                        ['最后更新', detail.lastUpdateTime || '-']
                      ].map(([label, value]) => (
                        <div key={label} className={`flex gap-3 px-3 py-2 border-b last:border-b-0 ${isDark ? 'border-[#3E4145]' : 'border-slate-100'}`}>
                          <span className="w-16 shrink-0 text-[#9AA0A6]">{label}</span>
                          <span className={`min-w-0 break-all ${t.text}`}>{value}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    {onViewApplicationLogs && <button
                      type="button"
                      onClick={() => onViewApplicationLogs({ deviceId: device.id, packageName: selectedPackage.packageName })}
                      className={`px-3 py-2 rounded-lg border text-xs font-medium flex items-center gap-1.5 ${t.button.secondary}`}
                    ><FileText size={13} />查看日志</button>}
                    {onInspectApplication && <button
                      type="button"
                      onClick={() => onInspectApplication({ deviceId: device.id, packageName: selectedPackage.packageName })}
                      className={`px-3 py-2 rounded-lg border text-xs font-medium flex items-center gap-1.5 ${t.button.secondary}`}
                    ><ClipboardCheck size={13} />排查此应用</button>}
                    {packageActionButton('launch', '启动', <Play size={13} />, launchPackage, 'normal', false)}
                    {packageActionButton('permissions', '权限', <ShieldCheck size={13} />, loadPermissions)}
                    {packageActionButton('export', '导出', <Download size={13} />, exportApk)}
                    {packageActionButton('stop', '停止', <Power size={13} />, () => runPackageAction('stop', '强制停止', packageName => window.electronAPI.packageForceStop({ deviceId: device.id, packageName }), false))}
                    {packageActionButton('clear', '清数据', <Database size={13} />, () => confirmPackageAction({
                      title: '清除应用数据',
                      message: `确定清除 ${selectedPackage.packageName} 的应用数据吗？`,
                      detail: '清数据会删除该应用本地账号、缓存和配置，无法从本工具直接恢复。',
                      confirmLabel: '清除数据',
                      rememberKey: 'package.clearData'
                    }, () => runPackageAction('clear', '清除数据', packageName => window.electronAPI.packageClearData({ deviceId: device.id, packageName }))))}
                    {packageActionButton('disable', detail?.enabled === false ? '启用' : '停用', detail?.enabled === false ? <Eye size={13} /> : <EyeOff size={13} />, () => runPackageAction('disable', detail?.enabled === false ? '启用应用' : '停用应用', packageName => window.electronAPI.packageSetEnabled({ deviceId: device.id, packageName, enabled: detail?.enabled === false })))}
                    {packageActionButton('uninstall', '卸载', <Trash2 size={13} />, () => confirmPackageAction({
                      title: '卸载应用',
                      message: `确定卸载 ${selectedPackage.packageName} 吗？`,
                      detail: '卸载会从当前用户移除应用。需要回退时请保留 APK，并重新安装对应版本。',
                      confirmLabel: '卸载应用',
                      rememberKey: 'package.uninstall'
                    }, () => runPackageAction('uninstall', '卸载应用', packageName => window.electronAPI.packageUninstall({ deviceId: device.id, packageName }))), 'danger')}
                  </div>

                  {permissions.length > 0 && (
                    <div className={`rounded-lg border max-h-40 overflow-y-auto ${isDark ? 'border-[#3E4145]' : 'border-slate-200'}`}>
                      {permissions.map((perm, index) => (
                        <div key={`${perm.name}-${index}`} className={`px-3 py-2 text-xs border-b last:border-b-0 ${isDark ? 'border-[#3E4145]' : 'border-slate-100'}`}>
                          <div className={`break-all ${t.text}`}>{perm.name}</div>
                          <div className={perm.granted === true ? 'text-emerald-400' : perm.granted === false ? 'text-red-400' : 'text-[#9AA0A6]'}>
                            {perm.granted === true ? 'granted' : perm.granted === false ? 'denied' : perm.source}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          </div>
        )}
      </div>
    </div>
    </>
  );
}

export default PackageManagerPanel;
