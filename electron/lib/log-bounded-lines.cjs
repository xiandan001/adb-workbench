const MAX_LOG_LINE_BYTES = 1024 * 1024;

function createBoundedLines(onLine, maxLineBytes = MAX_LOG_LINE_BYTES) {
  let pieces = [], bytes = 0, oversized = false;
  const stats = { lineCount: 0, omittedLines: 0, omittedBytes: 0, maxPendingBytes: 0 };
  function finish() {
    stats.lineCount++;
    if (oversized) { stats.omittedLines++; stats.omittedBytes += bytes; }
    else {
      let raw = pieces.length ? Buffer.concat(pieces, bytes) : Buffer.alloc(0);
      if (raw.at(-1) === 13) raw = raw.subarray(0, raw.length - 1);
      onLine(raw.toString('utf8'), stats.lineCount);
    }
    pieces = []; bytes = 0; oversized = false;
  }
  return {
    push(input) {
      const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input);
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset), end = newline < 0 ? chunk.length : newline;
        const piece = chunk.subarray(offset, end); bytes += piece.length;
        if (bytes > maxLineBytes) { oversized = true; pieces = []; }
        else if (!oversized && piece.length) { pieces.push(piece); stats.maxPendingBytes = Math.max(stats.maxPendingBytes, bytes); }
        if (newline >= 0) finish();
        offset = end + 1;
      }
    },
    end() { if (bytes || oversized) finish(); },
    stats: () => ({ ...stats, pendingBytes: oversized ? 0 : bytes })
  };
}
module.exports = { MAX_LOG_LINE_BYTES, createBoundedLines };
