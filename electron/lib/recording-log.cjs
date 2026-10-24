const { tr } = require('./localization.cjs');
const fs = require('fs');
const path = require('path');

const LOG_LIMIT_BYTES = 100 * 1024 * 1024;

async function startRecordingLog({ deviceId, videoPath, onState = () => {} }, {
  spawnAdb = require('./adb-runtime.cjs').spawnAdb, maxBytes = LOG_LIMIT_BYTES
} = {}) {
  if (!deviceId || !path.isAbsolute(videoPath) || !/\.mp4$/i.test(videoPath)) throw new Error(tr("录屏日志参数无效"));
  const file = videoPath.replace(/\.mp4$/i, '.log');
  const handle = await fs.promises.open(file, 'wx', 0o600);
  const writer = handle.createWriteStream({ autoClose: true });
  const result = { path: file, bytes: 0, truncated: false, error: '' };
  const notify = () => { try { onState({ ...result }); } catch { /* Recording state reporting must not crash the stream. */ } };
  let child;
  let stopping = false;
  let finished = false;
  let stopPromise;
  let finishResolve;
  const completion = new Promise(resolve => { finishResolve = resolve; });
  const finish = () => { if (!finished) { finished = true; finishResolve({ ...result }); } };
  writer.on('close', finish);
  writer.on('error', error => { result.error = error.message; notify(); child?.kill(); finish(); });
  const fail = error => { result.error = error.message; notify(); if (!writer.destroyed) writer.end(); };
  try {
    // This stream is independent of AI Log Analyzer and never clears device log buffers.
    child = spawnAdb(['-s', deviceId, 'logcat', '-v', 'threadtime', '-T', '1']);
    child.on('error', fail);
    let diagnostic = '';
    child.stderr.on('data', data => { diagnostic = (diagnostic + data.toString()).slice(-2000); });
    child.stdout.on('data', data => {
      if (writer.destroyed || writer.writableEnded) return;
      const remaining = maxBytes - result.bytes;
      const piece = data.subarray(0, Math.max(0, remaining));
      if (piece.length) {
        result.bytes += piece.length;
        if (!writer.write(piece)) { child.stdout.pause(); writer.once('drain', () => child.stdout.resume()); }
      }
      if (data.length > remaining && !result.truncated) {
        result.truncated = true;
        notify();
        child.kill();
      }
    });
    child.on('close', code => {
      if (!stopping && !result.truncated) {
        result.error ||= diagnostic.trim() || (code ? tr("日志采集已退出（{0}）", { 0: code }) : tr("日志采集提前结束"));
        notify();
      }
      if (!writer.destroyed && !writer.writableEnded) writer.end();
    });
  } catch (error) {
    fail(error);
    await completion;
    throw error;
  }
  return {
    info: () => ({ ...result }),
    stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      stopPromise = (async () => {
        if (!finished) child.kill();
        const timer = setTimeout(() => {
          if (!finished) { result.error ||= tr("日志采集停止超时，日志可能不完整"); notify(); child.stdout.destroy(); writer.end(); }
        }, 5000);
        try { return await completion; }
        finally { clearTimeout(timer); }
      })();
      return stopPromise;
    }
  };
}

module.exports = { startRecordingLog, LOG_LIMIT_BYTES };
