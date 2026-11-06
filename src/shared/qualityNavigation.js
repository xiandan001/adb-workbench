export function guardNavigationRequest(value) {
  if (value && typeof value === 'object') {
    return { id: typeof value.id === 'string' ? value.id : '', key: `${value.id || ''}:${value.requestId || ''}` };
  }
  const key = typeof value === 'string' ? value : '';
  return { id: key.replace(/:\d+$/, ''), key };
}

export function findGuardRecord(state, deviceId, requestedId = '') {
  const records = [...(state.activeGuards || []), ...(state.history || [])];
  if (requestedId) return records.find(item => item.id === requestedId) || null;
  return (state.history || []).find(item => item.deviceId === deviceId) || null;
}
