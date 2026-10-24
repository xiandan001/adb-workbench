const { tr } = require('./localization.cjs');
const WORKSPACES = ['rs232', 'terminal'];
const LABELS = { rs232: 'RS232 调试', terminal: '串口终端' };

function createSerialWorkspaces({ createService, onChange = () => {} }) {
  if (typeof createService !== 'function') throw new Error(tr("串口工作区服务未初始化"));
  const slots = new Map();
  const reservations = new Map();
  let disposed = false;

  function select(workspace = 'rs232') {
    if (!WORKSPACES.includes(workspace)) throw workspaceError('SERIAL_WORKSPACE_INVALID', tr("串口工作区无效，请选择 RS232 调试或串口终端"));
    return slots.get(workspace);
  }

  function assertRunning() {
    if (disposed) throw workspaceError('SERIAL_WORKSPACE_DISPOSED', tr("串口工作区正在退出，无法继续连接"));
  }

  function releaseReservation(slot, lease = slot.lease) {
    if (!lease || slot.lease !== lease || slot.service?.hasActiveConnection()) return;
    if (slot.attempt?.lease === lease && !slot.attempt.cancelled) return;
    if (reservations.get(lease.key) === lease) reservations.delete(lease.key);
    slot.lease = null;
  }

  function reconcile() {
    for (const slot of slots.values()) releaseReservation(slot);
  }

  function project(workspace, state) {
    const slot = select(workspace);
    releaseReservation(slot);
    const reservedPort = slot.lease?.key || '';
    const enumerating = reservedPort && slot.attempt?.phase === 'enumerating'
      && !slot.attempt.cancelled && !slot.service.hasActiveConnection();
    return { ...state, workspace, reservedPort,
      ...(enumerating ? { status: 'connecting', path: reservedPort } : {}) };
  }

  function snapshot(workspace = 'rs232') {
    const slot = select(workspace);
    return project(workspace, slot.service.snapshot());
  }

  function snapshots() {
    return Object.fromEntries(WORKSPACES.map(workspace => [workspace, snapshot(workspace)]));
  }

  async function connect(workspace = 'rs232', args = {}) {
    assertRunning();
    const slot = select(workspace);
    const key = normalizeSerialPort(args?.path);
    reconcile();
    if (slot.attempt || slot.service.hasActiveConnection() || slot.lease) {
      throw workspaceError('SERIAL_WORKSPACE_BUSY', tr("请先断开并释放该工作区的当前串口"));
    }
    const occupied = reservations.get(key);
    if (occupied) throw workspaceError('SERIAL_PORT_IN_USE', tr('{0} 正由{1}使用或等待释放，请选择其他串口', { 0: key, 1: tr(LABELS[occupied.workspace]) }));

    // Own the path before enumeration or native open can yield to another workspace.
    const lease = { workspace, key };
    const attempt = { lease, cancelled: false, phase: 'enumerating' };
    reservations.set(key, lease);
    slot.lease = lease;
    slot.attempt = attempt;
    try {
      const ports = await slot.service.listPorts();
      if (disposed || attempt.cancelled || slot.attempt !== attempt) throw workspaceError('SERIAL_CONNECT_CANCELLED', tr("串口连接已取消，不会打开迟到的端口"));
      const available = ports.find(port => normalizeSerialPort(port.path) === key);
      if (!available) throw workspaceError('SERIAL_PORT_UNAVAILABLE', tr("所选串口已不可用，请刷新后重新选择"));
      attempt.phase = 'opening';
      await slot.service.connect({ ...args, path: available.path });
      if (disposed || attempt.cancelled || slot.attempt !== attempt) throw workspaceError('SERIAL_CONNECT_CANCELLED', tr("串口连接已取消"));
      return snapshot(workspace);
    } finally {
      if (slot.attempt === attempt) slot.attempt = null;
      // A rejected open/close promise does not prove the native handle was released.
      releaseReservation(slot, lease);
    }
  }

  async function disconnect(workspace = 'rs232') {
    assertRunning();
    const slot = select(workspace);
    const lease = slot.lease;
    if (slot.attempt) { slot.attempt.cancelled = true; slot.attempt = null; }
    try {
      await slot.service.disconnect();
      return snapshot(workspace);
    } finally { releaseReservation(slot, lease); }
  }

  function needsQuitConfirmation() {
    return [...slots.values()].some(slot => !!slot.attempt || slot.service.needsQuitConfirmation());
  }

  async function dispose() {
    disposed = true;
    for (const slot of slots.values()) {
      if (slot.attempt) { slot.attempt.cancelled = true; slot.attempt = null; }
    }
    const results = await Promise.allSettled([...slots.values()].map(async slot => {
      const lease = slot.lease;
      try { await slot.service.dispose(); }
      finally { releaseReservation(slot, lease); }
    }));
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, tr('部分串口尚未成功关闭或释放：{0}', { 0: failures.map(error => error.message).join('; ') }));
  }

  for (const workspace of WORKSPACES) {
    const slot = { service: null, facade: null, lease: null, attempt: null };
    slots.set(workspace, slot);
    slot.service = createService(workspace, delta => {
      onChange(project(workspace, delta));
    });
    if (!slot.service || typeof slot.service.hasActiveConnection !== 'function') throw new Error(tr("串口工作区缺少连接生命周期状态"));
    slot.facade = {
      ...slot.service,
      snapshot: () => snapshot(workspace),
      connect: args => connect(workspace, args),
      disconnect: () => disconnect(workspace),
      dispose: async () => {
        if (slot.attempt) { slot.attempt.cancelled = true; slot.attempt = null; }
        const lease = slot.lease;
        try { await slot.service.dispose(); }
        finally { releaseReservation(slot, lease); }
      }
    };
  }

  return { get: (workspace = 'rs232') => select(workspace).facade,
    snapshot, snapshots, connect, disconnect, needsQuitConfirmation, dispose };
}

function normalizeSerialPort(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw workspaceError('SERIAL_PORT_INVALID', tr("请选择有效的串口"));
  }
  const path = value.replace(/^\\\\[.?]\\/, '').toUpperCase();
  const match = /^COM(\d+)$/.exec(path);
  return match ? 'COM' + match[1].replace(/^0+(?=\d)/, '') : path;
}

function workspaceError(code, message) { return Object.assign(new Error(message), { code }); }

module.exports = { createSerialWorkspaces, normalizeSerialPort };
