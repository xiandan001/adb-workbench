const { tr } = require('./localization.cjs');
const { randomBytes } = require('node:crypto');
const HEADER_BYTES = 20;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

function sessionPaths(id) {
  if (!UUID.test(id)) throw new Error(tr('媒体会话标识无效。'));
  const directory = '/data/local/tmp/awb-media-' + id;
  return { directory, agent: directory + '/agent.so', config: directory + '/config', ready: directory + '/ready.json',
    extension: 'awb-media-' + id + '/agent.so' };
}
function captureSize(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16 || width * height > 40 * 1000 * 1000) throw new Error(tr('屏幕尺寸无效或超过安全上限。'));
  const scale = Math.min(1, 1280 / Math.max(width, height));
  return { width: Math.max(16, Math.floor(width * scale / 2) * 2), height: Math.max(16, Math.floor(height * scale / 2) * 2) };
}
function createAgentConfig(id, sourceSize, options = {}) {
  sessionPaths(id);
  const token = randomBytes(32).toString('hex');
  const size = captureSize(sourceSize.width, sourceSize.height);
  const fps = Number.isInteger(options.fps) ? options.fps : 20;
  const bitrate = Number.isInteger(options.bitrate) ? options.bitrate : 3000000;
  if (fps < 5 || fps > 30 || bitrate < 100000 || bitrate > 12000000) throw new Error(tr('视频采集参数无效。'));
  return { id, token, ...size, fps, bitrate,
    content: ['AWB_MEDIA_1', id, token, size.width, size.height, fps, bitrate, ''].join('\n') };
}
function parseReady(text, id) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 4096) throw new Error(tr('媒体组件握手信息无效。'));
  const value = JSON.parse(text);
  if (value.protocol !== 1 || value.sessionId !== id || !Number.isSafeInteger(value.pid) || value.pid <= 1
    || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.uitestVersion !== 'string'
    || value.uitestVersion.length > 255) throw new Error(tr('媒体组件握手信息无效。'));
  return { pid: value.pid, port: value.port, uitestVersion: value.uitestVersion };
}
function parseUiTestVersion(value) {
  const versions = String(value || '').split(/\r?\n/).map(line => line.trim()).filter(line => /^\d+\.\d+\.\d+\.\d+$/.test(line));
  if (versions.length !== 1 || Number(versions[0].split('.')[0]) < 5 || Number(versions[0].split('.')[0]) > 7) {
    throw new Error(tr('设备 UITest 版本不支持已验证的独立媒体扩展，未改动现有服务。'));
  }
  return versions[0];
}
function createFrameParser(onPacket) {
  let buffered = Buffer.alloc(0);
  return {
    push(chunk) {
      if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
      if (buffered.length + chunk.length > MAX_BUFFER_BYTES) throw new Error(tr('媒体接收缓冲区超过安全上限。'));
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
      while (buffered.length >= HEADER_BYTES) {
        if (buffered.toString('ascii', 0, 4) !== 'AWBM' || buffered[4] !== 1 || buffered[7] !== 0) throw new Error(tr('媒体帧协议无效。'));
        const kind = buffered[5], flags = buffered[6], size = buffered.readUInt32BE(8), timestamp = buffered.readBigUInt64BE(12);
        if (![1, 2, 3].includes(kind) || flags & ~3 || size > (kind === 2 ? MAX_FRAME_BYTES : 16384)
          || timestamp > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(tr('媒体帧长度或时间戳无效。'));
        if (buffered.length < HEADER_BYTES + size) break;
        const data = Buffer.from(buffered.subarray(HEADER_BYTES, HEADER_BYTES + size));
        buffered = buffered.subarray(HEADER_BYTES + size);
        if (kind === 2) onPacket({ kind: 'video', flags, timestamp: Number(timestamp), data });
        else {
          const value = JSON.parse(data.toString('utf8'));
          if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
            || typeof value.state !== 'string' || value.state.length > 500 || !Number.isInteger(value.code)) throw new Error(tr('媒体组件状态格式无效。'));
          onPacket({ kind: kind === 3 ? 'error' : 'state', state: value.state, code: value.code });
        }
      }
    },
    end() { if (buffered.length) throw new Error(tr('媒体帧接收不完整。')); },
    bufferedBytes: () => buffered.length
  };
}

module.exports = { HEADER_BYTES, MAX_FRAME_BYTES, UUID, sessionPaths, captureSize, createAgentConfig, parseReady, parseUiTestVersion, createFrameParser };
