import { useCallback, useEffect, useRef, useState } from 'react';
import { tr } from '../shared/i18n.js';

const platformKey = 'firmware-workspace-platform';
const toolsExpandedKey = 'firmware-workspace-tools-expanded';
const isPlatform = value => value === 'rk' || value === 'mtk';
const fingerprintOf = result => typeof result?.fingerprint === 'string' &&
  /^[a-f0-9]{64}$/i.test(result.fingerprint) ? result.fingerprint.toLowerCase() : '';
const contentFingerprint = result => result?.code === 'flash-firmware-content-unverified' ? fingerprintOf(result) : '';
const reviewModes = {
  rk: new Set(['upgrade']),
  mtk: new Set(['download-only', 'firmware-upgrade', 'format-all-download']),
};
const reviewExpired = code => code === 'flash-firmware-changed' || code === 'flash-firmware-review-required';

export function readFirmwarePlatform(storage = globalThis.localStorage) {
  try { return storage?.getItem(platformKey) === 'mtk' ? 'mtk' : 'rk'; }
  catch { return 'rk'; }
}

function readSupportExpanded() {
  try {
    const remembered = globalThis.localStorage?.getItem(toolsExpandedKey);
    return remembered === 'true' ? true : remembered === 'false' ? false : undefined;
  } catch { return undefined; }
}

export function resolveFirmwarePlatform(selection, entryDevice) {
  if (entryDevice?.requestId !== selection.requestId && isPlatform(entryDevice?.platformHint)) {
    return entryDevice.platformHint;
  }
  return selection.platform;
}

export function firmwareDriverAction(status, readError) {
  if (readError || !(status?.installer?.available || status?.installer?.canChoose)) return null;
  if (status.state === 'installed' || status.state === 'bound') return 'reinstall';
  if (status.state === 'problem' && status.driverPackage) return 'reinstall';
  return status.state === 'missing' || status.state === 'problem' ? 'install' : null;
}

function installError() { return tr('安装驱动失败，请检查工具目录和 Windows 授权。'); }

function toolActionError(result, fallback) {
  if (result?.code === 'untrusted-package') return tr('工具文件校验未通过，请使用受支持的工具包。');
  if (result?.code === 'signature-check-unavailable') return tr('Windows 暂时无法验证驱动签名，未安装驱动。');
  if (result?.code === 'tool-access-denied') return tr('Windows 阻止了厂商工具启动，请检查文件权限或安全策略。');
  if (result?.code === 'tool-exited-early') return tr('厂商工具启动后立即退出，请检查运行组件及工具目录。');
  return result?.error || fallback;
}

const openToolError = () => tr('无法打开厂商工具，请检查工具目录。');
const needsToolSelection = result => result?.code === 'tool-unavailable' || result?.code === 'untrusted-package';

