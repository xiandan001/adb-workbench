const stateKeys = ['checking', 'available', 'notAvailable', 'downloading', 'progress', 'downloaded', 'error', 'info'];

export function observeUpdaterState(api, update) {
  let active = true;
  let revision = 0;
  const apply = (value, eventName) => {
    if (!active || !value || typeof value !== 'object' || Array.isArray(value)) return;
    const patch = Object.fromEntries(stateKeys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
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
