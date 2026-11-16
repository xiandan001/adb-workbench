const path = require('node:path'), { createHash } = require('node:crypto'), { Worker } = require('node:worker_threads');
const MATCH_LIMITS = Object.freeze({ rows: 1000, batchBytes: 512 * 1024, pendingBytes: 2 * 1024 * 1024, jobs: 8, rulesBytes: 1024 * 1024 });
const fault = (code, reason, ruleId = '') => Object.assign(new Error(code), { code, reason, ruleId });
function normalizeWorkerRules(value) {
  if (!Array.isArray(value) || value.length > 1000) throw fault('DIAGNOSTIC_RULE_LIMIT', 'rule-limit');
  const rules = value.filter(rule => rule.enabled !== false).map(rule => {
    for (const [key, limit] of [['id', 200], ['type', 100], ['label', 1000], ['pattern', 10000], ['flags', 8]]) {
      if (typeof rule[key] !== 'string' || rule[key].length > limit) throw fault('DIAGNOSTIC_RULE_LIMIT', 'rule-limit');
    }
    if (!rule.id || !rule.pattern || !/^[gimsuy]*$/.test(rule.flags) || new Set(rule.flags).size !== rule.flags.length
      || !Array.isArray(rule.keywords) || rule.keywords.length > 12 || rule.keywords.some(word => typeof word !== 'string' || word.length > 1000)) throw fault('DIAGNOSTIC_RULE_LIMIT', 'rule-limit');
    return { id: rule.id, type: rule.type, label: rule.label, severity: rule.severity, pattern: rule.pattern, flags: rule.flags, keywords: [...rule.keywords] };
  });
  if (new Set(rules.map(rule => rule.id)).size !== rules.length || Buffer.byteLength(JSON.stringify(rules)) > MATCH_LIMITS.rulesBytes) throw fault('DIAGNOSTIC_RULE_LIMIT', 'rule-limit');
  return rules;
}
function createDiagnosticMatcher({ deadlineMs = 250, startupMs = 10000, maxJobs = MATCH_LIMITS.jobs,
  maxPendingBytes = MATCH_LIMITS.pendingBytes, onIncomplete = () => {}, WorkerClass = Worker } = {}) {
  let rules = [], fingerprint = '', worker = null, ready = false, active = null, queue = [], pendingBytes = 0, sequence = 0;
  let deadline = null, jobDeadline = null, startup = null, disabled = false, disposed = false;
  const blocked = new Set(), reported = new Set();
  function notify(reason, ruleId = '', source = '') {
    const key = JSON.stringify([reason, ruleId, source]); if (reported.has(key)) return;
    reported.add(key); onIncomplete({ reason, ruleId, source, partial: true });
  }
  function killWorker() {
    clearTimeout(startup); startup = null; clearTimeout(deadline); deadline = null; clearTimeout(jobDeadline); jobDeadline = null;
    const previous = worker; worker = null; ready = false;
    previous?.unref?.(); if (previous) Promise.resolve(previous.terminate()).catch(() => {});
  }
  function cancel() {
    killWorker(); const jobs = [active, ...queue].filter(Boolean); active = null; queue = []; pendingBytes = 0; reported.clear();
    for (const job of jobs) job.reject(fault('DIAGNOSTIC_CANCELLED', 'cancelled'));
  }
  function failed(reason, code, ruleId = '') {
    const job = active;
    if (ruleId) blocked.add(ruleId); else disabled = true;
    killWorker();
    if (job) { active = null; pendingBytes -= job.bytes; notify(reason, ruleId, job.source); job.reject(fault(code, reason, ruleId)); }
    else notify(reason, ruleId, queue[0]?.source);
    if (disabled) {
      for (const queued of queue.splice(0)) { pendingBytes -= queued.bytes; queued.reject(fault('DIAGNOSTIC_WORKER_BLOCKED', reason)); }
    } else pump();
  }
  function boot() {
    const filename = path.join(__dirname, 'log-diagnostic-regex-worker.cjs').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
    const current = new WorkerClass(filename, { workerData: { rules: rules.filter(rule => !blocked.has(rule.id)) } }); worker = current;
    startup = setTimeout(() => { if (worker === current) failed('worker-error', 'DIAGNOSTIC_WORKER_START'); }, startupMs);
    current.on('message', message => {
      if (worker !== current) return;
      if (message.type === 'ready') { clearTimeout(startup); startup = null; ready = true; pump(); return; }
      if (!active || active.id !== message.jobId) return;
      if (message.type === 'rule-start') {
        active.ruleId = message.ruleId; const job = active;
        clearTimeout(deadline); deadline = setTimeout(() => { if (active === job) failed('timeout', 'DIAGNOSTIC_TIMEOUT', job.ruleId); }, deadlineMs); return;
      }
      if (message.type === 'error') { failed('worker-error', 'DIAGNOSTIC_WORKER_ERROR', message.ruleId); return; }
      if (message.type === 'result') {
        clearTimeout(deadline); deadline = null; clearTimeout(jobDeadline); jobDeadline = null; const job = active; active = null; pendingBytes -= job.bytes;
        job.resolve({ matches: message.matches, incomplete: blocked.size > 0, blockedRules: [...blocked] }); pump();
      }
    });
    current.on('error', () => { if (worker === current) failed('worker-error', 'DIAGNOSTIC_WORKER_ERROR', active?.ruleId); });
    current.on('exit', () => { if (worker === current) failed('worker-error', 'DIAGNOSTIC_WORKER_EXIT', active?.ruleId); });
  }
  function pump() {
    if (disposed || disabled || active || !queue.length) { if (!active && !queue.length) worker?.unref?.(); return; }
    if (!worker) { try { boot(); } catch { failed('worker-error', 'DIAGNOSTIC_WORKER_START'); } return; }
    if (!ready) return;
    worker.ref?.(); active = queue.shift();
    const job = active;
    deadline = setTimeout(() => { if (active === job) failed('timeout', 'DIAGNOSTIC_TIMEOUT', job.ruleId); }, deadlineMs);
    jobDeadline = setTimeout(() => { if (active === job) failed('job-limit', 'DIAGNOSTIC_WORKER_BUDGET'); }, Math.max(2000, deadlineMs * 8));
    worker.postMessage({ type: 'match', jobId: job.id, lines: job.lines });
  }
  function configure(value) {
    const next = normalizeWorkerRules(value), nextHash = createHash('sha256').update(JSON.stringify(next)).digest('hex');
    if (nextHash === fingerprint) return false;
    cancel(); fingerprint = nextHash; rules = next; blocked.clear(); disabled = false; return true;
  }
  function match(lines, { source = '' } = {}) {
    if (disposed) return Promise.reject(fault('DIAGNOSTIC_CANCELLED', 'cancelled'));
    if (disabled) { notify('worker-error', '', source); return Promise.reject(fault('DIAGNOSTIC_WORKER_BLOCKED', 'worker-error')); }
    if (!Array.isArray(lines) || lines.length > MATCH_LIMITS.rows || lines.some(line => typeof line !== 'string')) return Promise.reject(fault('DIAGNOSTIC_LINE_LIMIT', 'line-limit'));
    const bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
    if (bytes > MATCH_LIMITS.batchBytes) { notify('line-limit', '', source); return Promise.reject(fault('DIAGNOSTIC_LINE_LIMIT', 'line-limit')); }
    if (queue.length + Number(Boolean(active)) >= maxJobs || pendingBytes + bytes > maxPendingBytes) {
      notify('queue-limit', '', source); return Promise.reject(fault('DIAGNOSTIC_QUEUE_LIMIT', 'queue-limit'));
    }
    if (blocked.size) notify('blocked-rule', blocked.values().next().value, source);
    return new Promise((resolve, reject) => { queue.push({ id: ++sequence, lines: [...lines], bytes, source, resolve, reject, ruleId: '' }); pendingBytes += bytes; pump(); });
  }
  return { configure, match, cancel, dispose() { disposed = true; cancel(); },
    state: () => ({ pendingBytes, jobs: queue.length + Number(Boolean(active)), blockedRules: [...blocked], disabled }) };
}
module.exports = { MATCH_LIMITS, normalizeWorkerRules, createDiagnosticMatcher };
