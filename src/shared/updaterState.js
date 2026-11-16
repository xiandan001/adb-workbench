import { tr } from './i18n.js';
const stateKeys = ['checking', 'refreshing', 'available', 'notAvailable', 'downloading', 'progress', 'downloaded', 'installing', 'installPhase', 'error', 'info'];

export function updaterInstallLabel(phase) {
  if (phase === 'quitting') return tr('安装器已就绪，正在保存并退出应用…');
  if (phase === 'ready') return tr('安装器已就绪，正在准备安全退出…');
  return tr('正在启动安装器…');
}

export function observeUpdaterState(api, update) {
  let active = true;
  let revision = 0;
  const apply = (value, eventName) => {
    if (!active || !value || typeof value !== 'object' || Array.isArray(value)) return;
    const patch = Object.fromEntries(stateKeys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
    if (Object.hasOwn(patch, 'installPhase') && !['', 'launching', 'ready', 'quitting'].includes(patch.installPhase)) delete patch.installPhase;
    update(previous => previous.downloaded && eventName === 'download-progress' ? previous : { ...previous, ...patch });
  };
  const unsubscribe = api?.onUpdaterEvent?.(({ eventName, payload } = {}) => {
    if (!active) return;
    if (eventName === 'state') { revision++; apply(payload, eventName); }
    else if (eventName === 'download-progress') { revision++; apply({ downloading: true, progress: payload }, eventName); }
    else if (eventName === 'update-downloaded') { revision++; apply({ downloading: false, downloaded: true, info: payload }, eventName); }
  });
  const initialRevision = revision;
  if (typeof api?.getUpdaterStatus === 'function') {
    Promise.resolve().then(() => { if (active) return api.getUpdaterStatus(); }).then(status => {
      if (active && revision === initialRevision) apply(status, 'snapshot');
    }).catch(() => { /* Live events still provide status if the initial snapshot fails. */ });
  }
  return () => { active = false; unsubscribe?.(); };
}
