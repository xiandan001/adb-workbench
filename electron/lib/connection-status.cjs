const ACTIVE_TRANSFERS = new Set(['queued', 'planning', 'running', 'preparing', 'transferring', 'cancelling']);
const FAILED_TRANSFERS = new Set(['failed', 'error', 'conflict']);

function serialStatusMetadata(value = {}) {
  return { workspace: value.workspace, path: typeof value.path === 'string' ? value.path : '',
    status: value.status || 'disconnected', unsaved: value.unsaved === true,
    failed: value.status === 'error' || (Object.hasOwn(value, 'error') ? Boolean(value.error) : value.failed === true) };
}

function serialSummary(list) {
  return {
    activeCount: list.filter(item => item.status === 'connected').length,
    pendingCount: list.filter(item => ['connecting', 'disconnecting'].includes(item.status)).length,
    unsavedCount: list.filter(item => item.unsaved).length,
    failedCount: list.filter(item => item.failed).length, transferCount: 0,
    labels: list.filter(item => item.path && (item.status !== 'disconnected' || item.unsaved || item.failed)).map(item => item.path)
  };
}

function serialConnectionStatus(states) {
  const list = Object.entries(states).map(([workspace, value]) => serialStatusMetadata({ ...value, workspace }));
  return { ...serialSummary(list), workspaces: Object.fromEntries(['rs232', 'terminal'].map(key =>
    [key, serialSummary(list.filter(item => item.workspace === key))])) };
}

function ipConnectionStatus({ status, mode, host, port, peerHost, peerPort }) {
  const endpoint = (address, number) => address.includes(':') ? `[${address}]:${number}` : `${address}:${number}`;
  return {
    activeCount: ['connected', 'ready', 'listening'].includes(status) ? 1 : 0,
    pendingCount: status === 'connecting' ? 1 : 0, failedCount: status === 'error' ? 1 : 0,
    transferCount: 0, unsavedCount: 0, mode, phase: status,
    labels: status === 'idle' || !host ? [] : [endpoint(host, port), ...(peerHost ? [endpoint(peerHost, peerPort)] : [])]
  };
}

function sshConnectionStatus(sessions, transfers, drafts) {
  return {
    activeCount: sessions.filter(item => item.status === 'connected').length,
    pendingCount: sessions.filter(item => ['connecting', 'verifying-host', 'disconnecting'].includes(item.status)).length,
    unsavedCount: [...drafts.values()].reduce((sum, paths) => sum + paths.length, 0),
    failedCount: sessions.filter(item => item.status === 'error').length + transfers.filter(item => FAILED_TRANSFERS.has(item.status)).length,
    transferCount: transfers.filter(item => ACTIVE_TRANSFERS.has(item.status)).length,
    labels: sessions.filter(item => item.status !== 'disconnected' || drafts.get(item.id)?.length).map(item => item.name || item.host || '')
  };
}

module.exports = { serialStatusMetadata, serialConnectionStatus, sshConnectionStatus, ipConnectionStatus };
