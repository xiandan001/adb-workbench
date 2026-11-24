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

function installError() { return tr('安装驱动失败，请检查工具目录和 Windows 授权。'); }

function toolActionError(result, fallback) {
  return result?.code === 'untrusted-package' ? tr('工具文件校验未通过，请使用受支持的工具包。') : result?.error || fallback;
}

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

  const refresh = useCallback(async (type) => {
    const version = (request.current[type] || 0) + 1;
    request.current[type] = version;
    const current = () => alive.current && request.current[type] === version;
    update(type, { checking: true, readError: '' });
    try {
      const result = await window.electronAPI?.firmwareStatus?.(type);
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

  useEffect(() => {
    if (!active) return undefined;
    const onFocus = () => { if (!operation.current) void refresh(platform); };
    const initial = setTimeout(onFocus, 0);
    window.addEventListener('focus', onFocus);
    return () => { clearTimeout(initial); window.removeEventListener('focus', onFocus); };
  }, [active, platform, refresh]);

  function changePlatform(value) {
    if (!isPlatform(value) || operation.current || confirm) return;
    setSelection({ platform: value, requestId: entryDevice?.requestId });
    try { globalThis.localStorage?.setItem(platformKey, value); } catch { /* Remember for this session. */ }
  }

  function acceptStatus(type, status) {
    request.current[type] = (request.current[type] || 0) + 1;
    update(type, { status, checking: false, readError: '' });
  }

  async function act(kind) {
    if (operation.current) return;
    operation.current = true;
    const type = platform;
    setBusy(kind);
    update(type, { feedbackKind: kind, error: '', notice: '' });
    const api = window.electronAPI;
    try {
      if (kind === 'tools') {
        const result = await api?.firmwareChooseTools?.(type);
        if (result?.ok) {
          if (result.state) acceptStatus(type, result);
          else await refresh(type);
        } else if (!result?.cancelled) update(type, { error: result?.error || tr('未能读取工具目录，请重新选择。') });
      } else if (kind === 'file') {
        const result = await api?.firmwareChooseFile?.(type);
        if (result?.fileName || result?.code) update(type, { file: result });
        else if (!result?.cancelled) update(type, { error: result?.error || tr('固件文件不可访问，请重新选择。') });
      } else if (kind === 'install') {
        const result = await api?.firmwareInstallDriver?.(type);
        if (result?.code === 'restart-required') update(type, { notice: result.error || tr('Windows 要求重启后才能完成驱动安装。') });
        else if (result?.code === 'install-not-detected') update(type, { error: result.error || tr('安装程序已退出，未检测到匹配的驱动。') });
        else if (!result?.ok && !result?.cancelled) update(type, { error: toolActionError(result, installError()) });
        if (result?.status?.state) acceptStatus(type, result.status);
        else await refresh(type);
      } else if (kind === 'vendor') {
        const result = await api?.firmwareOpenTool?.(type);
        if (result?.ok) update(type, { notice: tr('厂商工具已打开') });
        else if (!result?.cancelled) update(type, { error: toolActionError(result, tr('无法打开厂商工具，请检查工具目录。')) });
      } else if (kind === 'help') {
        const result = await api?.firmwareOpenVendorHelp?.(type);
        if (!result?.ok) update(type, { error: result?.error || tr('无法打开厂商说明。') });
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
    refresh: () => { if (!operation.current) void refresh(platform); },
    ...states[platform],
  };
}

function actionError(kind) {
  return {
    install: installError(), copy: tr('复制失败'),
    tools: tr('未能读取工具目录，请重新选择。'),
    file: tr('固件文件不可访问，请重新选择。'),
    vendor: tr('无法打开厂商工具，请检查工具目录。'), help: tr('无法打开厂商说明。'),
  }[kind];
}
