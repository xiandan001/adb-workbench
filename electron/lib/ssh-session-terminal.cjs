const { tr } = require('./localization.cjs');
const { createSerialTerminalBuffer } = require('./serial-terminal-buffer.cjs');
const { createSshShellIntegration } = require('./ssh-shell-integration.cjs');

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_QUEUE_ITEMS = 256;

function createSshTerminal({ sessionId, terminalId, title, cols, rows, assertCurrent, onChange, onShellCommand = () => {}, writeTimeoutMs = 10000 }) {
  const output = createSerialTerminalBuffer();
  output.reset(sessionId);
  const queue = [];
  let channel = null;
  let current = null;
  let queuedBytes = 0;
  let queuedItems = 0;
  let rxBytes = 0;
  let txBytes = 0;
  let status = 'opening';
  let error = '';
  let exitCode = null;
  let exitSignal = null;
  let detach = () => {};
  let outputBytes = 0;
  let markerId = 0;
  let promptOffset;
  const shellMarkers = [];
  let integrationWait = null;
  let integrationTimer;
  let integrationPending = false;
  let integrationAttempted = false;
  const integration = createSshShellIntegration({
    onData: bytes => {
      outputBytes = output.append(bytes);
      while (shellMarkers.length && shellMarkers[0].offset < Math.max(0, outputBytes - 256 * 1024)) shellMarkers.shift();
    },
    onMarker: marker => {
      if (marker.kind === 'prompt') promptOffset = outputBytes;
      shellMarkers.push({ ...marker, id: ++markerId, offset: outputBytes });
      if (shellMarkers.length > 256) shellMarkers.shift();
    },
    onCommand: command => { try { assertCurrent(); onShellCommand(command); } catch {} },
    onChange: state => {
      if (integrationWait && state.status === 'ready' && state.phase === 'prompt') settleIntegration();
      else if (integrationWait && ['error', 'unsupported'].includes(state.status)) settleIntegration(sshError('SSH_SHELL_INTEGRATION_FAILED', state.error));
      onChange();
    }
  });
  const shellState = () => ({ ...integration.snapshot(), ...(promptOffset === undefined ? {} : { promptOffset }) });
  function settleIntegration(failure) {
    const waiting = integrationWait; integrationWait = null; integrationPending = false; clearTimeout(integrationTimer);
    if (failure) waiting?.reject(failure); else waiting?.resolve(shellState());
  }

  function snapshot() {
    return { id: terminalId, title, status, error, cols, rows, rxBytes, txBytes, queuedBytes,
      startOffset: Math.max(0, outputBytes - 256 * 1024), endOffset: outputBytes, exitCode, exitSignal, shellIntegration: shellState() };
  }

  function failQueue(failure) {
    for (const item of queue.splice(0)) finishItem(item, failure);
    if (current) finishItem(current, current.started
      ? sshError('SSH_WRITE_UNKNOWN', tr("SSH 终端写入中断，发送结果无法确认；未写入输入不会重播")) : failure);
    current = null;
  }

  function finishItem(item, failure, result) {
    if (item.settled) return;
    item.settled = true;
    clearTimeout(item.timer);
    if (typeof item.onDrain === 'function') channel?.removeListener('drain', item.onDrain);
    queuedBytes -= item.bytes.length;
    queuedItems--;
    if (failure) item.reject(failure); else item.resolve(result);
  }

  function close(failure) {
    if (status === 'closed' || status === 'error') return;
    status = failure ? 'error' : 'closed';
    error = failure?.message || '';
    settleIntegration(sshError('SSH_TERMINAL_CLOSED', tr("SSH 终端已关闭，命令识别已取消")));
    integration.close();
    failQueue(sshError('SSH_TERMINAL_CLOSED', tr("SSH 终端已关闭，未写入输入已取消")));
    detach();
    closeChannel(channel);
    onChange();
  }

  function failOpen() {
    status = 'error';
    error = tr("无法打开 SSH 终端；仍可使用文件功能");
    onChange();
  }

  function attach(stream) {
    if (status !== 'opening') { closeChannel(stream); return; }
    channel = stream;
    const data = value => {
      if (status !== 'ready') return;
      if (!Buffer.isBuffer(value) && !ArrayBuffer.isView(value)) return;
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      integration.feed(bytes); rxBytes += bytes.length; onChange();
    };
    const failed = () => close(sshError('SSH_TERMINAL_FAILED', tr("SSH 终端通道已中断")));
    const closed = () => close();
    const exited = (code, signal) => {
      exitCode = Number.isInteger(code) ? code : null;
      exitSignal = typeof signal === 'string' && /^[A-Z0-9_-]{1,24}$/.test(signal) ? signal : null;
      onChange();
    };
    stream.on('data', data); stream.on('error', failed); stream.on('close', closed); stream.on('exit', exited);
    stream.stderr?.on('data', data); stream.stderr?.on('error', failed);
    detach = () => {
      stream.removeListener('data', data); stream.removeListener('error', failed); stream.removeListener('close', closed); stream.removeListener('exit', exited);
      stream.stderr?.removeListener('data', data); stream.stderr?.removeListener('error', failed);
      stream.on('error', ignoreLateError); stream.stderr?.on('error', ignoreLateError);
    };
    status = 'ready'; onChange();
  }

  function read({ offset }) {
    try {
      const result = output.read({ sessionId, offset });
      return { ...result, terminalId, shellIntegration: shellState(), shellMarkers: shellMarkers.filter(marker => marker.offset >= Math.max(offset, result.startOffset) && marker.offset <= result.nextOffset) };
    }
    catch { throw sshError('SSH_TERMINAL_OFFSET_INVALID', tr("SSH 终端读取位置无效，请重新同步")); }
  }

  function pump() {
    if (current || !queue.length || status !== 'ready') return;
    try { assertCurrent(); } catch { close(); return; }
    const item = queue.shift(); current = item;
    item.onDrain = () => { item.drained = true; complete(); };
    const complete = () => {
      if (item.settled || !item.returned || !item.callbackDone || (item.needsDrain && !item.drained)) return;
      txBytes += item.bytes.length;
      finishItem(item, null, { bytes: item.bytes.length });
      current = null; onChange(); queueMicrotask(pump);
    };
    channel.on('drain', item.onDrain);
    item.timer = setTimeout(() => close(sshError('SSH_WRITE_UNKNOWN', tr("SSH 终端写入超时，发送结果无法确认；未写入输入不会重播"))), writeTimeoutMs);
    try {
      item.started = true;
      item.needsDrain = channel.write(item.bytes, failure => {
        if (item.settled) return;
        if (failure) { close(sshError('SSH_WRITE_UNKNOWN', tr("SSH 终端写入失败，发送结果无法确认；未写入输入不会重播"))); return; }
        item.callbackDone = true; complete();
      }) === false;
      item.returned = true; complete();
    } catch { close(sshError('SSH_WRITE_UNKNOWN', tr("SSH 终端写入失败，发送结果无法确认；未写入输入不会重播"))); }
  }

  function write({ content }, bootstrap = false) {
    try {
      assertCurrent();
      if (status !== 'ready') throw sshError('SSH_TERMINAL_NOT_READY', tr("SSH 终端尚未就绪或已经关闭"));
      if (integrationPending && !bootstrap) throw sshError('SSH_SHELL_INTEGRATION_BUSY', tr("正在启用 Bash 命令识别，请稍候再输入"));
      if (typeof content !== 'string' || !content.length || content.length > MAX_INPUT_BYTES || Buffer.byteLength(content) > MAX_INPUT_BYTES) {
        throw sshError('SSH_TERMINAL_INPUT_INVALID', tr("SSH 终端输入应为非空文本，单次不超过 64 KiB"));
      }
      const bytes = Buffer.from(content, 'utf8');
      if (queuedItems >= MAX_QUEUE_ITEMS || queuedBytes + bytes.length > MAX_INPUT_BYTES) throw sshError('SSH_TERMINAL_BACKPRESSURE', tr("SSH 终端发送队列已满，请稍候；本次输入尚未接受"));
      const item = { bytes, settled: false, started: false, returned: false, callbackDone: false, drained: false };
      const promise = new Promise((resolve, reject) => { item.resolve = resolve; item.reject = reject; });
      queue.push(item); queuedBytes += bytes.length; queuedItems++; onChange(); pump();
      return promise;
    } catch (failure) { return Promise.reject(failure); }
  }

  async function resize(size) {
    assertCurrent();
    const next = terminalSize(size);
    if (status !== 'ready') throw sshError('SSH_TERMINAL_NOT_READY', tr("SSH 终端尚未就绪或已经关闭"));
    try { channel.setWindow(next.rows, next.cols, 0, 0); }
    catch { throw sshError('SSH_TERMINAL_RESIZE_FAILED', tr("SSH 终端尺寸调整失败")); }
    cols = next.cols; rows = next.rows; onChange();
    return { cols, rows };
  }

  function startShellIntegration(nonce, timeoutMs = 15000, { allowOpening = false } = {}) {
    assertCurrent();
    if (status !== 'ready' && !(allowOpening && status === 'opening') || queuedItems) throw sshError('SSH_SHELL_INTEGRATION_BUSY', tr("请等待终端输入发送完成，并确认处于空 Bash 提示符"));
    if (integrationAttempted) throw sshError('SSH_SHELL_INTEGRATION_EXISTS', tr("此终端已经尝试启用命令识别；如未成功，请新建终端后重试"));
    integrationAttempted = true; integrationPending = true;
    const promise = new Promise((resolve, reject) => { integrationWait = { resolve, reject }; });
    promise.catch(() => {});
    integration.start(nonce);
    integrationTimer = setTimeout(() => integration.fail(allowOpening
      ? tr("自动命令识别未能就绪，未重复启动终端；请检查 Shell 状态或新建终端重试") : undefined), timeoutMs);
    return promise;
  }
  function failShellIntegration(message = tr("命令识别启用失败，原终端仍可使用；请确认 Bash 提示符后在新终端重试")) { integration.fail(message); }
  function disableShellIntegration() { settleIntegration(sshError('SSH_SHELL_INTEGRATION_CANCELLED', tr("命令识别已停用"))); integration.disable(); return shellState(); }

  return { snapshot, attach, read, write, resize, close, failOpen, startShellIntegration, failShellIntegration, disableShellIntegration,
    writeBootstrap: content => write({ content }, true) };
}

function terminalSize({ cols = 80, rows = 24 } = {}) {
  if (!Number.isInteger(cols) || cols < 2 || cols > 1000 || !Number.isInteger(rows) || rows < 1 || rows > 500) throw sshError('SSH_TERMINAL_SIZE_INVALID', tr("SSH 终端尺寸无效（列 2–1000，行 1–500）"));
  return { cols, rows };
}

function closeChannel(channel) {
  if (!channel) return;
  if (typeof channel.on === 'function' && !channel.listenerCount?.('error')) channel.on('error', ignoreLateError);
  if (channel.stderr?.on && !channel.stderr.listenerCount?.('error')) channel.stderr.on('error', ignoreLateError);
  try { channel.end?.(); } catch {}
  try { if (typeof channel.close === 'function') channel.close(); else channel.destroy?.(); } catch {}
}

function sshError(code, message) { return Object.assign(new Error(message), { code }); }
function ignoreLateError() {}

module.exports = { createSshTerminal, terminalSize, closeChannel, sshError };
