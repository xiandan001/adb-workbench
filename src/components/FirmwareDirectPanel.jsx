import { useId, useState } from 'react';
import { CheckCircle2, ChevronDown, Download, Loader2, TriangleAlert } from 'lucide-react';
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
const firmwareCheckFailed = code => code === 'flash-profile-no-match' || code === 'flash-firmware-content-unverified';
const sessionReviewExpired = code => code === 'flash-firmware-review-required' || code === 'flash-firmware-changed';
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
  failed: job => firmwareCheckFailed(job.code) ? tr('未开始刷机：固件校验未通过') : tr('刷机未完成'),
  cancelled: () => tr('刷机等待已取消'),
};
const preparationLabels = {
  'checking-environment': () => tr('正在检查工具、USB 和磁盘空间…'),
  'staging-firmware': () => tr('正在准备固件文件…'),
};
const writeStageLabels = {
  connecting: () => tr('正在连接刷机设备…'),
  formatting: () => tr('正在格式化设备存储…'),
  finalizing: () => tr('正在完成写入…'),
};
const validPercent = value => Number.isFinite(value) && value >= 0 && value <= 100 ? Math.trunc(value) : undefined;

function writeDetail(job) {
  const partPercent = validPercent(job.partPercent);
  if (Number.isInteger(job.part) && Number.isInteger(job.total) && job.part > 0 && job.part <= job.total) {
    return partPercent === undefined ? tr('当前分区 {0}/{1}', { 0: job.part, 1: job.total })
      : tr('当前分区 {0}/{1} · {2}%', { 0: job.part, 1: job.total, 2: partPercent });
  }
  if (partPercent !== undefined) return tr('当前分区 {0}%', { 0: partPercent });
  const stagePercent = validPercent(job.stagePercent);
  return stagePercent === undefined ? '' : tr('当前阶段 {0}%', { 0: stagePercent });
}
const keepConnectedBeforeReady = () => tr('工具就绪前请保持 USB 连接和供电，不要重启或断电。');
const waitBeforePowerOn = () => tr('等到界面提示等待刷机设备后，再给断电的设备上电。');
const keepSameDevice = () => tr('保持目标设备接在原 USB 口，不要换线或更换设备。');
const waitForAutoPowerOn = () => tr('请保持目标设备断电，等刷机工具提示就绪后再上电。');
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
  'flash-firmware-content-unverified': () => tr('固件结构检查通过，但整包内容与已验收的直刷版本不一致。请选择已验收固件，或使用厂商工具。'),
  'flash-firmware-review-required': () => tr('本次核对已失效，请重新核对固件。'),
  'flash-anchor-required': () => tr('请先用 USB ADB 连接一台受支持的设备，再开始直刷。'),
  'flash-mtk-port-unknown': () => tr('这个 USB 口还没有记录 MTK 下载端口。请先让目标设备进入一次刷机模式，回到 Android 后用同一 USB 口重试。'),
  'flash-mtk-auto-target-present': () => tr('单设备自动直刷要求其他刷机设备先断开，目标设备先断电。'),
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
const errorText = (code, coldStart) => code === 'flash-mtk-port-unknown' && coldStart
  ? tr('未能确认 MTK 下载端口。请只连接这一台设备，保持同一 USB 口，重试等待上电。')
  : Object.hasOwn(errors, code) ? errors[code]() : tr('固件刷机操作未完成，请重试。');

function firmwareMismatchActions({ button, theme, disabled, fingerprint, onCopyPath, onOpenVendor, onCopyFingerprint, feedback }) {
  const action = callback => () => { if (!disabled) void callback(); };
  const style = `${button} ${theme.button.secondary}`;
  return <div data-firmware-mismatch-actions className="space-y-2 border-t border-current/10 pt-2">
    <p>{tr('同一路径重新下载的固件不会继承旧包的直刷验收结果。')}</p>
    {fingerprint && <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>{tr('整包指纹（SHA-256）')}</span>
      <code className="select-text font-mono tabular-nums">{`${fingerprint.slice(0, 12)}…`}</code>
      {typeof onCopyFingerprint === 'function' && <button type="button" disabled={disabled} className={style}
        onClick={action(onCopyFingerprint)}>{tr('复制完整指纹')}</button>}
    </div>}
    {typeof onOpenVendor === 'function' && <p className={theme.textMuted}>
      {tr('请在厂商工具中手动选择当前固件并核对板卡和模式；打开工具不会开始刷机。')}
    </p>}
    <div className="flex flex-wrap gap-2 empty:hidden">
      {typeof onCopyPath === 'function' && <button type="button" disabled={disabled} className={style}
        onClick={action(onCopyPath)}>{tr('复制固件路径')}</button>}
      {typeof onOpenVendor === 'function' && <button type="button" disabled={disabled} className={style}
        onClick={action(onOpenVendor)}>{tr('打开厂商工具')}</button>}
    </div>
    {feedback}
  </div>;
}

