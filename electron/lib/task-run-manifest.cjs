const fs = require('fs');
const path = require('path');

function writeRunManifest(record) {
  const outputDir = record.artifactDir || (record.artifactBaseDir
    ? path.join(record.artifactBaseDir, `run-${String(record.id).replace(/[^a-zA-Z0-9_-]/g, '_')}`)
    : '');
  if (!outputDir) throw new Error('任务缺少证据目录');
  fs.mkdirSync(outputDir, { recursive: true });
  const runResultPath = path.join(outputDir, 'run-result.json');
  const manifest = {
    schemaVersion: 1,
    id: record.id,
    scriptName: record.scriptName,
    mode: record.mode || 'replay',
    status: record.status,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    error: record.error || '',
    completedSteps: record.completedSteps || 0,
    failedSteps: record.failedSteps || 0,
    totalSteps: record.totalSteps || 0,
    artifactDir: outputDir,
    runResultPath,
    stressReportPath: record.stressReportPath || '',
    stressResultPath: record.stressResultPath || '',
    logs: record.logs || [],
    deviceRuns: record.deviceRuns || [],
    devices: (record.deviceRuns || []).map(run => ({ deviceId: run.deviceId, status: run.status }))
  };
  fs.writeFileSync(runResultPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  record.artifactDir = outputDir;
  record.runResultPath = runResultPath;
  return manifest;
}

module.exports = { writeRunManifest };
