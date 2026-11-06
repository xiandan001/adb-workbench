import { tr } from './i18n.js';

export function normalizeConnectionStatus(value) {
  if (!value || typeof value !== 'object') throw new Error(tr('连接状态格式无效'));
  const result = {};
  for (const key of ['activeCount', 'pendingCount', 'unsavedCount', 'failedCount', 'transferCount']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error(tr('连接状态格式无效'));
    result[key] = value[key];
  }
  result.labels = Array.isArray(value.labels) ? value.labels.filter(label => typeof label === 'string') : [];
  return result;
}

export function hasConnectionActivity(value) {
  return Boolean(value && (value.activeCount || value.pendingCount || value.unsavedCount || value.failedCount || value.transferCount));
}

export function subscribeConnectionStatus({ api, document, window, onStatus, onError }) {
  let alive = true;
  const versions = { serial: 0, ssh: 0 };
  const channels = [
    { id: 'serial', subscribe: 'serialConnectionStatusSubscribe', listen: 'onSerialConnectionStatus' },
    { id: 'ssh', subscribe: 'sshConnectionStatusSubscribe', listen: 'onSshConnectionStatus' }
  ];
  const accept = (id, value) => {
    if (!alive || document.hidden) return;
    try { onStatus(id, normalizeConnectionStatus(value)); onError(id, false); }
    catch { onError(id, true); }
  };
  const listeners = channels.map(channel => api?.[channel.listen]?.(value => { versions[channel.id]++; accept(channel.id, value); }));
  const sync = () => {
    for (const channel of channels) {
      const version = ++versions[channel.id];
      const active = !document.hidden;
      Promise.resolve().then(() => {
        if (!alive) return null;
        if (!api?.[channel.subscribe]) throw new Error(tr('连接状态暂不可用'));
        return api[channel.subscribe]({ active });
      }).then(result => {
        if (!alive || version !== versions[channel.id] || !active) return;
        if (!result?.success) throw new Error(tr('连接状态暂不可用'));
        accept(channel.id, result.status);
      }).catch(() => { if (alive && active && version === versions[channel.id]) onError(channel.id, true); });
    }
  };
  const focus = () => { if (!document.hidden) sync(); };
  sync();
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('focus', focus);
  return () => {
    alive = false;
    document.removeEventListener('visibilitychange', sync);
    window.removeEventListener('focus', focus);
    listeners.forEach(unsubscribe => unsubscribe?.());
    for (const channel of channels) void Promise.resolve().then(() => api?.[channel.subscribe]?.({ active: false })).catch(() => {});
  };
}
