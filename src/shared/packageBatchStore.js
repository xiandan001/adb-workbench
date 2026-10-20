import { summarizePackageBatch } from './deviceWorkflow.js';

export const PACKAGE_BATCH_RESULT_EVENT = 'adb-workbench:package-batch-result';

export function readPackageBatchResult(deviceId, storage) {
  try {
    return JSON.parse((storage || globalThis.sessionStorage).getItem(`packageBatchResult:${deviceId}`) || 'null');
  } catch {
    return null;
  }
}

export function storePackageBatchResult(deviceId, result, storage) {
  let storageError = '';
  try {
    const target = storage || globalThis.sessionStorage;
    if (result) target.setItem(`packageBatchResult:${deviceId}`, JSON.stringify(result));
    else target.removeItem(`packageBatchResult:${deviceId}`);
  } catch (error) {
    storageError = `批量结果缓存失败：${error.message}。请保留当前结果。`;
  }
  if (typeof window !== 'undefined' && (result || !storageError)) {
    window.dispatchEvent(new CustomEvent(PACKAGE_BATCH_RESULT_EVENT, { detail: { deviceId, result, storageError } }));
  }
  return storageError;
}

export async function executePersistedPackageBatch({ deviceId, action, label, packageNames, request, storage }) {
  let response;
  let requestError = '';
  try {
    response = await request({ deviceId, action, packageNames });
  } catch (error) {
    requestError = error.message || '批量请求失败';
    response = { error: `${requestError}；执行结果不确定，请先核实设备状态` };
  }
  const result = {
    ...summarizePackageBatch(packageNames, response),
    deviceId, action, label, completedAt: new Date().toISOString()
  };
  const storageError = storePackageBatchResult(deviceId, result, storage);
  return { result, requestError, storageError };
}
