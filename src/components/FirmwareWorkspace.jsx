import { createElement } from 'react';
import { CheckCircle2, ChevronDown, Copy, Download, ExternalLink, FileSearch, Loader2, Plug, RefreshCw, Usb } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';
import { isDarkTheme } from '../shared/theme.js';
import { formatBytes } from '../shared/artifactWorkspace.js';
import DangerConfirmModal from './DangerConfirmModal.jsx';
import FirmwareDirectPanel from './FirmwareDirectPanel.jsx';
import { useFirmwareDirect } from './FirmwareDirectState.js';
import { firmwareDriverAction, useFirmwareWorkspace } from './FirmwareWorkspaceState.js';
import './FirmwareWorkspace.css';

const platforms = [{ id: 'rk', label: 'RK' }, { id: 'mtk', label: 'MTK' }];
const drivers = {
  bound: () => tr('刷机驱动已绑定'),
  installed: () => tr('驱动已安装，等待设备'),
  missing: () => tr('未安装所需驱动'),
  problem: () => tr('设备或驱动异常'),
  unknown: () => tr('驱动状态未确认'),
};
const preflightErrors = {
  'unsupported-format': () => tr('不受支持的固件格式。'),
  'invalid-firmware': () => tr('固件容器无效或不完整。'),
  'invalid-manifest': () => tr('下载清单无效。'),
  'manifest-too-large': () => tr('下载清单超出大小限制。'),
  'unsafe-reference': () => tr('下载清单包含包目录之外或不安全的路径。'),
  'missing-files': () => tr('部分依赖文件缺失或不可用。'),
  'file-unavailable': () => tr('固件文件不可访问，请重新选择。'),
};
const accentText = theme => isDarkTheme(theme) ? 'text-emerald-300' : 'text-emerald-700';
const warningText = theme => isDarkTheme(theme) ? 'text-amber-300' : 'text-amber-700';

function Action({ icon, processing, className, children, ...props }) {
  return <button type="button" className={`inline-flex min-h-10 min-w-0 max-w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium leading-snug focus-visible:outline-2 focus-visible:outline-emerald-500 disabled:cursor-not-allowed disabled:opacity-50 ${className}`} {...props}>
    {processing ? <Loader2 size={15} aria-hidden="true" className="shrink-0 animate-spin" /> : createElement(icon, { size: 15, 'aria-hidden': true, className: 'shrink-0' })}
    <span className="break-words">{children}</span>
  </button>;
}

function SupportPanel({ title, theme, children }) {
  return <section className={`min-w-0 rounded-lg border p-3 ${theme.input}`}>
    <h4 className="mb-3 break-words text-sm font-semibold">{title}</h4>
    {children}
  </section>;
}

function Feedback({ view, actions, theme }) {
  if (!actions.includes(view.feedbackKind)) return null;
  if (view.error) return <p role="alert" className={`break-words text-xs leading-5 ${warningText(theme)}`}>{view.error}</p>;
  return view.notice && <p role="status" className={`break-words text-xs leading-5 ${theme.textMuted}`}>{view.notice}</p>;
}

function driverPackageText(driverPackage) {
  if (typeof driverPackage === 'string') return driverPackage;
  return [driverPackage?.name || driverPackage?.inf, driverPackage?.provider, driverPackage?.version].filter(Boolean).join(' · ');
}

