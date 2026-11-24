import { useCallback, useEffect, useRef, useState } from 'react';
import { tr } from '../shared/i18n.js';

const platformKey = 'firmware-workspace-platform';
const isPlatform = value => value === 'rk' || value === 'mtk';

export function readFirmwarePlatform(storage = globalThis.localStorage) {
  try { return storage?.getItem(platformKey) === 'mtk' ? 'mtk' : 'rk'; }
  catch { return 'rk'; }
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
  const [states, setStates] = useState({});
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState(false);
  const alive = useRef(false);
  const request = useRef({});
  const operation = useRef(false);
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
    return () => { alive.current = false; request.current = {}; };
  }, []);

  const requested = states[platform]?.requested === true;
  useEffect(() => {
    if (!active || requested || busy) return undefined;
    const initial = setTimeout(() => {
      if (!request.current[platform] && !operation.current) void refresh(platform);
    }, 0);
    return () => clearTimeout(initial);
  }, [active, platform, requested, busy, refresh]);

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

  async function act(kind) {
    if (operation.current) return;
    operation.current = true;
    const type = platform;
    setBusy(kind);
    update(type, { feedbackKind: kind, error: '', notice: '' });
    const api = window.electronAPI;
    try {
      if (kind === 'file') {
        const result = await api?.firmwareChooseFile?.(type);
        if (result?.fileName || result?.code) update(type, { file: result });
        else if (!result?.cancelled) update(type, { error: result?.error || tr('固件文件不可访问，请重新选择。') });
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
      }
    } catch {
      update(type, { error: actionError(kind) });
      if (kind === 'install') await refresh(type);
    } finally {
      operation.current = false;
      if (alive.current) { setBusy(''); if (kind === 'install') setConfirm(false); }
    }
  }

  return {
    platform, changePlatform, busy, confirm, setConfirm, act,
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
    install: installError(), copy: tr('复制失败'),
    file: tr('固件文件不可访问，请重新选择。'),
    vendor: openToolError(),
  }[kind];
}
