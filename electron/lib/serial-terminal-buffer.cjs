const { tr } = require('./localization.cjs');
const MAX_BYTES = 256 * 1024;
const CHUNK_BYTES = 64 * 1024;

function terminalError(code, message) {
  return Object.assign(new Error(message), { code });
}

function checkLimit(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw terminalError('SERIAL_TERMINAL_CONFIG_INVALID', tr("串口终端缓存大小无效"));
  }
}

function createSerialTerminalBuffer({ maxBytes = MAX_BYTES, chunkBytes = CHUNK_BYTES } = {}) {
  checkLimit(maxBytes, MAX_BYTES);
  checkLimit(chunkBytes, CHUNK_BYTES);
  const ring = Buffer.alloc(maxBytes);
  let sessionId = null;
  let endOffset = 0;

  function metadata() {
    return { sessionId, startOffset: Math.max(0, endOffset - maxBytes), endOffset };
  }

  function requireSession() {
    if (sessionId === null) throw terminalError('SERIAL_TERMINAL_NO_SESSION', tr("尚无串口终端会话，请先连接串口"));
  }

  function reset(nextSessionId) {
    if (typeof nextSessionId !== 'string' || !nextSessionId.trim() || nextSessionId.length > 200
      || [...nextSessionId].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
      throw terminalError('SERIAL_TERMINAL_SESSION_INVALID', tr("串口终端会话标识无效"));
    }
    ring.fill(0);
    sessionId = nextSessionId;
    endOffset = 0;
    return metadata();
  }

  function append(bytes) {
    requireSession();
    if (!Buffer.isBuffer(bytes)) throw terminalError('SERIAL_TERMINAL_DATA_INVALID', tr("串口终端数据必须是 Buffer"));
    const nextOffset = endOffset + bytes.length;
    if (!Number.isSafeInteger(nextOffset)) throw terminalError('SERIAL_TERMINAL_OFFSET_INVALID', tr("串口终端数据位置超出范围，请重新连接"));
    if (!bytes.length) return endOffset;
    // A large callback copies only the retained suffix; ordinary appends touch
    // only new bytes and wrap at most once, never clone the whole history.
    const sourceStart = Math.max(0, bytes.length - maxBytes);
    const length = bytes.length - sourceStart;
    const target = (endOffset + sourceStart) % maxBytes;
    const firstLength = Math.min(length, maxBytes - target);
    bytes.copy(ring, target, sourceStart, sourceStart + firstLength);
    if (firstLength < length) bytes.copy(ring, 0, sourceStart + firstLength);
    endOffset = nextOffset;
    return endOffset;
  }

  function read(request = {}) {
    requireSession();
    const { sessionId: requestedSession, offset } = request || {};
    if (requestedSession !== sessionId) {
      throw terminalError('SERIAL_TERMINAL_SESSION_CHANGED', tr("串口会话已变化，请重新获取当前会话后查看终端"));
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > endOffset) {
      throw terminalError('SERIAL_TERMINAL_OFFSET_INVALID', tr("串口终端读取位置无效，请重新同步当前会话"));
    }
    const state = metadata();
    const position = Math.max(offset, state.startOffset);
    const length = Math.min(chunkBytes, endOffset - position);
    const start = position % maxBytes;
    const firstLength = Math.min(length, maxBytes - start);
    const hex = ring.subarray(start, start + firstLength).toString('hex')
      + (firstLength < length ? ring.subarray(0, length - firstLength).toString('hex') : '');
    return { ...state, nextOffset: position + length, hex, truncated: offset < state.startOffset };
  }

  return { reset, append, read };
}

module.exports = { createSerialTerminalBuffer };
