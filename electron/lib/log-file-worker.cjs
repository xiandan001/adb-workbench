const { parentPort, workerData } = require('node:worker_threads');
const { readLogFile } = require('./log-file-reader.cjs');

async function run() {
  const result = await readLogFile(workerData.filePath, { requestId: workerData.requestId,
    onProgress: stats => parentPort.postMessage({ type: 'progress', stats }) });
  let sequence = 0;
  for (let offset = 0; offset < result.entries.length;) {
    let end = offset, bytes = 0;
    while (end < result.entries.length && end - offset < 1000) {
      const size = Buffer.byteLength(result.entries[end].raw);
      if (end > offset && bytes + size > 1024 * 1024) break;
      bytes += size; end++;
    }
    const ticket = sequence++;
    await new Promise(resolve => {
      const accept = message => { if (message.type === 'ack' && message.sequence === ticket) { parentPort.off('message', accept); resolve(); } };
      parentPort.on('message', accept);
      parentPort.postMessage({ type: 'chunk', sequence: ticket, entries: result.entries.slice(offset, end) });
    });
    offset = end;
  }
  parentPort.postMessage({ type: 'done', stats: result.stats }); parentPort.close();
}
run().catch(error => { parentPort.postMessage({ type: 'error', error: error.message }); parentPort.close(); });
