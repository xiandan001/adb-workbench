const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { tr } = require('./localization.cjs');

const MAX_SNAPSHOT_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;
const TTL = 5 * 60 * 1000;
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code, safe: true });
const invalid = () => fail('TASK_RERUN_INVALID', tr('复跑预览无效或已过期，请重新检查原运行。'));
const aborted = signal => { if (signal?.aborted) throw fail('CANCELLED', tr('操作已取消')); };

function inputReferences(script) {
  const references = [];
  for (const [index, step] of (script.steps || []).entries()) {
    const field = ['installApk', 'pushFile'].includes(step.type) ? 'localPath' : step.type === 'imageCompare' ? (step.baselinePath ? 'baselinePath' : 'localPath') : step.type === 'externalScript' ? 'scriptPath' : '';
    if (!field || !step[field]) continue;
    if (typeof step[field] !== 'string' || !path.isAbsolute(step[field]) || step[field].length > 4000 || references.length >= 64) throw invalid();
    references.push({ stepId: String(step.id || index), field, path: path.normalize(step[field]) });
  }
  return references;
}

async function hashInput(reference, { signal, io = fs, maxBytes = MAX_FILE_BYTES } = {}) {
  aborted(signal);
  let descriptor;
  try {
    const stat = await io.promises.lstat(reference.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > Math.min(MAX_FILE_BYTES, maxBytes)) return { ...reference, state: 'unavailable' };
    descriptor = await io.promises.open(reference.path, 'r');
    const opened = await descriptor.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs) return { ...reference, state: 'changed' };
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(256 * 1024); let position = 0;
    while (position < stat.size) {
      aborted(signal);
      const { bytesRead } = await descriptor.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (!bytesRead) return { ...reference, state: 'changed' };
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    const after = await descriptor.stat(), pathAfter = await io.promises.lstat(reference.path);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || pathAfter.isSymbolicLink() || pathAfter.dev !== stat.dev || pathAfter.ino !== stat.ino
      || pathAfter.size !== stat.size || pathAfter.mtimeMs !== stat.mtimeMs) return { ...reference, state: 'changed' };
    return { ...reference, state: 'available', size: stat.size, sha256: hash.digest('hex') };
  } catch (error) {
    if (error.code === 'CANCELLED') throw error;
    return { ...reference, state: error.code === 'ENOENT' ? 'missing' : 'unavailable' };
  } finally { if (descriptor) await descriptor.close(); }
}

async function fingerprintInputs(script, options = {}) {
  const inputs = [], hashes = new Map(); let totalBytes = 0;
  for (const reference of inputReferences(script)) {
    aborted(options.signal);
    const key = process.platform === 'win32' ? reference.path.toLowerCase() : reference.path;
    if (!hashes.has(key)) {
      const input = await hashInput(reference, { ...options, maxBytes: 8 * 1024 * 1024 * 1024 - totalBytes });
      totalBytes += input.size || 0; hashes.set(key, input);
    }
    const input = { ...hashes.get(key), ...reference };
    inputs.push(input);
  }
  return inputs;
}

async function captureRunSnapshot(script, runOptions = {}, options = {}) {
  const copy = clone(script);
  if (!Array.isArray(copy.steps) || !copy.steps.length || Buffer.byteLength(JSON.stringify(copy)) > MAX_SNAPSHOT_BYTES) {
    return { version: 1, unavailable: tr('原脚本过大，未保存可复跑快照；请在任务编辑器核对后重新运行。') };
  }
  try {
    return { version: 1, script: copy, scriptHash: digest(copy), inputs: await fingerprintInputs(copy, options),
      runOptions: { continueOnError: runOptions.continueOnError ?? copy.continueOnError, concurrency: Math.max(1, Math.min(4, Number(runOptions.concurrency) || 1)) } };
  } catch (error) {
    if (error.code === 'CANCELLED') throw error;
    return { version: 1, unavailable: tr('原运行输入无法建立可靠快照，请在任务编辑器核对后重新运行。') };
  }
}

function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== 1 || !snapshot.script || !Array.isArray(snapshot.script.steps) || !snapshot.script.steps.length
    || Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT_BYTES + 512 * 1024 || snapshot.scriptHash !== digest(snapshot.script)
    || !Array.isArray(snapshot.inputs) || snapshot.inputs.length > 64 || !snapshot.runOptions || typeof snapshot.runOptions.continueOnError !== 'boolean'
    || !Number.isInteger(snapshot.runOptions.concurrency) || snapshot.runOptions.concurrency < 1 || snapshot.runOptions.concurrency > 4) throw invalid();
  const refs = inputReferences(snapshot.script);
  if (refs.length !== snapshot.inputs.length || refs.some((ref, i) => ['path', 'stepId', 'field'].some(key => ref[key] !== snapshot.inputs[i]?.[key]))) throw invalid();
  for (const input of snapshot.inputs) if (!['available', 'missing', 'unavailable', 'changed'].includes(input.state)
    || (input.state === 'available' && (!/^[a-f\d]{64}$/.test(input.sha256 || '') || !Number.isSafeInteger(input.size) || input.size < 0 || input.size > MAX_FILE_BYTES))) throw invalid();
  return clone(snapshot);
}

