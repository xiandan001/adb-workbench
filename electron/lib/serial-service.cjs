const { tr } = require('./localization.cjs');
const { randomUUID } = require('node:crypto');
const { createSerialBuffer, RX_PENDING_IDLE_MS } = require('./serial-buffer.cjs');
const { DEFAULT_CONFIG, normalizeConfig, encodeMessage } = require('./serial-policy.cjs');
const { createSerialTerminalBuffer } = require('./serial-terminal-buffer.cjs');

const BATCH_MS = 100;
const OPEN_TIMEOUT_MS = 15000;
const TERMINAL_QUEUE_BYTES = 64 * 1024;
const TERMINAL_QUEUE_ITEMS = 256;
const PORT_FIELDS = ['path', 'manufacturer', 'serialNumber', 'pnpId', 'locationId', 'vendorId', 'productId', 'friendlyName'];

function createSerialService({ listPorts: enumerate, createPort, onChange = () => {}, now = Date.now,
  writeTimeoutMs = 10000, closeTimeoutMs = 5000, maxEntries, maxBytes, mergeReceive = true, terminalReplayBytes }) {
  if (typeof enumerate !== 'function' || typeof createPort !== 'function') throw new Error(tr("串口驱动未初始化"));
  const buffer = createSerialBuffer({ now, maxEntries, maxBytes, mergeReceive });
  const terminalBuffer = terminalReplayBytes === 0 ? null : createSerialTerminalBuffer({ maxBytes: terminalReplayBytes });
  const terminalQueue = [];
  let terminalInFlight = null;
  let terminalPendingBytes = 0;
  let terminalPendingCount = 0;
  const state = { status: 'disconnected', path: '', config: { ...DEFAULT_CONFIG }, sessionId: '', error: '', sending: false };
  let active = null;
  let revision = 0;
  let lastDataRevision = 0;
  let savedRevision = 0;
  let publishedRevision = 0;
  let resetPending = false;
  let batchTimer = null;
  let receiveIdleTimer = null;
  let disposed = false;

  function metadata() {
    return { ...state, config: { ...state.config }, revision, ...buffer.metadata(), unsaved: lastDataRevision > savedRevision };
  }

  function snapshot() {
    return { ...metadata(), entries: buffer.entriesAfter() };
  }

  function changed({ data = false, reset = false } = {}) {
    revision++;
    if (data) lastDataRevision = revision;
    const structuralReset = buffer.consumeReset();
    resetPending ||= reset || structuralReset;
    if (batchTimer || disposed) return;
    batchTimer = setTimeout(() => {
      batchTimer = null;
      const delta = { ...metadata(), baseRevision: publishedRevision, entries: buffer.drainChanges(resetPending), reset: resetPending };
      publishedRevision = delta.revision;
      resetPending = false;
      try { onChange(delta); } catch { /* A renderer observer cannot break the hardware lifecycle. */ }
    }, BATCH_MS);
    batchTimer.unref?.();
  }

  function assertRunning() {
    if (disposed) throw new Error(tr("串口服务正在退出，无法继续操作"));
  }

  function terminalRead(args) {
    assertRunning();
    if (!terminalBuffer) throw terminalError('SERIAL_TERMINAL_NO_SESSION', tr("尚无串口终端会话，请先连接串口"));
    return terminalBuffer.read(args);
  }

  function finishTerminalItem(item, error, result) {
    if (item.settled) return;
    item.settled = true;
    terminalPendingBytes -= item.bytes.length;
    terminalPendingCount--;
    if (error) item.action.reject(error);
    else item.action.resolve(result);
  }

  function cancelTerminalQueue(session) {
    for (let index = terminalQueue.length - 1; index >= 0; index--) {
      const item = terminalQueue[index];
      if (session && item.session !== session) continue;
      terminalQueue.splice(index, 1);
      finishTerminalItem(item, terminalError('SERIAL_TERMINAL_SESSION_CLOSED', tr("串口连接已断开，尚未写入的终端输入已取消，不会重播")));
    }
    if (terminalInFlight && (!session || terminalInFlight.session === session)) {
      finishTerminalItem(terminalInFlight, terminalInFlight.started
        ? terminalError('SERIAL_TERMINAL_WRITE_UNKNOWN', tr("串口连接已断开，正在发送的终端输入结果无法确认；部分字节可能已发出"))
        : terminalError('SERIAL_TERMINAL_SESSION_CLOSED', tr("串口连接已断开，尚未写入的终端输入已取消，不会重播")));
    }
  }

  function pumpTerminalQueue() {
    if (terminalInFlight || !terminalQueue.length) return;
    const item = terminalQueue[0];
    if (disposed || active !== item.session || item.session.cancelled || state.status !== 'connected') {
      cancelTerminalQueue(item.session);
      return;
    }
    if (item.session.write) return;
    terminalQueue.shift();
    terminalInFlight = item;
    Promise.resolve().then(() => {
      if (item.settled || disposed || active !== item.session || item.session.cancelled || state.status !== 'connected') {
        throw terminalError('SERIAL_TERMINAL_SESSION_CLOSED', tr("串口会话已结束，尚未写入的终端输入已取消"));
      }
      item.started = true;
      return writeBytes(item.session, item.bytes, { terminal: true });
    }).then(
      result => finishTerminalItem(item, null, result),
      error => {
        finishTerminalItem(item, terminalError('SERIAL_TERMINAL_WRITE_UNKNOWN', error.message || tr("终端发送结果无法确认")));
        cancelTerminalQueue(item.session);
      }
    ).finally(() => {
      if (terminalInFlight === item) terminalInFlight = null;
      pumpTerminalQueue();
    }).catch(() => {});
  }

  function terminalWrite(message) {
    try {
      assertRunning();
      const session = active;
      if (!session || state.status !== 'connected' || session.cancelled) throw terminalError('SERIAL_TERMINAL_NOT_CONNECTED', tr("请先连接串口后再输入终端内容"));
      if (message?.sessionId !== session.id) throw terminalError('SERIAL_TERMINAL_SESSION_CHANGED', tr("串口会话已变化，旧终端输入不会发送"));
      let bytes;
      try { bytes = encodeMessage({ mode: 'text', content: message.content, lineEnding: 'none' }); }
      catch (error) { throw terminalError('SERIAL_TERMINAL_INPUT_INVALID', error.message); }
      if (terminalPendingCount >= TERMINAL_QUEUE_ITEMS || terminalPendingBytes + bytes.length > TERMINAL_QUEUE_BYTES) {
        throw terminalError('SERIAL_TERMINAL_BACKPRESSURE', tr("终端发送队列已满，请等待当前输入写入；本次输入尚未接受"));
      }
      const item = { session, bytes, action: deferred(), settled: false, started: false };
      terminalQueue.push(item);
      terminalPendingBytes += bytes.length;
      terminalPendingCount++;
      pumpTerminalQueue();
      return item.action.promise;
    } catch (error) { return Promise.reject(error); }
  }

  function flushReceive() {
    clearTimeout(receiveIdleTimer);
    receiveIdleTimer = null;
    if (buffer.sealReceive()) changed({ data: true });
  }

  function scheduleReceiveIdle(session) {
    clearTimeout(receiveIdleTimer);
    receiveIdleTimer = null;
    if (!buffer.hasPendingReceive()) return;
    receiveIdleTimer = setTimeout(() => {
      receiveIdleTimer = null;
      if (active === session && !session.cancelled && !disposed) flushReceive();
    }, RX_PENDING_IDLE_MS);
    receiveIdleTimer.unref?.();
  }

  async function listPorts() {
    assertRunning();
    try {
      const ports = await enumerate();
      if (!Array.isArray(ports)) throw new Error(tr("驱动返回的端口列表无效"));
      const seen = new Set();
      return ports.filter(port => {
        if (!validPath(port?.path) || seen.has(port.path.toLowerCase())) return false;
        seen.add(port.path.toLowerCase());
        return true;
      }).map(port => Object.fromEntries(PORT_FIELDS
        .filter(key => typeof port[key] === 'string')
        .map(key => [key, port[key].slice(0, 512)])))
        .sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true, sensitivity: 'base' }));
    } catch (error) { throw new Error(tr("串口列表读取失败，请检查驱动后刷新：{0}", { 0: brief(error) })); }
  }

  function finishStream(session) {
    if (session.streamEnded) return;
    session.streamEnded = true;
    clearTimeout(receiveIdleTimer);
    receiveIdleTimer = null;
    if (buffer.endSession(session.id)) changed({ data: true, reset: true });
  }

  function cancelWrite(session, message) {
    session.write?.fail(new Error(message), false);
  }

  function release(session) {
    if (session.released) return;
    session.released = true;
    cancelTerminalQueue(session);
    clearTimeout(session.openTimer);
    finishStream(session);
    session.port?.removeListener('data', session.onData);
    session.port?.removeListener('error', session.onError);
    session.port?.removeListener('close', session.onClose);
    // Native callbacks may arrive after release. Keep a passive error listener only.
    session.port?.on('error', ignoreLateError);
    if (active !== session) return;
    active = null;
    state.status = session.failure ? 'error' : 'disconnected';
    state.error = session.failure;
    state.sending = false;
    changed();
  }

  function observeSession(session) {
    session.onData = bytes => {
      if (active !== session || session.cancelled || session.released || disposed) return;
      if (!Buffer.isBuffer(bytes) && !ArrayBuffer.isView(bytes)) return;
      const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      terminalBuffer?.append(raw);
      if (buffer.append({ sessionId: session.id, path: session.path, config: session.config, direction: 'RX', bytes: raw })) {
        changed({ data: true });
        scheduleReceiveIdle(session);
      }
    };
    session.onError = error => {
      if (active !== session || session.released) return;
      session.failure ||= tr("串口连接异常，已停止发送，请检查设备或驱动：{0}", { 0: brief(error) });
      session.cancelled = true;
      session.openAction.reject(new Error(session.failure));
      requestClose(session).catch(() => {});
    };
    session.onClose = () => {
      if (session.released) return;
      if (!session.cancelled) session.failure ||= tr("串口连接已断开，请检查串口线后手动连接");
      session.cancelled = true;
      session.openAction.reject(new Error(session.failure || tr("串口连接已取消")));
      cancelWrite(session, tr("串口连接已断开，发送结果无法确认；已发送的部分数据无法撤回"));
      if (session.openPending) return;
      session.closed = true;
      session.closeSignal?.resolve();
      release(session);
    };
    session.port.on('data', session.onData);
    session.port.on('error', session.onError);
    session.port.on('close', session.onClose);
  }

  function opened(session, error) {
    if (!session.openPending) return;
    clearTimeout(session.openTimer);
    session.openPending = false;
    session.openSucceeded = !error;
    if (error) {
      session.failure ||= tr("串口打开失败，可能被占用、已拔出或参数不受支持：{0}", { 0: brief(error) });
      session.openAction.reject(new Error(session.failure));
      session.nativeOpen.resolve();
      release(session);
      return;
    }
    session.closed = false;
    session.nativeOpen.resolve();
    if (session.cancelled || disposed) {
      session.cancelled = true;
      session.openAction.reject(new Error(tr("串口连接已取消，正在释放端口")));
      if (!session.closePromise) requestClose(session).catch(() => {});
      return;
    }
    if (active !== session) return;
    state.status = 'connected';
    state.error = '';
    changed();
    session.openAction.resolve(snapshot());
  }

  async function connect({ path, config } = {}) {
    assertRunning();
    if (active) throw new Error(tr("请先断开并释放当前串口，再连接其他端口"));
    if (!validPath(path)) throw new Error(tr("请选择有效的串口"));
    const normalized = normalizeConfig(config);
    flushReceive();
    const session = {
      id: randomUUID(), path, config: normalized, port: null,
      openPending: true, openSucceeded: false, cancelled: false, released: false,
      closed: false, failure: '', openAction: deferred(), nativeOpen: deferred(),
      closePromise: null, closeSignal: null, write: null, streamEnded: false
    };
    active = session;
    terminalBuffer?.reset(session.id);
    Object.assign(state, { status: 'connecting', path, config: normalized, sessionId: session.id, error: '', sending: false });
    changed();
    try {
      session.port = createPort(nativeOptions(path, normalized));
      observeSession(session);
      session.openTimer = setTimeout(() => {
        if (!session.openPending || session.released) return;
        session.failure = tr("串口打开超时，等待驱动释放端口后才能再次连接");
        session.cancelled = true;
        session.openAction.reject(new Error(session.failure));
        requestClose(session).catch(() => {});
      }, OPEN_TIMEOUT_MS);
      session.openTimer.unref?.();
      session.port.open(error => opened(session, error));
    } catch (error) { opened(session, error); }
    return session.openAction.promise;
  }

  function requestClose(session) {
    if (session.released) return Promise.resolve(snapshot());
    if (session.closePromise) return session.closePromise;
    session.cancelled = true;
    flushReceive();
    session.openAction.reject(new Error(session.failure || tr("串口连接已取消，正在断开")));
    cancelWrite(session, tr("串口正在断开，发送结果无法确认；已发送的部分数据无法撤回"));
    cancelTerminalQueue(session);
    if (active === session) {
      state.status = 'disconnecting';
      state.error = session.failure;
      state.sending = false;
      changed();
    }
    // Publish the in-flight identity before calling a driver that may emit synchronously.
    const closing = Promise.resolve().then(() => closeSession(session));
    session.closePromise = closing;
    closing.finally(() => {
      if (session.closePromise === closing) session.closePromise = null;
    }).catch(() => {});
    return closing;
  }

  async function closeSession(session) {
    try {
      if (session.openPending) {
        await withTimeout(session.nativeOpen.promise, closeTimeoutMs, tr("等待串口打开结束超时，旧端口尚未释放，请稍后重试断开或重启应用"));
      }
      if (session.released) return snapshot();
      if (!session.openSucceeded) {
        release(session);
        return snapshot();
      }
      session.closeSignal = deferred();
      const signal = session.closeSignal;
      try {
        session.port.close(error => {
          if (error) signal.reject(new Error(tr("串口关闭失败，旧端口尚未释放，请重试断开：{0}", { 0: brief(error) })));
          else {
            session.closed = true;
            signal.resolve();
            if (!session.released) release(session);
          }
        });
      } catch (error) { signal.reject(new Error(tr("串口关闭失败，旧端口尚未释放：{0}", { 0: brief(error) }))); }
      await withTimeout(signal.promise, closeTimeoutMs, tr("串口关闭超时，旧端口尚未释放，请重试断开或重启应用"));
      release(session);
      return snapshot();
    } catch (error) {
      if (active === session && !session.released) {
        state.status = 'error';
        state.error = session.failure ? `${session.failure}；${error.message}` : error.message;
        state.sending = false;
        changed();
      }
      throw error;
    }
  }

  async function disconnect() {
    assertRunning();
    if (!active) return snapshot();
    return requestClose(active);
  }

  function send(message) {
    try {
      assertRunning();
      const session = active;
      if (!session || state.status !== 'connected' || session.cancelled) throw new Error(tr("请先连接串口后再发送"));
      if (message?.sessionId !== session.id) throw new Error(tr("串口连接会话已变化，请确认当前连接后重新发送"));
      if (session.write || terminalPendingCount) throw new Error(tr("上一条数据仍在写入，请等待发送结果"));
      return writeBytes(session, encodeMessage(message));
    } catch (error) { return Promise.reject(error); }
  }

  function writeBytes(session, bytes, { terminal = false } = {}) {
    if (terminal) buffer.sealRawReceive();
    else flushReceive();
    const action = deferred();
    let finished = false;
    const current = () => active === session && !session.cancelled && !session.released && state.status === 'connected';
    function complete(error, closeOnError = true) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (session.write === operation) session.write = null;
      queueMicrotask(pumpTerminalQueue);
      if (error) {
        if (active === session) {
          state.sending = false;
          changed();
        }
        if (closeOnError && !session.released) {
          session.failure = error.message;
          requestClose(session).catch(() => {});
        }
        action.reject(error);
        return;
      }
      if (!current()) {
        action.reject(new Error(tr("串口连接已变化，发送结果无法确认；已发送的部分数据无法撤回")));
        return;
      }
      buffer.sealRawReceive();
      buffer.append({ sessionId: session.id, path: session.path, config: session.config, direction: 'TX', bytes });
      state.sending = false;
      changed({ data: true });
      action.resolve(terminal ? { bytes: bytes.length } : snapshot());
    }
    const operation = { fail: (error, closeOnError) => complete(error, closeOnError) };
    session.write = operation;
    state.sending = true;
    changed();
    const uncertain = error => new Error(tr("写入串口失败，发送结果无法确认，已停止后续发送；部分数据可能已发出：{0}", { 0: brief(error) }));
    const timer = setTimeout(() => complete(uncertain(new Error(tr("等待写入或排空超时")))), writeTimeoutMs);
    try {
      session.port.write(bytes, error => {
        if (finished) return;
        if (error) return complete(uncertain(error));
        if (!current()) return complete(uncertain(new Error(tr("串口连接已变化"))));
        try {
          session.port.drain(drainError => {
            if (finished) return;
            complete(drainError ? uncertain(drainError) : null);
          });
        } catch (drainError) { complete(uncertain(drainError)); }
      });
    } catch (error) { complete(uncertain(error)); }
    return action.promise;
  }

  function clear() {
    assertRunning();
    clearTimeout(receiveIdleTimer);
    receiveIdleTimer = null;
    buffer.clear();
    changed({ reset: true });
    lastDataRevision = revision;
    savedRevision = revision;
    return snapshot();
  }

  function sealReceive() {
    assertRunning();
    flushReceive();
  }

  function markSaved(exportedRevision) {
    if (!Number.isSafeInteger(exportedRevision) || exportedRevision < 0 || exportedRevision > revision) throw new Error(tr("保存的串口记录版本无效"));
    const wasUnsaved = lastDataRevision > savedRevision;
    savedRevision = Math.max(savedRevision, exportedRevision);
    if (wasUnsaved !== (lastDataRevision > savedRevision)) changed();
    return snapshot();
  }

  function needsQuitConfirmation() {
    return !!active || state.sending || terminalPendingCount > 0 || lastDataRevision > savedRevision;
  }

  async function dispose() {
    disposed = true;
    cancelTerminalQueue();
    clearTimeout(receiveIdleTimer);
    receiveIdleTimer = null;
    clearTimeout(batchTimer);
    batchTimer = null;
    if (active) await requestClose(active);
  }

  return { listPorts, snapshot, connect, disconnect, send, terminalRead, terminalWrite,
    hasActiveConnection: () => !!active,
    clear, sealReceive, markSaved, needsQuitConfirmation, dispose };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function withTimeout(promise, milliseconds, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

function nativeOptions(path, config) {
  return {
    path, autoOpen: false, baudRate: config.baudRate, dataBits: config.dataBits,
    stopBits: config.stopBits, parity: config.parity,
    rtscts: config.flowControl === 'rtscts', xon: config.flowControl === 'xonxoff', xoff: config.flowControl === 'xonxoff'
  };
}

function validPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function brief(error) {
  return String(error?.message || error || tr("未知错误")).replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').slice(0, 240);
}

function ignoreLateError() {}

function terminalError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = { createSerialService };