function DriverPanel({ view, theme, driverAction, driverActionLabel, flashing }) {
  const { busy, status, checking, readError } = view;
  const deviceRows = Array.isArray(status?.devices) ? status.devices : [];
  const info = driverPackageText(status?.driverPackage);
  const state = readError ? 'unknown' : status?.state;
  const muted = theme.textMuted;
  return <SupportPanel title={tr('工具与驱动')} theme={theme}>
    <div className="space-y-3">
      <div role="status" aria-live="polite" className={`rounded-lg border p-3 ${theme.input}`}>
        <div className="flex min-w-0 items-start gap-2.5">
          {checking ? <Loader2 size={16} aria-hidden="true" className="mt-0.5 shrink-0 animate-spin text-emerald-500" />
            : state === 'bound' ? <CheckCircle2 size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-emerald-500" />
              : <Usb size={16} aria-hidden="true" className={`mt-0.5 shrink-0 ${state === 'missing' || state === 'problem' ? 'text-amber-500' : muted}`} />}
          <div className="min-w-0">
            <p className="break-words text-sm font-medium">{checking ? tr('正在检测驱动…') : (drivers[state] || drivers.unknown)()}</p>
            {info && <p className={`mt-1 break-all text-xs ${muted}`}>{info}</p>}
          </div>
        </div>
      </div>
      {readError && <p role="alert" className={`break-words text-xs ${warningText(theme)}`}>{readError}</p>}
      <div className="flex flex-wrap gap-2">
        {driverAction && <Action icon={Download} processing={busy === 'install'} className={theme.button.primary}
          disabled={Boolean(busy || checking)} onClick={() => view.setConfirm(true)}>{busy === 'install' ? tr('正在安装驱动…') : driverActionLabel}</Action>}
        <Action icon={RefreshCw} className={theme.button.secondary} disabled={Boolean(busy || checking)} onClick={view.refresh}>{tr('刷新')}</Action>
      </div>
      {driverAction && !status?.installer?.available && <p className={`text-xs ${muted}`}>{tr('安装时可选择本机已签名的驱动 INF 文件。')}</p>}
      {state === 'problem' && <p className={`text-xs ${muted}`}>{tr('未确认驱动绑定，请重新连接设备后刷新。')}</p>}
      <Feedback view={view} actions={['install']} theme={theme} />
      <div className="border-t border-current/10 pt-3">
        <p className="text-xs font-medium">{tr('刷机 USB 设备')}</p>
        {(deviceRows.length > 0 || !flashing && (status || !checking)) && <p className={`mt-1 text-xs ${muted}`}>{deviceRows.length ? tr('刷机 USB 设备独立识别。') : tr('未检测到刷机 USB 设备。')}</p>}
        {deviceRows.length > 0 && <ul className="mt-2 max-h-36 space-y-1.5 overflow-y-auto">
          {deviceRows.map((device, index) => <li key={device.hardwareId ? `${device.hardwareId}:${index}` : index}
            className={`flex min-w-0 items-start gap-2 rounded-lg border px-2.5 py-2 ${theme.input}`}>
            {device.bound ? <CheckCircle2 size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-emerald-500" />
              : <Plug size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-amber-500" />}
            <div className="min-w-0 text-xs">
              <p className="break-all font-medium">{device.name || device.hardwareId}</p>
              {device.driverInf && <p className={`mt-0.5 break-all ${muted}`}>{device.driverInf}</p>}
              {Number.isInteger(device.problemCode) && device.problemCode > 0 && <p className={`mt-0.5 ${warningText(theme)}`}>{tr('Windows 问题代码：{0}', { 0: device.problemCode })}</p>}
            </div>
          </li>)}
        </ul>}
      </div>
    </div>
  </SupportPanel>;
}

function PreflightPanel({ view, theme, quickCheck }) {
  const { file, platform, busy, restoringFile } = view;
  const dependencies = Array.isArray(file?.files) ? file.files : [];
  const unavailable = dependencies.filter(item => item.status !== 'present');
  const muted = theme.textMuted;
  return <section className={`min-w-0 space-y-3 self-start rounded-lg border p-3 ${theme.input}`} aria-labelledby="firmware-preflight-title">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <h4 id="firmware-preflight-title" className="pt-1 text-sm font-semibold">{tr('固件预检')}</h4>
      <Action icon={FileSearch} processing={busy === 'file'} className={file ? theme.button.secondary : theme.button.primary}
        disabled={Boolean(busy || view.confirm)} onClick={() => view.act('file')}>
        {busy === 'file' ? tr('正在预检固件…') : file ? tr('更换固件') : tr('选择固件')}
      </Action>
    </div>
    {!file?.ok && <p className={`text-xs leading-5 ${muted}`}>{platform === 'rk' ? tr('选择 RK 完整固件（update.img）。') : tr('选择 MTK 下载清单（flash.xml），保留配套文件原有目录。')}</p>}
    {restoringFile && !file && <p role="status" className={`flex items-center gap-2 text-xs ${muted}`}>
      <Loader2 size={14} aria-hidden="true" className="shrink-0 animate-spin" />{tr('正在恢复上次固件…')}
    </p>}
    <Feedback view={view} actions={['file', 'copy']} theme={theme} />
    {file && <div role="status" className={`min-w-0 rounded-lg border p-3 ${theme.input}`}>
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words text-sm font-medium">{file.fileName}</p>
          <p className={`mt-0.5 break-words text-xs ${muted}`}>{[Number.isFinite(file.sizeBytes) ? formatBytes(file.sizeBytes) : '', file.chip, file.project].filter(Boolean).join(' · ')}</p>
        </div>
        {file.filePath && <button type="button" className={`grid size-8 shrink-0 place-items-center rounded-md disabled:opacity-50 ${theme.button.secondary}`}
          aria-label={tr('复制固件路径')} title={tr('复制固件路径')} disabled={Boolean(busy)} onClick={() => view.act('copy')}>
          <Copy size={14} aria-hidden="true" />
        </button>}
      </div>
      <p className={`mt-2 text-xs font-medium ${file.ok ? accentText(theme) : warningText(theme)}`}>
        {file.ok ? tr('固件结构检查通过') : tr('固件需要检查')}
      </p>
      <p className={`mt-1 text-xs leading-5 ${muted}`}>{file.ok
        ? quickCheck ? tr('结构检查仅核对文件格式和依赖，不验证固件来源。')
          : tr('结构检查仅核对文件格式和依赖；应用内直刷还需校验整包内容。')
        : file.error || (preflightErrors[file.code] || preflightErrors['file-unavailable'])()}</p>
      {dependencies.length > 0 && <details key={file.firmwareId || file.filePath || file.fileName} open={unavailable.length > 0 || undefined} className="mt-2 border-t border-current/10 pt-2">
        <summary className="cursor-pointer text-xs font-medium">{tr('依赖文件')} · {dependencies.length - unavailable.length}/{dependencies.length}</summary>
        <ul className="mt-2 max-h-40 space-y-1.5 overflow-y-auto">
          {[...unavailable, ...dependencies.filter(item => item.status === 'present')].map((item, index) => (
            <li key={`${item.name}:${index}`} className="flex items-start gap-2 text-xs">
              {item.status === 'present' ? <CheckCircle2 size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-emerald-500" /> : <FileSearch size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-amber-500" />}
              <span className="min-w-0 flex-1 break-all">{item.name}</span>
              {item.status !== 'present' && <span className={`shrink-0 ${warningText(theme)}`}>{tr('不可用')}</span>}
            </li>
          ))}
        </ul>
      </details>}
    </div>}
  </section>;
}

function VendorPanel({ view, theme, direct }) {
  const { status, busy, platform } = view;
  const toolName = status?.tool?.name || (platform === 'rk' ? 'RKDevTool' : 'SP Flash Tool V6');
  return <SupportPanel title={toolName} theme={theme}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <p className={`text-xs leading-5 ${theme.textMuted}`}>{tr('在厂商工具中确认目标与固件后开始写入。')}</p>
        {platform === 'mtk' && <p className={`text-xs leading-5 ${theme.textMuted}`}>
          {tr('使用 USB ADB 时，在 V6 核对固件和下载模式后，先点 Download 等待设备，再对目标设备执行 Loader 重启；识别到设备后可能立即写入。')}
        </p>}
        {!view.checking && !status?.tool?.available && <p className={`text-xs ${warningText(theme)}`}>
          {status?.tool?.code === 'untrusted-package' ? tr('工具文件校验未通过，请使用受支持的工具包。')
            : status?.toolRoot ? tr('未找到厂商工具。') : tr('首次打开时请选择厂商工具所在目录。')}
        </p>}
        {status?.toolRoot && <details className={`min-w-0 rounded-lg border ${theme.input}`}>
          <summary className="flex cursor-pointer items-center gap-2 px-2.5 py-2 text-xs font-medium"><ChevronDown size={14} aria-hidden="true" />{tr('工具目录')}</summary>
          <p className={`break-all px-3 pb-2 text-xs ${theme.textMuted}`}>{status.toolRoot}</p>
        </details>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Action icon={ExternalLink} processing={busy === 'vendor'} className={direct.enabled ? theme.button.secondary : theme.button.primary}
          disabled={Boolean(busy || view.confirm || view.checking)} onClick={() => view.act('vendor')}>{tr('打开厂商工具')}</Action>
      </div>
    </div>
    <div className="mt-2 empty:hidden"><Feedback view={view} actions={['vendor']} theme={theme} /></div>
  </SupportPanel>;
}

export default function FirmwareWorkspace({ theme, active = true, entryDevice }) {
  useLocale();
  const view = useFirmwareWorkspace({ active, entryDevice });
  const direct = useFirmwareDirect({ active, platform: view.platform, firmwareId: view.file?.firmwareId });
  const locked = Boolean(direct.busy || direct.running || direct.globalBusy);
  const stepView = locked && !view.busy ? { ...view, busy: 'direct' } : view;
  const dark = isDarkTheme(theme);
  const platformName = platforms.find(item => item.id === view.platform).label;
  const driverAction = firmwareDriverAction(view.status, view.readError);
  const reinstall = driverAction === 'reinstall';
  const driverActionLabel = reinstall ? tr('重新安装驱动') : tr('安装驱动');
  const driverState = view.readError ? 'unknown' : view.status?.state;
  const supportOpen = view.supportExpanded ?? Boolean(direct.enabled === false || direct.unavailable);
  return <div className={`firmware-workspace min-w-0 space-y-4 ${theme.text}`}>
    <div className={`min-w-0 rounded-xl border p-4 sm:p-5 ${theme.card}`}>
      <div role="group" aria-label={tr('选择刷机平台')} className="grid grid-cols-2 gap-2.5">
        {platforms.map(item => <button key={item.id} type="button" aria-pressed={view.platform === item.id} disabled={Boolean(stepView.busy || view.confirm)}
          className={`min-w-0 rounded-lg border px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-emerald-500 disabled:opacity-70 ${view.platform === item.id ? `border-emerald-500/40 bg-emerald-500/10 ${dark ? 'text-emerald-300' : 'text-emerald-800'}` : theme.input}`}
          onClick={() => view.changePlatform(item.id)}>
          <span className="block text-sm font-semibold">{item.label}</span>
          <span className={`mt-0.5 block break-words text-xs leading-5 ${theme.textMuted}`}>{item.id === 'rk' ? tr('Rockusb 驱动与完整固件') : tr('下载端口驱动与 Download-XML')}</span>
        </button>)}
      </div>
      {entryDevice?.name && <p className={`mt-3 break-words text-xs ${theme.textMuted}`}>{tr('来自设备卡片：{0}', { 0: entryDevice.name })}</p>}
    </div>
    <section className={`min-w-0 rounded-xl border p-4 sm:p-5 ${theme.card}`} aria-labelledby="firmware-workflow-title">
      <h3 id="firmware-workflow-title" className="mb-3 text-sm font-semibold">{tr('刷机操作')}</h3>
      <div className="firmware-steps">
        <PreflightPanel view={stepView} theme={theme}
          quickCheck={view.platform === 'mtk' && (direct.mtkFastReview === true || view.file?.verification?.quickReview === true)} />
        <FirmwareDirectPanel direct={direct} platform={view.platform} theme={theme} file={view.file}
          targetHint={entryDevice?.platformHint && entryDevice.platformHint !== view.platform ? undefined : entryDevice?.targetHint}
          onCopyFirmwarePath={view.file?.filePath ? () => view.act('copy') : undefined}
          onCopyFirmwareFingerprint={() => view.act('copy-fingerprint')}
          onOpenVendor={() => view.act('vendor')}
          onReviewFirmware={async (mode, options) => {
            if (await view.act('review', mode, options)) direct.clearReviewError();
          }}
          reviewPending={view.busy === 'review'}
          reviewFeedback={<Feedback view={view} actions={['review']} theme={theme} />}
          handoffDisabled={Boolean(locked || view.busy || view.confirm || view.checking)}
          handoffFeedback={<Feedback view={view} actions={['vendor', 'copy', 'copy-fingerprint']} theme={theme} />}
          blocked={Boolean(view.busy || view.confirm || direct.globalBusy && !direct.running)} />
      </div>
    </section>
    <details open={supportOpen} className={`group min-w-0 rounded-xl border ${theme.card}`}>
      <summary onClick={event => { event.preventDefault(); view.setSupportExpanded(!supportOpen); }}
        className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 rounded-xl p-4 focus-visible:outline-2 focus-visible:outline-emerald-500">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <ChevronDown size={16} className="-rotate-90 shrink-0 transition-transform group-open:rotate-0" aria-hidden="true" />
          <span className="min-w-0 break-words">{tr('工具、驱动与厂商工具')}</span>
        </span>
        {!direct.running && <span aria-live="polite" className={`text-xs ${driverState === 'missing' || driverState === 'problem' ? warningText(theme) : theme.textMuted}`}>
          {view.busy === 'install' ? tr('正在安装驱动…') : view.checking ? tr('正在检测驱动…') : (drivers[driverState] || drivers.unknown)()}
        </span>}
      </summary>
      <div className="firmware-steps border-t border-current/10 p-4">
        <DriverPanel view={stepView} theme={theme} driverAction={driverAction} driverActionLabel={driverActionLabel} flashing={direct.running} />
        <VendorPanel view={stepView} theme={theme} direct={direct} />
      </div>
    </details>
    <DangerConfirmModal open={view.confirm} theme={theme} tone="warning"
      title={reinstall ? tr('确认重新安装 {0} 驱动', { 0: platformName }) : tr('确认安装 {0} 驱动', { 0: platformName })}
      message={tr('安装需要 Windows 管理员授权，完成后将自动复查。')}
      detail={view.status?.installer?.needsConfirmation ? tr('将打开当前目录中的未签名厂商安装器。请确认工具来源可信。') : undefined}
      confirmLabel={driverActionLabel} onCancel={() => view.setConfirm(false)} onConfirm={() => view.act('install')} />
  </div>;
}