export default function FirmwareDirectPanel({ direct, platform, theme, file, targetHint, blocked, onCopyFirmwarePath,
  onOpenVendor, onCopyFirmwareFingerprint, handoffFeedback, handoffDisabled, onReviewFirmware, reviewPending, reviewFeedback }) {
  useLocale();
  const title = useId();
  const [choice, setChoice] = useState(null);
  const [targetChoice, setTargetChoice] = useState(null);
  const [targetDisclosure, setTargetDisclosure] = useState(null);
  const { enabled, job: currentJob, busy, running, error, unavailable, savedTarget, registeringTarget, toolReady, preparingTool, preparingLocalTool } = direct;
  const modes = (direct.modes || []).filter(mode => Object.hasOwn(modeLabels, mode));
  const defaultMode = defaultModes[platform];
  const preferred = choice?.platform === platform ? choice.mode : defaultMode;
  const mode = modes.includes(preferred) ? preferred : modes.includes(defaultMode) ? defaultMode : undefined;
  const fixedMode = modes.length === 1 && modes[0] === defaultMode;
  const ready = file?.ok && typeof file.firmwareId === 'string' && file.firmwareId.length > 0;
  const verification = ready ? file.verification : null;
  const quickPackage = platform === 'mtk' && verification?.phase === 'review-required' && verification.quickReview === true;
  const quickReview = quickPackage || (platform === 'mtk' && direct.mtkFastReview === true && verification?.phase !== 'review-required');
  const sessionReview = quickReview || direct.sessionReviewRequired === true || verification?.phase === 'review-required';
  const dismissedReviewJob = sessionReview && currentJob?.phase === 'failed' && typeof currentJob.id === 'string' && sessionReviewExpired(currentJob.code) &&
    verification?.reviewedJobId === currentJob.id;
  const job = running || (ready && currentJob?.firmwareId === file.firmwareId && !dismissedReviewJob) ? currentJob : null;
  const reviewExpired = sessionReview && (sessionReviewExpired(error?.code) ||
    (job?.phase === 'failed' && sessionReviewExpired(job.code)));
  const reviewed = Boolean(sessionReview && !reviewExpired && mode && verification?.phase === 'review-required' &&
    verification.approvedMode === mode && verification.modes.includes(mode));
  const quickChecked = quickPackage && !reviewExpired && verification.modes.includes(mode);
  const contentCode = 'flash-firmware-content-unverified';
  const verificationMismatch = verification?.phase === 'failed' && verification.code === contentCode;
  const contentMismatch = ready && !running && (job ? job.phase === 'failed' && job.code === contentCode : verificationMismatch);
  const fingerprint = verificationMismatch && typeof verification.fingerprint === 'string' && /^[0-9a-f]{64}$/i.test(verification.fingerprint)
    ? verification.fingerprint : '';
  const modeVerified = verification?.phase === 'passed' && verification.modes.includes(mode);
  const preparation = job?.phase === 'preparing' && job.preparation;
  const preparationLabel = quickPackage && preparation === 'checking-environment' ? phaseLabels.preparing
    : Object.hasOwn(preparationLabels, preparation) ? preparationLabels[preparation] : null;
  const writing = job?.phase === 'writing';
  const verifying = job?.phase === 'verifying';
  const mtkWritten = platform === 'mtk' && job?.phase === 'written' && !job.code;
  const writeStage = writing && Object.hasOwn(writeStageLabels, job.progressStage) ? writeStageLabels[job.progressStage]() : '';
  const status = mtkWritten ? tr('固件写入成功') : writeStage || (preparationLabel ? preparationLabel()
    : Object.hasOwn(phaseLabels, job?.phase) ? phaseLabels[job.phase](job) : '');
  const percent = verifying ? 100 : validPercent(job?.percent);
  const preparationPercent = validPercent(job?.preparationPercent);
  const writeStatus = platform === 'mtk' && writing ? writeDetail(job) : '';
  const stepPercent = writeStatus ? validPercent(job.partPercent) ?? validPercent(job.stagePercent) : undefined;
  const meterPercent = percent ?? stepPercent;
  const dark = isDarkTheme(theme);
  const accent = dark ? 'text-amber-300' : 'text-amber-700';
  const button = 'inline-flex min-h-10 min-w-0 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';
  const available = enabled === true;
  const formatsStorage = mode === 'format-all-download';
  const modeRisk = available && !running && (formatsStorage
    ? tr('格式化后下载会先清除存储，可能影响设备配置和校准数据。')
    : mode === 'firmware-upgrade' ? tr('固件升级可能改写分区并清除数据，请先备份。') : null);
  const modeRiskId = `${title}-mode-risk`;
  const autoPowerOn = platform === 'mtk' && direct.mtkAutoPowerOn === true;
  const autoJob = platform === 'mtk' && job?.autoPowerOn === true;
  const entryButtonVisible = job?.phase === 'armed' && !autoJob && !job.coldStart && job.entryAvailable && typeof direct.enterLoader === 'function';
  const entryBlocked = Boolean(busy || blocked || job?.entryRequested);
  const savedLabel = savedTarget?.label ? [savedTarget.label, savedTarget.port].filter(Boolean).join(' · ') : '';
  const targetOptions = [
    ...(savedLabel ? [{ value: 'saved', label: tr('使用已保存的 USB 目标（设备可未连接）') }] : []),
    { value: 'connected', label: tr('当前 USB 设备') },
    { value: 'cold', label: autoPowerOn ? tr('单设备上电自动刷机（无需 ADB 或登记）') : tr('等待设备上电（无需 ADB 或登记）') },
  ];
  const targetContext = JSON.stringify([platform, targetHint || null]);
  const defaultTarget = targetHint ? 'connected' : savedLabel ? 'saved' : 'cold';
  const preferredTarget = targetChoice?.context === targetContext ? targetChoice.value : defaultTarget;
  const selectedTarget = targetOptions.find(option => option.value === preferredTarget) || targetOptions.find(option => option.value === defaultTarget);
  const coldTarget = selectedTarget.value === 'cold';
  const autoTarget = coldTarget && autoPowerOn;
  const target = selectedTarget.value === 'saved' ? { useSavedTarget: true } :
    coldTarget ? { coldStart: true } : targetHint ? { targetHint } : {};
  const coldJob = job?.coldStart === true;
  const selectTarget = value => {
    setTargetChoice({ context: targetContext, value });
    setTargetDisclosure(null);
  };
  const optionsOpen = targetDisclosure === targetContext;
  const targetBlocked = Boolean(busy || blocked);
  const needsTool = toolReady === false;
  const canArm = Boolean(enabled && ready && mode && !running && !targetBlocked && !needsTool && !contentMismatch &&
    (sessionReview ? reviewed || quickChecked : !verification || modeVerified));
  const showReview = sessionReview && ready && !contentMismatch && (quickReview
    ? verification?.phase !== 'checking' && (!quickPackage || reviewExpired)
    : !reviewed);
  const canReview = Boolean(showReview && !targetBlocked && mode && typeof onReviewFirmware === 'function' &&
    verification?.phase !== 'checking' && (reviewExpired || !verification || verification.phase === 'passed' ||
      (verification.phase === 'review-required' && verification.modes.includes(mode)) ||
      (verification.phase === 'failed' && !firmwareCheckFailed(verification.code))));
  const mismatchActions = contentMismatch ? firmwareMismatchActions({
    button, theme, disabled: targetBlocked || handoffDisabled, fingerprint,
    onCopyPath: typeof file.filePath === 'string' && file.filePath ? onCopyFirmwarePath : undefined, onOpenVendor,
    onCopyFingerprint: onCopyFirmwareFingerprint, feedback: handoffFeedback,
  }) : null;
  const optionsId = `${title}-target-options`;
  const mismatch = (error ? error.code : job?.code) === 'flash-platform-mismatch';
  const registerAction = direct.registerTarget && <button type="button" disabled={targetBlocked}
    aria-busy={registeringTarget} className={`${button} ${theme.button.secondary}`} onClick={() => {
      if (targetBlocked) return;
      void direct.registerTarget();
    }}>
    {registeringTarget && <Loader2 size={14} aria-hidden="true" className="shrink-0 animate-spin" />}
    {tr('登记当前 USB 目标')}
  </button>;
  return <section className={`min-w-0 space-y-3 self-start rounded-lg border p-3 ${theme.input}`} aria-labelledby={title}>
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
        {showReview && <button type="button" disabled={!canReview} aria-busy={Boolean(reviewPending)}
          aria-describedby={modeRisk ? modeRiskId : undefined}
          className={`${button} ${theme.button.secondary}`} onClick={() => {
            if (canReview) void onReviewFirmware(mode, { refresh: reviewExpired, jobId: job?.id, ...(quickReview ? { checkOnly: true } : {}) });
          }}>
          {reviewPending && <Loader2 size={15} aria-hidden="true" className="shrink-0 animate-spin" />}
          {quickReview ? reviewExpired ? tr('重新检查固件') : tr('检查固件') : tr('核对本次固件')}
        </button>}
        {needsTool ? <>
          <button type="button" disabled={targetBlocked || !direct.prepareTool} aria-busy={preparingTool && !preparingLocalTool}
            className={`${button} ${theme.button.primary}`} onClick={() => { if (!targetBlocked) void direct.prepareTool?.(); }}>
            {preparingTool && !preparingLocalTool && <Loader2 size={15} className="shrink-0 animate-spin" aria-hidden="true" />}
            {platform === 'rk' ? tr('下载 RK 直刷工具') : tr('准备刷机工具')}
          </button>
          {platform === 'rk' && direct.prepareTool && <button type="button" disabled={targetBlocked} aria-busy={preparingLocalTool}
            className={`${button} ${theme.button.secondary}`} onClick={() => { if (!targetBlocked) void direct.prepareTool({ local: true }); }}>
            {preparingLocalTool && <Loader2 size={15} className="shrink-0 animate-spin" aria-hidden="true" />}
            {tr('选择本机工具')}
          </button>}
        </> : <button type="button" disabled={!canArm} className={`${button} ${theme.button.primary}`}
          aria-describedby={modeRisk ? modeRiskId : undefined}
          onClick={() => {
            if (!canArm) return;
            void direct.arm({ firmwareId: file.firmwareId, mode, ...target });
          }}>
          {busy && !registeringTarget ? <Loader2 size={15} className="shrink-0 animate-spin" aria-hidden="true" /> : <Download size={15} className="shrink-0" aria-hidden="true" />}
          {autoTarget ? tr('准备上电自动刷机') : coldTarget ? tr('等待设备上电') : tr('开始刷机')}
        </button>}
      </div>}
    </div>
    {!running && ((!job && verification) || (sessionReview && ready)) && <div data-firmware-verification={verification?.phase || 'review-pending'}
      role={verification?.phase === 'failed' ? 'alert' : 'status'} className={`space-y-1 break-words rounded-md border border-current/10 px-2.5 py-2 text-xs leading-5 ${verification?.phase === 'failed' ? accent : theme.textMuted}`}>
      {verification?.phase === 'checking' && <p className="flex items-start gap-2">
        <Loader2 size={14} aria-hidden="true" className="mt-0.5 shrink-0 animate-spin text-emerald-500" />
        {quickReview ? tr('正在检查固件及依赖文件，尚未写入设备。') : tr('正在重新校验整包固件，尚未写入设备。')}
      </p>}
      {!sessionReview && verification?.phase === 'passed' && <>
        <p>{tr('当前固件已通过整包校验。开始刷机前还会再次核对。')}</p>
        {mode && !modeVerified && <p className={accent}>{tr('该固件不支持当前选择的直刷模式。请选择已验收的模式。')}</p>}
      </>}
      {sessionReview && verification?.phase !== 'checking' && verification?.phase !== 'failed' && <>
        {reviewExpired && <p className={accent}>{quickReview ? tr('固件检查已失效，请重新检查。') : tr('本次核对已失效，请重新核对固件。')}</p>}
        {verification?.phase === 'review-required' && <>
          <p>{quickPackage ? tr('固件结构及依赖已检查，刷机前仍需确认固件来源、板卡和模式。')
            : reviewed ? tr('已确认本次固件及刷机模式。开始刷机前还会再次核对。')
              : tr('当前固件已通过整包校验，请核对本次使用的板卡和模式。')}</p>
          <p>{tr('目标板卡：{0}', { 0: verification.board })}</p>
          {mode && <p><span className="me-2">{tr('刷机模式')}</span>{modeLabels[mode]()}</p>}
          {!quickPackage && <p><span className="me-2">{tr('整包指纹（SHA-256）')}</span>
            <code className="select-text font-mono tabular-nums">{`${verification.fingerprint.slice(0, 12)}…`}</code>
          </p>}
          {mode && !verification.modes.includes(mode) && <p className={accent}>{quickPackage
            ? tr('所选刷机模式不适用于当前固件。') : tr('该固件不支持当前选择的直刷模式。请选择已验收的模式。')}</p>}
        </>}
        {!quickReview && <p>{tr('核对仅对当前固件和所选模式有效，不会保存为永久验收。')}</p>}
      </>}
      {verification?.phase === 'failed' && <>
        <p className="font-medium">{tr('未开始刷机：固件校验未通过')}</p>
        <p>{errorText(Object.hasOwn(errors, verification.code) ? verification.code : 'flash-firmware-read-failed', coldTarget)}</p>
        {mismatchActions}
      </>}
      {sessionReview && reviewFeedback}
    </div>}
    {available && !running && <div className="space-y-2 border-t border-current/10 pt-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 break-words text-xs">
          <span className={`${theme.textMuted} me-2`}>{tr('刷机目标')}</span>
          <span className="font-medium">{selectedTarget.value === 'saved' ? savedLabel : selectedTarget.label}</span>
        </p>
        <div className="flex flex-wrap gap-2">
          {!coldTarget && <button type="button" disabled={targetBlocked} className={`${button} ${theme.button.secondary}`}
            onClick={() => { if (!targetBlocked) selectTarget('cold'); }}>{tr('改为等待上电')}</button>}
          {!autoTarget && !savedLabel && registerAction}
          {targetOptions.length > 1 && <button type="button" disabled={targetBlocked} aria-controls={optionsId} aria-expanded={optionsOpen}
            className={`${button} ${theme.button.secondary}`} onClick={() => setTargetDisclosure(optionsOpen ? null : targetContext)}>
            {tr('更换目标')}
            <ChevronDown aria-hidden="true" size={14} className={optionsOpen ? 'rotate-180' : ''} />
          </button>}
        </div>
      </div>
      {optionsOpen && <div id={optionsId} className="flex flex-wrap items-center gap-2">
        <SelectMenu ariaLabel={tr('刷机目标')} value={selectedTarget.value} isDark={dark} compact options={targetOptions}
          disabled={targetBlocked} onChange={selectTarget} />
        {(savedLabel || autoTarget) && registerAction}
      </div>}
      {autoTarget && <div role="status" className={`space-y-1 rounded-md border border-amber-500/20 bg-amber-500/5 px-2.5 py-2 text-xs leading-5 ${accent}`}>
        {showReview && !quickReview && <p className="font-medium">{tr('尚未开始等待上电，请先核对本次固件。')}</p>}
        <p>{tr('不需要预先识别 COM 端口。只连接一台待刷设备，并保持断电。')}</p>
      </div>}
      {!autoTarget && !savedLabel && registerAction && <p className={`text-xs leading-5 ${theme.textMuted}`}>
        {tr('先通过 USB 调试连接目标设备，再登记。之后可在设备未连接时使用已保存的目标。')}
      </p>}
    </div>}
    {modeRisk && <p id={modeRiskId} role="status" className={`flex items-start gap-2 rounded-md px-2.5 py-2 text-xs leading-5 ${formatsStorage
      ? `bg-red-500/10 ${dark ? 'text-red-300' : 'text-red-800'}` : `bg-amber-500/10 ${accent}`}`}>
      <TriangleAlert size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
      {modeRisk}
    </p>}
    {busy && !registeringTarget && !preparingTool && !status && <div role="status" className={`space-y-1 text-xs ${theme.textMuted}`}>
      <p>{phaseLabels.preparing()}</p>
      <p className={accent}>{autoTarget ? waitForAutoPowerOn() : coldTarget ? waitBeforePowerOn() : keepConnectedBeforeReady()}</p>
    </div>}
    {status && <div className="space-y-2 border-t border-current/10 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0" role="status">
          <p className={`flex items-center gap-2 text-sm font-medium ${mtkWritten ? (dark ? 'text-emerald-300' : 'text-emerald-700') : ''}`}>
            {running && <Loader2 size={15} aria-hidden="true" className="shrink-0 animate-spin text-emerald-500" />}
            {mtkWritten && <CheckCircle2 size={15} aria-hidden="true" className="shrink-0" />}
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
      {(['preparing', 'confirming', 'authorizing'].includes(job.phase) || autoJob && job.phase === 'waiting') && <p className={`text-xs leading-5 ${accent}`}>
        {autoJob ? waitForAutoPowerOn() : coldJob ? (job.phase === 'preparing' ? waitBeforePowerOn() : keepSameDevice()) : keepConnectedBeforeReady()}
      </p>}
      {preparation === 'staging-firmware' && <>
        <progress className="h-2 w-full accent-cyan-500" max={100} value={preparationPercent} aria-label={tr('固件准备进度')} />
        <p className={`flex flex-wrap justify-between gap-2 text-xs ${theme.textMuted}`}>
          <span>{tr('正在准备文件，尚未写入设备。')}</span>
          {preparationPercent !== undefined && <span>{preparationPercent}%</span>}
        </p>
      </>}
      {job.phase === 'waiting' && !autoJob && <p className={`text-xs leading-5 ${theme.textMuted}`}>
        {platform === 'rk' ? (job.coldStart
          ? tr('按板卡要求断电上电或长按电源键进入 Loader / Maskrom，识别后选定目标。')
          : tr('保持同一 USB 口，按板卡要求断电上电或长按电源键进入 Loader / Maskrom。'))
          : coldJob ? tr('只连接一台待刷设备，连接 Touch 线后给目标设备上电进入 Download；识别后选定目标。')
            : tr('请手动让目标设备进入刷机模式。')}
      </p>}
      {job.phase === 'authorizing' && <p className={`text-xs leading-5 ${theme.textMuted}`}>{tr('如出现 Windows 管理员授权，请手动确认；工具就绪后再让设备进入刷机模式。')}</p>}
      {job.phase === 'armed' && autoJob && <div role="status" className={`space-y-1 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-2 text-xs leading-5 ${dark ? 'text-emerald-300' : 'text-emerald-700'}`}>
        <p className="font-semibold">{tr('现在给设备上电，工具识别到下载端口后会自动开始刷机。')}</p>
        <p>{tr('只连接这台待刷设备，不要更换 USB 口或连接其他刷机设备。')}</p>
      </div>}
      {job.phase === 'armed' && !autoJob && <div role="status" className={`space-y-1 text-xs leading-5 ${theme.textMuted}`}>
        <p>{job.entryRequested ? tr('已请求进入刷机模式，正在等待设备出现。') : platform === 'mtk'
          ? coldJob ? tr('工具已就绪，正在等待选定设备的下载端口。')
            : tr('工具就绪后，将 Touch 线接到已登记的电脑 USB 口，再给目标设备断电上电。')
          : tr('请按设备说明手动进入刷机模式。')}</p>
        {platform === 'mtk' && coldJob && <p>{tr('若下载端口已消失，请保持同一台设备和同一个 USB 口，断电后重新上电。')}</p>}
        {!job.entryRequested && entryButtonVisible && <p>{tr('也可点击「进入刷机模式」，无需手动重启设备。')}</p>}
        {job.entryRequested && <p>{keepSameDevice()}</p>}
      </div>}
      {job.phase === 'choice-required' &&
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
      {(writing || verifying) && <>
        <div className="firmware-write-meter" data-indeterminate={meterPercent === undefined || undefined}>
          <progress max={100} value={meterPercent} aria-label={percent === undefined && stepPercent !== undefined ? writeStatus : tr('刷机进度')} />
        </div>
        <div className={`flex flex-wrap items-start justify-between gap-2 text-xs ${theme.textMuted}`}>
          <span>{writeStatus}</span>
          {percent !== undefined && <span className="ms-auto font-medium tabular-nums">{percent}%</span>}
          {writing && meterPercent === undefined && <span>{tr('工具未报告准确总进度，正在写入…')}</span>}
        </div>
        <p className={`text-xs ${accent}`}>{writing ? tr('写入期间请保持 USB 连接和供电。')
          : keepSameDevice()}</p>
      </>}
      {job.code && job.code !== 'flash-platform-mismatch' && (job.phase !== 'cancelled' || job.code === 'flash-wait-expired') &&
        <p role={firmwareCheckFailed(job.code) ? 'alert' : undefined}
          className={`break-words text-xs leading-5 ${job.phase === 'failed' ? accent : theme.textMuted}`}>{errorText(job.code, coldJob)}</p>}
      {mismatchActions}
    </div>}
    {mismatch ? <p role="alert" className={`flex items-start gap-2 rounded-md bg-amber-500/10 px-2.5 py-2 text-xs leading-5 ${accent}`}>
      <TriangleAlert size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
      {errors['flash-platform-mismatch']()}
    </p> : error && <p role="alert" className={`text-xs ${accent}`}>{errorText(error.code, coldTarget)}</p>}
  </section>;
}
