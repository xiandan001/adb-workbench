import { useId, useState } from 'react';
import { Download, Loader2, TriangleAlert } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';
import { isDarkTheme } from '../shared/theme.js';
import SelectMenu from './SelectMenu.jsx';

import { cancellableDirectPhases } from './FirmwareDirectState.js';

const defaultModes = { rk: 'upgrade', mtk: 'download-only' };
const modeLabels = {
  upgrade: () => tr('整包升级'),
  'download-only': () => tr('仅下载'),
  'firmware-upgrade': () => tr('固件升级'),
  'format-all-download': () => tr('格式化后下载'),
};
const phaseLabels = {
  preparing: () => tr('正在核对刷机固件…'),
  confirming: () => tr('等待确认本次刷机'),
  waiting: () => tr('等待刷机设备'),
  'choice-required': () => tr('请选择要刷写的设备'),
  checking: () => tr('正在复查刷机目标…'),
  authorizing: () => tr('正在启动 MTK 刷机工具…'),
  armed: () => tr('刷机工具已就绪'),
  writing: () => tr('正在写入固件…'),
  verifying: () => tr('正在验证刷机结果…'),
  written: () => tr('固件已写入，设备启动未验证'),
  verified: () => tr('刷机已完成并验证'),
  failed: () => tr('刷机未完成'),
  cancelled: () => tr('刷机等待已取消'),
};
const preparationLabels = {
  'checking-environment': () => tr('正在检查工具、USB 和磁盘空间…'),
  'staging-firmware': () => tr('正在准备固件文件…'),
};
const keepConnectedBeforeReady = () => tr('工具就绪前请保持 USB 连接和供电，不要重启或断电。');
const errors = {
  'flash-profile-unverified': () => tr('此平台尚未开放直刷，请使用厂商工具。'),
  'flash-busy': () => tr('已有刷机任务在运行。'),
  'flash-firmware-unavailable': () => tr('请重新选择并预检固件。'),
  'flash-tool-unavailable': () => tr('未找到可用的直刷工具，请检查厂商工具。'),
  'flash-usb-unavailable': () => tr('无法读取刷机 USB 状态，请检查设备连接。'),
  'flash-plan-changed': () => tr('设备或固件已变化，请重新核对后开始。'),
  'flash-target-unavailable': () => tr('无法确认原目标，请检查连接并重试。'),
  'flash-no-compatible-target': () => tr('未识别到与固件匹配的刷机设备。'),
  'flash-profile-no-match': () => tr('该固件尚未完成应用内直刷验收，可使用厂商工具。'),
  'flash-anchor-required': () => tr('请先用 USB ADB 连接一台受支持的设备，再开始直刷。'),
  'flash-mtk-port-unknown': () => tr('这个 USB 口还没有记录 MTK 下载端口。请先让目标设备进入一次刷机模式，回到 Android 后用同一 USB 口重试。'),
  'flash-rk-storage-unverified': () => tr('未能核实 RK 芯片或存储。请检查驱动和 USB 连接后重试。'),
  'flash-vendor-busy': () => tr('厂商刷机工具仍在运行。请等待现有任务结束并关闭工具。'),
  'flash-mode-mismatch': () => tr('刷机工具执行模式与所选模式不一致，未确认刷写结果。'),
  'flash-loader-request-failed': () => tr('暂时无法进入刷机模式，请检查目标设备的 USB 调试连接。'),
  'flash-firmware-missing-files': () => tr('固件缺少配套文件，请解压完整固件包后重新选择。'),
  'flash-firmware-space': () => tr('准备固件所需的磁盘空间不足，请释放空间后重试。'),
  'flash-firmware-read-failed': () => tr('无法读取固件，请检查文件是否可读，或复制到本机后重试。'),
  'flash-firmware-changed': () => tr('固件文件已变化，请重新选择并预检。'),
  'flash-platform-mismatch': () => tr('当前选择与固件或设备的刷机平台不匹配，未启动写入。'),
  'flash-completion-unconfirmed': () => tr('写入结果未确认，请检查设备和厂商工具。'),
  'flash-boot-unverified': () => tr('请检查设备能否启动，并核对固件版本。'),
  'flash-wait-expired': () => tr('等待刷机设备超时，可再次开始。'),
};
const errorText = code => Object.hasOwn(errors, code) ? errors[code]() : tr('固件刷机操作未完成，请重试。');

