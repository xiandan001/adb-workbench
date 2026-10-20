export function nextTroubleshootingContext({ currentDeviceId, activeDeviceId, running, navigationContext, appliedRequestId }) {
  if (running) return null;
  const deviceChanged = currentDeviceId !== activeDeviceId;
  const applyNavigation = Boolean(navigationContext?.requestId
    && navigationContext.requestId !== appliedRequestId
    && navigationContext.deviceId === activeDeviceId);
  if (!deviceChanged && !applyNavigation) return null;
  return {
    deviceId: activeDeviceId || '',
    packageName: applyNavigation ? navigationContext.packageName || '' : '',
    appliedRequestId: applyNavigation ? navigationContext.requestId : appliedRequestId
  };
}
