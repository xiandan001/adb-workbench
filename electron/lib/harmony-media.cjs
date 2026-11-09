const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { tr } = require('./localization.cjs');
const { runHdc: defaultRunHdc } = require('./hdc-runtime.cjs');

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_SCREENSHOT_BYTES = 64 * 1024 * 1024;

function inspectPng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 45 || bytes.length > MAX_SCREENSHOT_BYTES || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(tr('设备未返回有效 PNG 截图，未保存为成功结果。'));
  }
  let offset = 8, width = 0, height = 0, hasData = false, ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    if (length > bytes.length - offset - 12) break;
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13) break;
      width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12);
      if (!width || !height || width > 32768 || height > 32768) break;
      if (width * height > 40 * 1000 * 1000) throw new Error(tr('截图尺寸超过 40 MP 安全上限，未保存。'));
    }
    if (type === 'IDAT') hasData = true;
    offset += length + 12;
    if (type === 'IEND') { ended = length === 0 && offset === bytes.length; break; }
  }
  if (!width || !height || !hasData || !ended) throw new Error(tr('设备截图不完整，原有本地文件未改动。'));
  return { width, height };
}

function createHarmonyMedia({ runHdc = defaultRunHdc, io = fs, uuid = randomUUID } = {}) {
  async function probeMediaCapabilities(deviceId, options = {}) {
    const response = await runHdc(deviceId, ['shell', 'uitest', 'help'], { timeoutMs: 10000, maxBuffer: 128 * 1024, ...options });
    const screenshot = response.ok && /\bscreenCap\b/.test(String(response.stdout));
    const reason = tr('设备未提供已验证的 UITest PNG 截图能力。');
    return {
      screenshot: { supported: screenshot, backend: screenshot ? 'uitest' : '', reason: screenshot ? '' : response.error || reason },
      screenPreview: { supported: screenshot, backend: screenshot ? 'screenshots' : '', reason: screenshot ? tr('这是低频截图预览，不是实时视频投屏。') : reason },
      screenRecord: { supported: false, reason: tr('尚无已验证的鸿蒙录像归属与停止协议；不会调用系统录屏开关或用 uiRecord 冒充视频。') },
      mirror: { supported: false, reason: tr('HDC 不含视频投屏服务；实时投屏需要独立组件或官方工具。') }
    };
  }
  async function captureScreenshot(deviceId, localPath, options = {}) {
    const id = uuid();
    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)) return { ok: false, code: 'INVALID_CAPTURE_ID', error: tr('截图会话标识无效。') };
    const remotePath = '/data/local/tmp/awb-' + id + '.png';
    let staging, ownedLocal = false, captureAttempted = false, result;
    const assertResponse = response => {
      if (!response?.ok) throw Object.assign(new Error(response?.error || response?.stderr || tr('鸿蒙截图未完成。')),
        { code: response?.code, cancelled: response?.cancelled === true });
    };
    try {
      if (typeof localPath !== 'string' || !path.isAbsolute(localPath) || !/\.png$/i.test(localPath)) {
        throw Object.assign(new Error(tr('截图保存路径必须是绝对 PNG 文件路径。')), { code: 'INVALID_SCREENSHOT_PATH' });
      }
      if (options.signal?.aborted) throw Object.assign(new Error(tr('用户取消')), { cancelled: true, code: 'CANCELLED' });
      const capabilities = await probeMediaCapabilities(deviceId, options);
      if (!capabilities.screenshot.supported) throw Object.assign(new Error(capabilities.screenshot.reason), { code: 'DEVICE_UNSUPPORTED' });
      await io.promises.mkdir(path.dirname(localPath), { recursive: true });
      staging = path.join(path.dirname(localPath), '.awb-screenshot-' + id + '.png');
      const handle = await io.promises.open(staging, 'wx');
      ownedLocal = true; await handle.close();
      captureAttempted = true;
      assertResponse(await runHdc(deviceId, ['shell', 'uitest', 'screenCap', '-p', remotePath], { timeoutMs: 30000, ...options }));
      assertResponse(await runHdc(deviceId, ['file', 'recv', remotePath, staging], { timeoutMs: 60000, ...options }));
      const stat = await io.promises.lstat(staging);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SCREENSHOT_BYTES) throw new Error(tr('截图文件无效或超过 64 MiB，未写入目标文件。'));
      const bytes = await io.promises.readFile(staging);
      const dimensions = inspectPng(bytes);
      if (options.signal?.aborted) throw Object.assign(new Error(tr('用户取消')), { cancelled: true, code: 'CANCELLED' });
      await io.promises.writeFile(localPath, bytes, { flag: options.overwrite === true ? 'w' : 'wx' });
      result = { ok: true, path: localPath, backend: 'uitest', ...dimensions };
    } catch (error) {
      result = { ok: false, error: error.code === 'EEXIST' ? tr('截图目标文件已存在，未覆盖原文件。') : error.message,
        code: error.code, cancelled: error.cancelled === true || options.signal?.aborted === true };
    } finally {
      if (captureAttempted) {
        try {
          const cleanup = await runHdc(deviceId, ['shell', 'rm', '-f', remotePath], { ...options, signal: undefined, isCancelled: undefined, timeoutMs: 5000, queue: false });
          if (!cleanup.ok) result.cleanupWarning = tr('截图临时文件未能清理，仅涉及本次截图文件：{0}', { 0: remotePath });
        } catch { result.cleanupWarning = tr('截图临时文件未能清理，仅涉及本次截图文件：{0}', { 0: remotePath }); }
      }
      if (ownedLocal) {
        try { await io.promises.unlink(staging); } catch (error) { if (error.code !== 'ENOENT') result.localCleanupWarning = tr('本次截图的本地暂存文件未能清理。'); }
      }
    }
    return result;
  }
  return { probeMediaCapabilities, captureScreenshot };
}

module.exports = { ...createHarmonyMedia(), createHarmonyMedia, inspectPng };
