const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeRunManifest } = require('../electron/lib/task-run-manifest.cjs');

for (const status of ['success', 'failed', 'cancelled']) {
  test(`${status} replay writes an indexable manifest with failure evidence`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-workbench-manifest-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const record = {
      id: `task-${status}`, scriptName: '录制流程', mode: 'replay', status,
      artifactDir: directory, startedAt: '2026-10-20T00:00:00Z', endedAt: '2026-10-20T00:01:00Z',
      error: status === 'failed' ? '找不到控件' : '',
      logs: [{ at: '2026-10-20T00:00:01Z', message: '执行步骤' }],
      deviceRuns: [{ deviceId: 'device-A', status, steps: [{ label: '点击', status, error: '找不到控件' }] }]
    };
    writeRunManifest(record);
    const result = JSON.parse(fs.readFileSync(record.runResultPath, 'utf8'));
    assert.equal(path.basename(record.runResultPath), 'run-result.json');
    assert.equal(result.status, status);
    assert.equal(result.devices[0].deviceId, 'device-A');
    assert.equal(result.deviceRuns[0].steps[0].error, '找不到控件');
    assert.equal(result.artifactDir, directory);
    assert.equal(result.logs[0].message, '执行步骤');
  });
}
