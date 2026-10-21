const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function createRunComparisonIdentity(script, options = {}) {
  const content = {
    mode: script.mode || 'replay',
    steps: script.steps || [],
    continueOnError: options.continueOnError ?? script.continueOnError ?? true,
    concurrency: Math.max(1, Math.min(Number(options.concurrency) || 1, 4))
  };
  return {
    comparisonVersion: 1,
    scriptId: script.id || '',
    scriptHash: crypto.createHash('sha256').update(canonicalJson(content)).digest('hex'),
    scriptSteps: content.steps.map(step => ({ id: step.id, type: step.type, label: step.label }))
  };
}

function deviceComparisonIdentity(identity) {
  const result = {};
  for (const key of ['androidId', 'wifiMac', 'roBootSerialno', 'roSerialno']) {
    const value = String(identity?.[key] || '').trim();
    const lower = value.toLowerCase();
    if (!value || ['null', 'unknown', '<unknown>', 'undefined', '0123456789abcdef', '1234567890'].includes(lower) || /^0+$/.test(lower)) continue;
    if (key === 'androidId' && (lower === '9774d56d682e549c' || !/^[a-f0-9]{16}$/.test(lower))) continue;
    if (key === 'wifiMac' && (!/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/.test(lower) || ['00:00:00:00:00:00', '02:00:00:00:00:00'].includes(lower))) continue;
    result[key] = crypto.createHash('sha256').update(`${key}:${key === 'wifiMac' || key === 'androidId' ? lower : value}`).digest('hex');
  }
  return result;
}

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
    comparisonVersion: record.comparisonVersion,
    scriptId: record.scriptId || '',
    scriptHash: record.scriptHash || '',
    scriptSteps: record.scriptSteps || [],
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

module.exports = { writeRunManifest, createRunComparisonIdentity, deviceComparisonIdentity };
