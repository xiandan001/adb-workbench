const fs = require('node:fs');
const { createLogCaptureBuffer } = require('./log-capture-buffer.cjs');
const { createBoundedLines, MAX_LOG_LINE_BYTES } = require('./log-bounded-lines.cjs');
const { parseLogLine } = require('./log-line-parser.cjs');

const FILE_LIMITS = Object.freeze({ maxEntries: 200000, maxBytes: 100 * 1024 * 1024, maxLineBytes: MAX_LOG_LINE_BYTES });
async function readLogFile(file, { requestId, signal, onProgress = () => {}, ...limits } = {}) {
  const options = { ...FILE_LIMITS, ...limits }, stat = await fs.promises.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('LOG_FILE_NOT_REGULAR');
  const store = createLogCaptureBuffer(options); let readBytes = 0, lastProgress = 0;
  const parser = createBoundedLines((raw, line) => store.push(parseLogLine('file', raw, { id: `file:${requestId}:${line}` })), options.maxLineBytes);
  const state = () => ({ requestId, readBytes, totalBytes: stat.size, ...parser.stats(), keptCount: store.length, keptBytes: store.bytes,
    truncated: store.truncated || parser.stats().omittedLines > 0 });
  const stream = fs.createReadStream(file, { highWaterMark: 64 * 1024, signal });
  onProgress(state());
  for await (const chunk of stream) {
    if (signal?.aborted) throw Object.assign(new Error('LOG_IMPORT_CANCELLED'), { name: 'AbortError' });
    readBytes += chunk.length; parser.push(chunk);
    if (Date.now() - lastProgress >= 100) { lastProgress = Date.now(); onProgress(state()); }
  }
  const after = await fs.promises.lstat(file);
  if (!after.isFile() || after.isSymbolicLink() || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino || readBytes !== stat.size) throw Error('LOG_FILE_CHANGED');
  parser.end(); onProgress(state());
  return { entries: store.toArray(), stats: state() };
}
module.exports = { FILE_LIMITS, readLogFile };
