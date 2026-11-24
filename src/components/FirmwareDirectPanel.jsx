import { useId, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
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
  'flash-completion-unconfirmed': () => tr('写入结果未确认，请检查设备和厂商工具。'),
  'flash-boot-unverified': () => tr('请检查设备能否启动，并核对固件版本。'),
  'flash-wait-expired': () => tr('等待刷机设备超时，可再次开始。'),
};
const errorText = code => Object.hasOwn(errors, code) ? errors[code]() : tr('固件刷机操作未完成，请重试。');

export default function FirmwareDirectPanel({ direct, platform, theme, file, targetHint, blocked }) {
  useLocale();
  const title = useId();
  const [choice, setChoice] = useState(null);
  const { enabled, job, busy, running, error, unavailable } = direct;
  const modes = (direct.modes || []).filter(mode => Object.hasOwn(modeLabels, mode));
  const preferred = choice?.platform === platform ? choice.mode : defaultModes[platform];
  const mode = modes.includes(preferred) ? preferred : modes[0];
  const ready = file?.ok && typeof file.firmwareId === 'string' && file.firmwareId.length > 0;
  const canArm = enabled && ready && mode && !busy && !running && !blocked;
  const status = Object.hasOwn(phaseLabels, job?.phase) ? phaseLabels[job.phase]() : '';
  const percent = Number.isFinite(job?.percent) && job.percent >= 0 && job.percent <= 100 ? Math.trunc(job.percent) : undefined;
  const accent = isDarkTheme(theme) ? 'text-amber-300' : 'text-amber-700';
  const button = 'inline-flex min-h-10 min-w-0 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';
  const available = enabled === true;
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
        {mode && modes.length === 1 && <span className={`rounded-md px-2 py-1 text-xs ${theme.textMuted}`}>{modeLabels[mode]()}</span>}
        {modes.length > 1 && <SelectMenu ariaLabel={tr('刷机模式')} value={mode} isDark={isDarkTheme(theme)}
          disabled={Boolean(busy || blocked)} options={modes.map(value => ({ value, label: modeLabels[value]() }))}
          onChange={value => setChoice({ platform, mode: value })} />}
        <button type="button" disabled={!canArm} className={`${button} ${theme.button.primary}`}
          onClick={() => { if (canArm) void direct.arm({ firmwareId: file.firmwareId, mode, ...(targetHint ? { targetHint } : {}) }); }}>
          {busy ? <Loader2 size={15} className="shrink-0 animate-spin" aria-hidden="true" /> : <Download size={15} className="shrink-0" aria-hidden="true" />}
          {tr('开始刷机')}
        </button>
      </div>}
    </div>
    {mode === 'format-all-download' && available && !running && <p className={`text-xs ${accent}`}>{tr('此模式会清除设备数据，需要单独确认。')}</p>}
    {busy && !status && <p role="status" className={`text-xs ${theme.textMuted}`}>{phaseLabels.preparing()}</p>}
    {status && <div className="space-y-2 border-t border-current/10 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0" role="status">
          <p className="flex items-center gap-2 text-sm font-medium">
            {running && <Loader2 size={15} aria-hidden="true" className="shrink-0 animate-spin text-emerald-500" />}
            {status}
          </p>
          {job.targetLabel && <p className={`mt-0.5 break-words text-xs ${theme.textMuted}`}>{job.targetLabel}</p>}
        </div>
        {cancellableDirectPhases.has(job.phase) && <button type="button" className={`${button} ${theme.button.secondary}`}
          disabled={direct.cancelling} onClick={() => void direct.cancel(job.id)}>{tr('取消')}</button>}
      </div>
      {job.phase === 'waiting' && <p className={`text-xs leading-5 ${theme.textMuted}`}>{tr('请手动让目标设备进入刷机模式。')}</p>}
      {job.phase === 'authorizing' && <p className={`text-xs leading-5 ${theme.textMuted}`}>{tr('如出现 Windows 管理员授权，请手动确认；工具就绪后再让设备进入刷机模式。')}</p>}
      {job.phase === 'armed' && <p className={`text-xs leading-5 ${theme.textMuted}`}>{tr('请手动让目标设备进入刷机模式。')}</p>}
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
      {job.code && (job.phase !== 'cancelled' || job.code === 'flash-wait-expired') && <p className={`text-xs ${job.phase === 'failed' ? accent : theme.textMuted}`}>{errorText(job.code)}</p>}
    </div>}
    {error && <p role="alert" className={`text-xs ${accent}`}>{errorText(error.code)}</p>}
  </section>;
}
