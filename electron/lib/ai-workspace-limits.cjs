const policy = require('./ai-context-limits.json');

module.exports = Object.freeze({
  sourceBytes: policy.contentBytes,
  evidenceBytes: policy.contentBytes,
  inputBytes: 1280 * 1024,
  logcatBufferBytes: 2 * 1024 * 1024,
  captureRecords: 8000,
  recentLines: 2000,
  turns: 6,
  reports: 20,
  reportBytes: policy.carrierBytes,
  historyBytes: policy.historyBytes,
});