export function useFirmwareWorkspace({ active, entryDevice }) {
  const [selection, setSelection] = useState(() => ({ platform: readFirmwarePlatform() }));
  const platform = resolveFirmwarePlatform(selection, entryDevice);
  const [supportExpanded, updateSupportExpanded] = useState(readSupportExpanded);
  const [states, setStates] = useState({});
  const [busy, setBusy] = useState('');
  const [confirm, updateConfirm] = useState(false);
  const alive = useRef(false);
  const request = useRef({});
  const recentRequest = useRef({});
  const operation = useRef(false);
  const reviewScope = useRef(null);
  const update = useCallback((type, data) => {
    if (alive.current) setStates(prior => ({ ...prior, [type]: { ...prior[type], ...data } }));
  }, []);

  const refresh = useCallback(async (type, force = false) => {
    const token = Symbol();
    request.current[type] = token;
    const current = () => alive.current && request.current[type] === token;
    update(type, { requested: true, checking: true, readError: '' });
    try {
      const result = await window.electronAPI?.firmwareStatus?.(type, force);
      if (!current()) return;
      if (!result?.ok) update(type, { checking: false, readError: result?.error || tr('读取驱动状态失败，请重试。') });
      else update(type, { checking: false, status: result });
    } catch {
      if (current()) update(type, { checking: false, readError: tr('读取驱动状态失败，请重试。') });
    }
  }, [update]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; request.current = {}; recentRequest.current = {}; };
  }, []);
  useEffect(() => {
    const scope = { active, platform };
    reviewScope.current = scope;
    return () => { reviewScope.current = null; };
  }, [active, platform]);

  const requested = states[platform]?.requested === true;
  useEffect(() => {
    if (!active || requested || busy) return undefined;
    const initial = setTimeout(() => {
      if (!request.current[platform] && !operation.current) void refresh(platform);
    }, 0);
    return () => clearTimeout(initial);
  }, [active, platform, requested, busy, refresh]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!active || busy || !api?.firmwareRestoreFile || recentRequest.current[platform]) return undefined;
    const timer = setTimeout(async () => {
      if (recentRequest.current[platform] || operation.current) return;
      const ticket = Symbol();
      recentRequest.current[platform] = ticket;
      const stillCurrent = () => alive.current && recentRequest.current[platform] === ticket;
      update(platform, { restoringFile: true });
      try {
        const result = await api.firmwareRestoreFile(platform);
        if (stillCurrent() && result?.fileName) update(platform, { file: result });
      } catch { /* A recent path is optional; the file picker remains available. */ }
      finally { if (stillCurrent()) update(platform, { restoringFile: false }); }
    }, 0);
    return () => clearTimeout(timer);
  }, [active, busy, platform, update]);

  function invalidateOtherStatus(type) {
    const other = type === 'rk' ? 'mtk' : 'rk';
    delete request.current[other];
    update(other, { requested: false, checking: false });
  }

  function changePlatform(value) {
    if (!isPlatform(value) || operation.current || confirm) return;
    setSelection({ platform: value, requestId: entryDevice?.requestId });
    try { globalThis.localStorage?.setItem(platformKey, value); } catch { /* Remember for this session. */ }
  }

  function acceptStatus(type, status) {
    request.current[type] = Symbol();
    update(type, { requested: true, status, checking: false, readError: '' });
  }

  async function openVendor(api, type) {
    let status = states[type]?.status;
    if (!status?.tool?.available) {
      const picked = await api?.firmwareChooseTools?.(type);
      if (picked?.cancelled || !alive.current) return;
      if (!picked?.ok) {
        update(type, { error: toolActionError(picked, tr('未能读取工具目录，请重新选择。')) });
        return;
      }
      invalidateOtherStatus(type);
      acceptStatus(type, picked);
      status = picked;
      if (!status.tool?.available) {
        update(type, { error: toolActionError(status.tool, tr('未找到厂商工具。')) });
        return;
      }
    }
    const result = await api?.firmwareOpenTool?.(type);
    if (result?.ok) update(type, { notice: tr('厂商工具已打开') });
    else if (!result?.cancelled) {
      if (needsToolSelection(result)) {
        acceptStatus(type, { ...status, tool: { ...status.tool, available: false, code: result.code } });
      }
      update(type, { error: toolActionError(result, openToolError()) });
    }
  }

  function updateVerification(type, firmwareId, change, expected) {
    if (!alive.current) return;
    setStates(prior => {
      const file = prior[type]?.file;
      if (!file || file.firmwareId !== firmwareId || (expected && file.verification?.phase !== expected)) return prior;
      const verification = typeof change === 'function' ? change(file.verification) : change;
      return { ...prior, [type]: { ...prior[type], file: { ...file, verification } } };
    });
  }

  async function verifyPickedFile(api, type, firmwareId) {
    let result;
    try {
      result = await api.firmwareDirectValidateFile(type, { firmwareId });
    } catch { /* Use the same inline failure for a broken IPC connection. */ }
    if (!alive.current) return;
    const modes = Array.isArray(result?.modes) ? result.modes : [];
    let verification;
    if (result?.ok && result.reviewRequired === true) {
      const eligible = modes.filter(value => reviewModes[type]?.has(value));
      const fingerprint = fingerprintOf(result);
      const quickReview = type === 'mtk' && result.quickReview === true;
      if (eligible.length && (quickReview || fingerprint) && typeof result.board === 'string' && result.board.trim()) {
        verification = {
          phase: 'review-required', modes: eligible, board: result.board, ...(quickReview ? { quickReview: true } : { fingerprint }),
        };
      }
    } else if (result?.ok && modes.length) {
      verification = { phase: 'passed', modes };
    }
    const fingerprint = contentFingerprint(result);
    verification ??= { phase: 'failed', code: result?.code || 'flash-firmware-read-failed', ...(fingerprint ? { fingerprint } : {}) };
    updateVerification(type, firmwareId, verification, 'checking');
    return verification;
  }

  async function reviewPickedFile(api, type, mode, options) {
    const file = states[type]?.file;
    const checkOnly = type === 'mtk' && options?.checkOnly === true;
    const scope = reviewScope.current, ticket = recentRequest.current[type];
    const current = () => alive.current && scope?.active && scope.platform === type && reviewScope.current === scope &&
      recentRequest.current[type] === ticket;
    if (!current() || !reviewModes[type]?.has(mode) || !file?.ok || !file.firmwareId ||
        (!checkOnly && typeof api?.firmwareDirectReviewFile !== 'function') || typeof api?.firmwareDirectValidateFile !== 'function' ||
        file.verification?.phase === 'checking') return false;
    const { firmwareId } = file;
    let verification = file.verification;
    if (checkOnly || options?.refresh || verification?.phase !== 'review-required') {
      updateVerification(type, firmwareId, { phase: 'checking' });
      verification = await verifyPickedFile(api, type, firmwareId);
    }
    if (!current() || verification?.phase !== 'review-required' || !verification.modes.includes(mode)) return false;
    if (verification.quickReview) {
      updateVerification(type, firmwareId, old => ({ ...old, reviewedJobId: options?.jobId }), 'review-required');
      return true;
    }
    if (checkOnly) return false;
    const result = await api.firmwareDirectReviewFile(type, { firmwareId, mode });
    if (!current() || result?.cancelled) return false;
    if (result?.ok && result.mode === mode) {
      updateVerification(type, firmwareId, old => ({ ...old, approvedMode: mode, reviewedJobId: options?.jobId }), 'review-required');
      return true;
    }
    if (reviewExpired(result?.code)) {
      updateVerification(type, firmwareId, undefined, 'review-required');
      update(type, { error: tr('本次核对已失效，请重新核对固件。') });
    } else update(type, { error: actionError('review') });
    return false;
  }

  async function act(kind, value, options) {
    if (operation.current) return;
    operation.current = true;
    if (kind === 'install') updateConfirm(false);
    const type = platform;
    setBusy(kind);
    if (kind !== 'file') update(type, { feedbackKind: kind, error: '', notice: '' });
    const api = window.electronAPI;
    try {
      if (kind === 'file') {
        recentRequest.current[type] = Symbol();
        update(type, { restoringFile: false });
        const result = await api?.firmwareChooseFile?.(type);
        if (!alive.current) return;
        if (result?.cancelled) {
          if (!states[type]?.file) delete recentRequest.current[type];
        } else if (result?.fileName || result?.filePath || result?.code) {
          const validate = result.ok && typeof result.firmwareId === 'string' && result.firmwareId &&
            typeof api?.firmwareDirectValidateFile === 'function';
          update(type, { feedbackKind: kind, error: '', notice: '', file: validate ? { ...result, verification: { phase: 'checking' } } : result });
          if (validate) void verifyPickedFile(api, type, result.firmwareId);
        } else {
          update(type, { feedbackKind: kind, notice: '', error: result?.error || tr('固件文件不可访问，请重新选择。') });
        }
      } else if (kind === 'review') {
        return await reviewPickedFile(api, type, value, options);
      } else if (kind === 'install') {
        const result = await api?.firmwareInstallDriver?.(type);
        if (result?.code === 'restart-required') update(type, { notice: result.error || tr('Windows 要求重启后才能完成驱动安装。') });
        else if (result?.code === 'install-not-detected') update(type, { error: result.error || tr('安装程序已退出，未检测到匹配的驱动。') });
        else if (!result?.ok && !result?.cancelled) update(type, { error: toolActionError(result, installError()) });
        if (result?.status?.state) {
          invalidateOtherStatus(type);
          acceptStatus(type, result.status);
        }
        else await refresh(type);
      } else if (kind === 'vendor') {
        await openVendor(api, type);
      } else if (kind === 'copy' && states[type]?.file?.filePath) {
        await navigator.clipboard.writeText(states[type].file.filePath);
        update(type, { notice: tr('固件路径已复制') });
      } else if (kind === 'copy-fingerprint') {
        const fingerprint = contentFingerprint(states[type]?.file?.verification);
        if (!fingerprint) return;
        await navigator.clipboard.writeText(fingerprint);
        update(type, { notice: tr('固件指纹已复制') });
      }
    } catch {
      update(type, { feedbackKind: kind, notice: '', error: actionError(kind) });
      if (kind === 'install') await refresh(type);
    } finally {
      operation.current = false;
      if (alive.current) setBusy('');
    }
  }

  function setConfirm(value) {
    if (!value || !operation.current) updateConfirm(value);
  }

  function setSupportExpanded(expanded) {
    updateSupportExpanded(expanded);
    try { globalThis.localStorage?.setItem(toolsExpandedKey, String(expanded)); } catch { /* Keep the current selection for this session. */ }
  }

  return {
    platform, changePlatform, busy, confirm, setConfirm, act, supportExpanded, setSupportExpanded,
    refresh: async () => {
      if (operation.current) return;
      await refresh(platform, true);
      invalidateOtherStatus(platform);
    },
    ...states[platform],
  };
}

function actionError(kind) {
  return {
    install: installError(), copy: tr('复制失败'), 'copy-fingerprint': tr('复制失败'),
    file: tr('固件文件不可访问，请重新选择。'),
    review: tr('本次固件核对失败，请重试。'),
    vendor: openToolError(),
  }[kind];
}