export default function FirmwareDirectPanel({ direct, platform, theme, file, targetHint, blocked }) {
  useLocale();
  const title = useId();
  const [choice, setChoice] = useState(null);
  const [savedTargetChoice, setSavedTargetChoice] = useState(null);
  const [rkColdStart, setRkColdStart] = useState(false);
  const { enabled, job, busy, running, error, unavailable, savedTarget, registeringTarget } = direct;
  const modes = (direct.modes || []).filter(mode => Object.hasOwn(modeLabels, mode));
  const defaultMode = defaultModes[platform];
  const preferred = choice?.platform === platform ? choice.mode : defaultMode;
  const mode = modes.includes(preferred) ? preferred : modes.includes(defaultMode) ? defaultMode : undefined;
  const fixedMode = modes.length === 1 && modes[0] === defaultMode;
  const ready = file?.ok && typeof file.firmwareId === 'string' && file.firmwareId.length > 0;
  const preparation = job?.phase === 'preparing' && job.preparation;
  const status = Object.hasOwn(preparationLabels, preparation) ? preparationLabels[preparation]()
    : Object.hasOwn(phaseLabels, job?.phase) ? phaseLabels[job.phase]() : '';
  const percent = Number.isFinite(job?.percent) && job.percent >= 0 && job.percent <= 100 ? Math.trunc(job.percent) : undefined;
  const preparationPercent = Number.isFinite(job?.preparationPercent) && job.preparationPercent >= 0 && job.preparationPercent <= 100
    ? Math.trunc(job.preparationPercent) : undefined;
  const dark = isDarkTheme(theme);
  const accent = dark ? 'text-amber-300' : 'text-amber-700';
  const button = 'inline-flex min-h-10 min-w-0 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';
  const available = enabled === true;
  const formatsStorage = mode === 'format-all-download';
  const modeRisk = available && !running && (formatsStorage
    ? tr('格式化后下载会先清除存储，可能影响设备配置和校准数据。')
    : mode === 'firmware-upgrade' ? tr('固件升级可能改写分区并清除数据，请先备份。') : null);
  const modeRiskId = `${title}-mode-risk`;
  const entryButtonVisible = job?.phase === 'armed' && job.entryAvailable && typeof direct.enterLoader === 'function';
  const entryBlocked = Boolean(busy || blocked || job?.entryRequested);
  const savedTargetKey = savedTarget?.label ? JSON.stringify([platform, savedTarget.label, savedTarget.port]) : null;
  const useSavedTarget = Boolean(savedTargetKey && savedTargetChoice === savedTargetKey);
  const coldStart = platform === 'rk' && rkColdStart && !useSavedTarget;
  const target = useSavedTarget ? { useSavedTarget: true } : coldStart ? { coldStart: true } : targetHint ? { targetHint } : {};
  const targetBlocked = Boolean(busy || blocked);
  const canArm = Boolean(enabled && ready && mode && !running && !targetBlocked);
  const mismatch = (error ? error.code : job?.code) === 'flash-platform-mismatch';
  return <section className={`mb-4 min-w-0 space-y-3 rounded-lg border p-3 ${theme.input}`} aria-labelledby={title}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h4 id={title} className="text-sm font-semibold">{tr('应用内直刷')}</h4>
        {!available && <p className={`mt-1 text-xs leading-5 ${theme.textMuted}`}>
          {enabled === false || unavailable ? errors['flash-profile-unverified']() : !error && tr('正在检查直刷支持…')}
        </p>}
        {available && !ready && !job && <p className={`mt-1 text-xs ${theme.textMuted}`}>{errors['flash-firmware-unavailable']()}</p>}
      </div>
      {available && !running && <div className="flex max-w-full flex-wrap items-center gap-2">
        {fixedMode && <span className={`rounded-md px-2 py-1 text-xs ${theme.textMuted}`}>{modeLabels[mode]()}</span>}
        {!fixedMode && modes.length > 0 && <SelectMenu ariaLabel={tr('刷机模式')} value={mode} isDark={dark}
          disabled={Boolean(busy || blocked)} options={modes.map(value => ({ value, label: modeLabels[value]() }))}
          onChange={value => setChoice({ platform, mode: value })} />}
        <button type="button" disabled={!canArm} className={`${button} ${theme.button.primary}`}
          aria-describedby={modeRisk ? modeRiskId : undefined}
          onClick={() => {
            if (!canArm) return;
            void direct.arm({ firmwareId: file.firmwareId, mode, ...target });
          }}>
          {busy && !registeringTarget ? <Loader2 size={15} className="shrink-0 animate-spin" aria-hidden="true" /> : <Download size={15} className="shrink-0" aria-hidden="true" />}
          {tr('开始刷机')}
        </button>
      </div>}
    </div>
    {available && !running && direct.registerTarget && <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <button type="button" disabled={targetBlocked} aria-busy={registeringTarget} className={`${button} ${theme.button.secondary}`}
        onClick={() => {
          if (targetBlocked) return;
          setSavedTargetChoice(null);
          if (platform === 'rk') setRkColdStart(false);
          void direct.registerTarget();
        }}>
        {registeringTarget && <Loader2 size={14} aria-hidden="true" className="shrink-0 animate-spin" />}
        {tr('登记当前 USB 目标')}
      </button>
      <p className={`min-w-0 text-xs leading-5 ${theme.textMuted}`}>
        {tr('先通过 USB 调试连接目标设备，再登记。之后可在设备未连接时使用已保存的目标。')}
      </p>
    </div>}
    {available && !running && savedTargetKey && <label className="flex w-fit max-w-full items-start gap-2 text-xs leading-5">
      <input type="checkbox" checked={useSavedTarget} disabled={targetBlocked}
        className="mt-1 shrink-0 accent-emerald-500"
        onChange={event => {
          if (event.currentTarget.checked && platform === 'rk') setRkColdStart(false);
          setSavedTargetChoice(event.currentTarget.checked ? savedTargetKey : null);
        }} />
      <span className="min-w-0">
        <span className="block font-medium">{tr('使用已保存的 USB 目标（设备可未连接）')}</span>
        <span className={`block break-words ${theme.textMuted}`}>{[savedTarget.label, savedTarget.port].filter(Boolean).join(' · ')}</span>
      </span>
    </label>}
    {available && !running && platform === 'rk' && <label className="flex w-fit max-w-full items-start gap-2 text-xs leading-5">
      <input type="checkbox" checked={coldStart} disabled={targetBlocked} className="mt-1 shrink-0 accent-emerald-500"
        onChange={event => {
          if (event.currentTarget.checked) setSavedTargetChoice(null);
          setRkColdStart(event.currentTarget.checked);
        }} />
      <span>{tr('未登记的 RK 板卡（无需 ADB，识别后手动选择）')}</span>
    </label>}
    {modeRisk && <p id={modeRiskId} role="status" className={`flex items-start gap-2 rounded-md px-2.5 py-2 text-xs leading-5 ${formatsStorage
      ? `bg-red-500/10 ${dark ? 'text-red-300' : 'text-red-800'}` : `bg-amber-500/10 ${accent}`}`}>
      <TriangleAlert size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
      {modeRisk}
    </p>}
    {busy && !registeringTarget && !status && <div role="status" className={`space-y-1 text-xs ${theme.textMuted}`}>
      <p>{phaseLabels.preparing()}</p>
      <p className={accent}>{keepConnectedBeforeReady()}</p>
    </div>}
    {status && <div className="space-y-2 border-t border-current/10 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0" role="status">
          <p className="flex items-center gap-2 text-sm font-medium">
            {running && <Loader2 size={15} aria-hidden="true" className="shrink-0 animate-spin text-emerald-500" />}
            {status}
          </p>
          {job.targetLabel && <p className={`mt-0.5 break-words text-xs ${theme.textMuted}`}>{job.targetLabel}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {entryButtonVisible && <button type="button" className={`${button} ${theme.button.primary}`} disabled={entryBlocked}
            onClick={() => { if (!entryBlocked) void direct.enterLoader(job.id); }}>{tr('进入刷机模式')}</button>}
          {cancellableDirectPhases.has(job.phase) && <button type="button" className={`${button} ${theme.button.secondary}`}
            disabled={direct.cancelling} onClick={() => void direct.cancel(job.id)}>{tr('取消')}</button>}
        </div>
      </div>
      {['preparing', 'confirming', 'authorizing'].includes(job.phase) && <p className={`text-xs leading-5 ${accent}`}>{keepConnectedBeforeReady()}</p>}
      {preparation === 'staging-firmware' && <>
        <progress className="h-2 w-full accent-cyan-500" max={100} value={preparationPercent} aria-label={tr('固件准备进度')} />
        <p className={`flex flex-wrap justify-between gap-2 text-xs ${theme.textMuted}`}>
          <span>{tr('正在准备文件，尚未写入设备。')}</span>
          {preparationPercent !== undefined && <span>{preparationPercent}%</span>}
        </p>
      </>}
      {job.phase === 'waiting' && <p className={`text-xs leading-5 ${theme.textMuted}`}>
        {platform === 'rk' ? (job.coldStart
          ? tr('按板卡要求断电上电或长按电源键进入 Loader / Maskrom，识别后选定目标。')
          : tr('保持同一 USB 口，按板卡要求断电上电或长按电源键进入 Loader / Maskrom。'))
          : tr('请手动让目标设备进入刷机模式。')}
      </p>}
      {job.phase === 'authorizing' && <p className={`text-xs leading-5 ${theme.textMuted}`}>{tr('如出现 Windows 管理员授权，请手动确认；工具就绪后再让设备进入刷机模式。')}</p>}
      {job.phase === 'armed' && <div role="status" className={`space-y-1 text-xs leading-5 ${theme.textMuted}`}>
        <p>{job.entryRequested ? tr('已请求进入刷机模式，正在等待设备出现。') : platform === 'mtk'
          ? tr('工具就绪后，将 Touch 线接到已登记的电脑 USB 口，再给目标设备断电上电。') : tr('请按设备说明手动进入刷机模式。')}</p>
        {!job.entryRequested && entryButtonVisible && <p>{tr('也可点击「进入刷机模式」，无需手动重启设备。')}</p>}
        {job.entryRequested && <p>{tr('保持目标设备接在原 USB 口，不要换线或更换设备。')}</p>}
      </div>}
      {job.phase === 'choice-required' && platform === 'rk' && job.coldStart &&
        <p className={`text-xs leading-5 ${theme.textMuted}`}>{tr('请核对板卡后选择；选定目标并确认前不会写入。')}</p>}
      {job.phase === 'choice-required' && <ul className="max-h-48 space-y-2 overflow-y-auto">
        {(job.candidates || []).map(candidate => <li key={candidate.id}>
          <button type="button" className={`${button} w-full justify-start text-left ${theme.button.secondary}`} disabled={busy}
            onClick={() => void direct.choose({ jobId: job.id, targetId: candidate.id })}>
            <span className="min-w-0">
              <span className="block break-words">{candidate.label}</span>
              {candidate.details && <span className={`block break-words text-xs ${theme.textMuted}`}>{candidate.details}</span>}
            </span>
          </button>
        </li>)}
      </ul>}
      {job.phase === 'writing' && <>
        <progress className="h-2 w-full accent-emerald-500" max={100} value={percent} aria-label={tr('刷机进度')} />
        {percent !== undefined && <p className={`text-right text-xs ${theme.textMuted}`}>{percent}%</p>}
        <p className={`text-xs ${accent}`}>{tr('写入期间请保持 USB 连接和供电。')}</p>
      </>}
      {job.code && job.code !== 'flash-platform-mismatch' && (job.phase !== 'cancelled' || job.code === 'flash-wait-expired') &&
        <p className={`text-xs ${job.phase === 'failed' ? accent : theme.textMuted}`}>{errorText(job.code)}</p>}
    </div>}
    {mismatch ? <p role="alert" className={`flex items-start gap-2 rounded-md bg-amber-500/10 px-2.5 py-2 text-xs leading-5 ${accent}`}>
      <TriangleAlert size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
      {errors['flash-platform-mismatch']()}
    </p> : error && <p role="alert" className={`text-xs ${accent}`}>{errorText(error.code)}</p>}
  </section>;
}