function compareInputs(before, after) {
  return after.map((input, index) => ({ ...input, previous: before[index], changed: input.state !== before[index]?.state
    || input.sha256 !== before[index]?.sha256 || input.path !== before[index]?.path }));
}

function createTaskRerunService({ getRun, getOnlineDevices, verifyDevices = async () => true, confirm, startRun, now = Date.now, fingerprints = fingerprintInputs }) {
  const previews = new Map();
  function prune() { for (const [id, item] of previews) if (item.expiresAt <= now()) previews.delete(id); }
  function ownerKey(owner) { return typeof owner === 'object' ? owner?.id : owner; }
  return {
    async preview({ taskId }, owner) {
      prune();
      const record = await getRun(taskId);
      if (!record || !['failed', 'cancelled', 'success'].includes(record.status)) throw invalid();
      if (!record.rerunSnapshot?.script) return { available: false, reason: tr('此运行没有可靠的原脚本快照，不能自动复跑；请在任务编辑器重新核对。') };
      const snapshot = validateSnapshot(record.rerunSnapshot);
      const failed = (record.deviceRuns || []).filter(run => run.status === 'failed' || (run.steps || []).some(step => step.status === 'failed'));
      const ids = [...new Set(failed.map(run => run.deviceId))];
      if (!ids.length) return { available: false, reason: tr('此运行没有可复跑的失败设备。') };
      const current = await fingerprints(snapshot.script), online = new Set((await getOnlineDevices()).filter(device => device.status === 'device').map(device => device.id));
      const id = randomUUID(), expiresAt = now() + TTL;
      const preview = { id, available: true, parentTaskId: record.id, scriptName: snapshot.script.name, scriptHash: snapshot.scriptHash,
        script: clone(snapshot.script),
        steps: snapshot.script.steps.map(step => ({ id: step.id, type: step.type, label: step.label })),
        failedDeviceIds: ids, offlineDeviceIds: ids.filter(deviceId => !online.has(deviceId)), inputs: compareInputs(snapshot.inputs, current),
        expiresAt: new Date(expiresAt).toISOString(), fromStep: 1 };
      while (previews.size >= 8) previews.delete(previews.keys().next().value);
      previews.set(id, { owner: ownerKey(owner), record: clone(record), snapshot, current, preview, expiresAt, running: false });
      return clone(preview);
    },
    async run({ previewId, deviceIds, acceptInputChanges }, owner) {
      prune(); const stored = previews.get(previewId);
      if (!stored || stored.owner !== ownerKey(owner) || stored.running || !Array.isArray(deviceIds) || !deviceIds.length
        || new Set(deviceIds).size !== deviceIds.length || deviceIds.some(id => !stored.preview.failedDeviceIds.includes(id))) throw invalid();
      if (stored.current.some(input => input.state !== 'available')) throw fail('TASK_INPUT_UNAVAILABLE', tr('输入文件缺失或不可读取，未开始复跑。'));
      if (stored.preview.inputs.some(input => input.changed) && acceptInputChanges !== true) throw fail('TASK_INPUT_CHANGED', tr('输入文件已变化，请明确确认变化后再复跑。'));
      stored.running = true;
      try {
        if (!await confirm(clone(stored.preview), [...deviceIds])) return { cancelled: true };
        if (previews.get(previewId) !== stored || stored.expiresAt <= now()) throw invalid();
        const online = new Set((await getOnlineDevices()).filter(device => device.status === 'device').map(device => device.id));
        if (deviceIds.some(id => !online.has(id)) || !await verifyDevices(stored.record, deviceIds)) throw fail('TASK_RERUN_DEVICE', tr('无法确认失败设备仍是原设备，未开始复跑。'));
        const current = await fingerprints(stored.snapshot.script);
        if (digest(current) !== digest(stored.current)) throw fail('TASK_INPUT_CHANGED_AGAIN', tr('预览后输入文件再次变化，请重新生成复跑预览。'));
        if (previews.get(previewId) !== stored || stored.expiresAt <= now()) throw invalid();
        previews.delete(previewId);
        return startRun(clone(stored.snapshot.script), [...deviceIds], { ...stored.snapshot.runOptions },
          { parentTaskId: stored.record.id, analysisOrigin: stored.record.analysisOrigin || null,
            aiTargetDeviceId: stored.record.aiTargetDeviceId || '',
            rerunSnapshot: { ...clone(stored.snapshot), inputs: current } }, owner);
      } finally { stored.running = false; }
    },
    clearOwner(owner) { for (const [id, item] of previews) if (item.owner === ownerKey(owner)) previews.delete(id); },
    clear() { previews.clear(); },
  };
}

module.exports = { createTaskRerunService, captureRunSnapshot, validateSnapshot, fingerprintInputs, hashInput, compareInputs, TTL };
