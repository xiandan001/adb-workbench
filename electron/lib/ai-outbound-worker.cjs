const { parentPort, workerData } = require('node:worker_threads');
const { withLocale } = require('./localization.cjs');
const { prepareBatch, stripPrivateTaskSnapshot } = require('./ai-outbound-policy.cjs');
try {
  const result = withLocale(workerData.locale, () => workerData.operation === 'artifact'
    ? stripPrivateTaskSnapshot(workerData.artifact) : prepareBatch(workerData.bodies, { contentFormat: workerData.contentFormat }));
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({ ok: false, code: error.code || 'AI_SEND_INPUT', error: error.message });
}
