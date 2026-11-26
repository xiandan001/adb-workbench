const { randomUUID } = require('node:crypto');

const livePhases = new Set(['preparing', 'confirming', 'waiting', 'choice-required', 'checking', 'authorizing', 'armed', 'writing', 'verifying']);
const protectedPhases = new Set(['checking', 'authorizing', 'armed', 'writing', 'verifying']);
const choicePhases = new Set(['waiting', 'choice-required']);
const failure = code => ({ ok: false, code });
const writeStages = ['connecting', 'formatting', 'writing', 'finalizing'];
const percentValue = value => Number.isFinite(value) && value >= 0 && value <= 100;

function writeProgress(job, value, detail) {
  if (percentValue(value) && value >= (job.percent ?? 0)) job.percent = value;
  const stage = writeStages.indexOf(detail?.stage);
  if (stage < 0 || stage < writeStages.indexOf(job.progressStage)) return;
  if (job.progressStage !== detail.stage) {
    job.progressStage = detail.stage;
    job.stagePercent = job.part = job.total = job.partPercent = undefined;
  }
  if (percentValue(detail.stagePercent) && detail.stagePercent >= (job.stagePercent ?? 0)) job.stagePercent = detail.stagePercent;
  if (detail.stage !== 'writing' || !percentValue(detail.partPercent)) return;
  const { part, total, partPercent } = detail;
  if (Number.isInteger(part) && Number.isInteger(total) && part >= 1 && total >= part && total <= 4096) {
    if (job.total === total && (part < job.part || part === job.part && partPercent < job.partPercent)) return;
    Object.assign(job, { part, total, partPercent });
  } else if (job.part === undefined) job.partPercent = partPercent;
}

function createFirmwareDirectFlow({ services, now = Date.now, waitMs = 300000, scanMs = 450, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let current;
  const active = () => livePhases.has(current?.phase);
  const isProtected = () => protectedPhases.has(current?.phase);
  const alive = job => current === job && active() && !job.abort.signal.aborted;
  const publicTarget = target => ({ id: target.id, label: target.label, details: target.details });
  const status = platform => {
    if (current?.platform !== platform) return { busy: active(), job: null };
    const { id, phase, percent, code, deadline, targetLabel, candidates, preparation, preparationPercent } = current;
    const entry = current.plan?.elevatedMtk ? {
      entryAvailable: phase === 'armed' && !current.plan.useSavedTarget && !current.autoPowerOn && !expired(current),
      entryRequested: current.entryRequested === true,
    } : {};
    const preparing = phase === 'preparing' ? { preparation, preparationPercent } : {};
    const cold = current.coldStart || current.plan?.coldStart ? { coldStart: true } : {};
    const file = current.firmwareId ? { firmwareId: current.firmwareId } : {};
    const { progressStage, stagePercent, part, total, partPercent } = current;
    return { busy: active(), job: { id, platform, phase, percent, code, deadline, targetLabel, candidates: candidates.map(publicTarget),
      ...entry, ...preparing, ...cold, ...file, ...(current.autoPowerOn ? { autoPowerOn: true } : {}),
      ...(progressStage ? { progressStage, stagePercent, part, total, partPercent } : {}) } };
  };
  const expired = job => job.deadline !== undefined && now() >= job.deadline;

  function finish(job, phase, code) {
    clearTimer(job.timer);
    job.timer = undefined;
    job.abort.abort();
    Object.assign(job, { phase, code, candidates: [], plan: null, owner: null });
    const staged = job.staged;
    job.staged = null;
    if (staged?.release) void Promise.resolve().then(staged.release).catch(() => {});
  }

  function later(job) {
    if (!alive(job) || !choicePhases.has(job.phase)) return;
    clearTimer(job.timer);
    job.timer = setTimer(() => { void poll(job); }, Math.min(scanMs, Math.max(0, job.deadline - now())));
    job.timer?.unref?.();
  }

  async function snapshot(job, fresh = false) {
    const result = await services.scan(job.plan, { signal: job.abort.signal, fresh });
    if (result?.code === 'flash-platform-mismatch' || result?.code === 'flash-mtk-auto-target-present') {
      return { candidates: [], anchor: null, blocked: result.code };
    }
    if (!result?.ok || !Array.isArray(result.candidates)) return null;
    const unique = new Map();
    for (const item of result.candidates) {
      if (item?.id && item.identity && !unique.has(item.id)) unique.set(item.id, item);
      else return null;
    }
    return { candidates: [...unique.values()].slice(0, 24), anchor: result.anchor };
  }

  const canCheckWriteTarget = job => alive(job) && !expired(job) && services.canStart(job.owner);
  async function writeGateSnapshot(job) {
    if (!canCheckWriteTarget(job)) return null;
    const fresh = await snapshot(job, true);
    // Windows can miss one snapshot while an RK device settles in Loader. A
    // complete result (including empty, changed or blocked) is never retried.
    if (fresh === null && job.platform === 'rk' && canCheckWriteTarget(job)) return snapshot(job, true);
    return fresh;
  }

  async function arm(request, owner) {
    if (active()) return failure('flash-busy');
    if (!services.canStart(owner)) return failure('flash-busy');
    const job = { id: randomUUID(), platform: request.platform, phase: 'preparing', preparation: 'checking-environment',
      candidates: [], percent: null, owner, coldStart: request.coldStart === true, autoPowerOn: request.autoPowerOn === true,
      firmwareId: request.firmwareId, abort: new AbortController() };
    current = job;
    void prepare(job, request);
    return { ok: true, ...status(job.platform) };
  }

  async function prepare(job, request) {
    try {
      const prepared = await services.prepare(request, { signal: job.abort.signal, onPreparation: (phase, value) => {
        if (!alive(job) || job.phase !== 'preparing' || phase !== 'staging-firmware') return;
        job.preparation = phase;
        if (Number.isFinite(value) && value >= 0 && value <= 100) job.preparationPercent = Math.floor(value);
      } });
      if (!alive(job)) {
        if (prepared?.preparedCopy?.release) await prepared.preparedCopy.release();
        return;
      }
      job.plan = prepared;
      if (!job.plan?.ok) { finish(job, 'failed', job.plan?.code || 'flash-firmware-unavailable'); return; }
      if (prepared.preparedCopy) job.staged = prepared.preparedCopy;
      const baseline = await snapshot(job);
      if (!alive(job)) return;
      if (!baseline) { finish(job, 'failed', 'flash-usb-unavailable'); return; }
      if (baseline.blocked) { finish(job, 'failed', baseline.blocked); return; }
      job.anchor = baseline.anchor || null;
      if (job.plan.profile?.product && !job.anchor && !job.plan.coldStart) { finish(job, 'failed', 'flash-anchor-required'); return; }
      const only = !job.plan.coldStart && !request.targetHint && baseline.candidates.length === 1 ? baseline.candidates[0] : null;
      if (!job.plan.coldStart || job.plan.autoPowerOn) {
        job.phase = 'confirming';
        if (!await services.confirm(job.plan, only || job.anchor, { owner: job.owner, signal: job.abort.signal })) {
          if (alive(job)) finish(job, 'cancelled', 'flash-cancelled');
          return;
        }
      }
      if (!alive(job)) return;
      job.phase = 'preparing';
      const staged = job.staged || await services.stage(job.plan, { signal: job.abort.signal });
      if (!alive(job)) { await staged?.release?.(); return; }
      if (!staged?.firmware) { finish(job, 'failed', staged?.code || 'flash-plan-changed'); return; }
      job.staged = staged;
      job.deadline = now() + waitMs;
      if (job.plan.elevatedMtk) { await armVendor(job); return; }
      if (only) { await dispatch(job, only); return; }
      job.phase = 'waiting';
      await poll(job);
    } catch {
      if (alive(job)) finish(job, 'failed', 'flash-preparation-failed');
    }
  }

  async function poll(job) {
    if (!alive(job) || !choicePhases.has(job.phase)) return;
    if (expired(job)) { finish(job, 'cancelled', 'flash-wait-expired'); return; }
    const sweep = job.sweep = (job.sweep || 0) + 1;
    try {
      const fresh = await snapshot(job);
      if (!alive(job) || !choicePhases.has(job.phase) || sweep !== job.sweep) return;
      if (expired(job)) { finish(job, 'cancelled', 'flash-wait-expired'); return; }
      if (fresh?.blocked) {
        finish(job, 'failed', fresh.blocked); return;
      }
      if (!fresh) {
        Object.assign(job, { candidates: [], phase: 'waiting', code: 'flash-usb-unavailable' });
      } else if (job.anchor) {
        const matched = fresh.candidates.filter(target => services.matchesAnchor(job.anchor, target, job.plan));
        if (matched.length === 1) { await dispatch(job, matched[0], true); return; }
        const choices = matched.length ? matched : fresh.candidates.filter(target => target.location === job.anchor.location);
        Object.assign(job, { candidates: choices, phase: choices.length ? 'choice-required' : 'waiting', code: undefined });
      } else {
        Object.assign(job, { candidates: fresh.candidates, phase: fresh.candidates.length ? 'choice-required' : 'waiting', code: undefined });
      }
    } catch {
      if (alive(job) && choicePhases.has(job.phase) && sweep === job.sweep) Object.assign(job, { candidates: [], phase: 'waiting', code: 'flash-usb-unavailable' });
    }
    if (sweep === job.sweep) later(job);
  }

  async function choose(platform, jobId, targetId, owner) {
    const job = current;
    if (!job || job.id !== jobId || job.platform !== platform || job.owner !== owner || job.phase !== 'choice-required') return failure('flash-target-unavailable');
    if (expired(job)) { finish(job, 'cancelled', 'flash-wait-expired'); return failure('flash-wait-expired'); }
    const target = job.candidates.find(item => item.id === targetId);
    if (!target) return failure('flash-target-unavailable');
    clearTimer(job.timer);
    job.sweep = (job.sweep || 0) + 1;
    job.phase = 'confirming';
    void Promise.resolve().then(async () => {
      if (!alive(job)) return;
      const confirmed = await services.confirm(job.plan, target, { owner, signal: job.abort.signal });
      if (!alive(job)) return;
      if (confirmed) await dispatch(job, target);
      else { job.phase = 'waiting'; await poll(job); }
    }).catch(() => { if (alive(job)) finish(job, 'failed', 'flash-preparation-failed'); });
    return { ok: true, ...status(platform) };
  }

  async function dispatch(job, target, automatic = false) {
    if (!alive(job)) return;
    if (expired(job)) { finish(job, 'cancelled', 'flash-wait-expired'); return; }
    job.phase = 'checking';
    job.candidates = [];
    job.targetLabel = target.label;
    try {
      if (!services.canStart(job.owner) || !await services.validate(job.plan, job.staged, { signal: job.abort.signal })) {
        finish(job, 'failed', 'flash-plan-changed'); return;
      }
      const sameTarget = item => item.id === target.id && item.identity === target.identity &&
        item.selector === target.selector && (!automatic || services.matchesAnchor(job.anchor, item, job.plan));
      const fresh = await writeGateSnapshot(job);
      if (!alive(job)) return;
      if (expired(job)) { finish(job, 'cancelled', 'flash-wait-expired'); return; }
      if (fresh?.blocked) { finish(job, 'failed', fresh.blocked); return; }
      const exact = fresh?.candidates.find(sameTarget);
      if (!exact || !services.canStart(job.owner)) { finish(job, 'failed', 'flash-plan-changed'); return; }
      const coldMtk = job.platform === 'mtk' && job.plan.coldStart === true;
      if (!job.plan.profile?.product) job.phase = 'writing';
      const result = await services.write(job.plan, exact, job.staged, {
        signal: job.abort.signal,
        canDispatch: () => canCheckWriteTarget(job),
        beforeDispatch: async (handoff = exact) => {
          const latest = await writeGateSnapshot(job);
          const stillApproved = item => item.id === handoff.id && item.identity === handoff.identity && item.selector === handoff.selector &&
            item.location === exact.location && (!automatic || services.matchesAnchor(job.anchor, item, job.plan));
          return canCheckWriteTarget(job) && latest?.candidates.some(stillApproved);
        },
        onWriteStart: () => { if (alive(job) && job.phase === 'checking') job.phase = 'writing'; },
        onReady: info => { if (coldMtk) markVendorReady(job, 'checking', info); },
        onProgress: (value, details) => {
          if (coldMtk && alive(job) && job.phase === 'armed' && (value === null || percentValue(value))) job.phase = 'writing';
          if (alive(job) && job.phase === 'writing') writeProgress(job, value, details);
        },
      });
      await conclude(job, exact, result);
    } catch {
      finish(job, 'failed', job.phase === 'writing' ? 'flash-completion-unconfirmed' : 'flash-preparation-failed');
    }
  }

  function markVendorReady(job, previous, info) {
    if (!alive(job) || job.phase !== previous) return;
    job.phase = 'armed';
    if (Number.isInteger(info?.timeoutMs) && info.timeoutMs > 0) job.deadline = now() + Math.min(info.timeoutMs, waitMs);
  }

  async function armVendor(job) {
    if (!alive(job) || (!job.anchor && !job.plan.autoPowerOn) || !services.canStart(job.owner)) {
      if (alive(job)) finish(job, 'failed', 'flash-anchor-required');
      return;
    }
    job.phase = 'authorizing';
    job.targetLabel = job.anchor?.label || job.plan.profile?.board;
    const result = await services.armVendor(job.plan, job.anchor, job.staged, {
      beforeDispatch: () => alive(job) && services.canStart(job.owner),
      onReady: info => markVendorReady(job, 'authorizing', info),
      onProgress: (value, details) => {
        if (!alive(job) || !['armed', 'writing'].includes(job.phase)) return;
        if (value !== null && !percentValue(value)) return;
        job.phase = 'writing';
        writeProgress(job, value, details);
      },
    });
    await conclude(job, job.anchor, result);
  }

  async function conclude(job, target, result) {
    if (result?.transferCompleted !== true) {
      const safeCodes = new Set(['flash-plan-changed', 'flash-mtk-port-unknown', 'flash-cancelled', 'flash-wait-expired',
        'flash-tool-unavailable', 'flash-rk-storage-unverified', 'flash-target-unavailable', 'flash-busy', 'flash-vendor-busy',
        'flash-mtk-auto-target-present']);
      const nativeCodes = { 'mtk-uac-cancelled': 'flash-cancelled', 'mtk-target-mismatch': 'flash-plan-changed', 'mtk-mode-mismatch': 'flash-mode-mismatch',
        'mtk-tool-start-failed': 'flash-tool-unavailable', 'mtk-wait-expired': 'flash-wait-expired' };
      const code = safeCodes.has(result?.code) ? result.code :
        Object.hasOwn(nativeCodes, result?.code) ? nativeCodes[result.code] : 'flash-completion-unconfirmed';
      finish(job, code === 'flash-cancelled' || code === 'flash-wait-expired' ? 'cancelled' : 'failed', code);
      return;
    }
    job.percent = 100;
    if (job.platform === 'mtk') {
      finish(job, 'written');
      return;
    }
    job.phase = 'verifying';
    const verified = await services.verify(job.plan, target, result).catch(() => false);
    finish(job, verified ? 'verified' : 'written', verified ? undefined : 'flash-boot-unverified');
  }

  async function enterLoader(platform, jobId, owner) {
    const job = current;
    const canSend = () => alive(job) && job.phase === 'armed' && !expired(job) && services.canStart(job.owner);
    if (!job || platform !== 'mtk' || job.platform !== platform || job.id !== jobId || job.owner !== owner ||
      !job.plan?.elevatedMtk || job.plan.useSavedTarget || job.plan.autoPowerOn || !job.anchor || job.entryRequested ||
      typeof services.enterLoader !== 'function' || !canSend()) return failure('flash-loader-request-failed');
    job.entryRequested = true;
    let attempted = false;
    try {
      attempted = await services.enterLoader(job.plan, job.anchor, canSend, job.staged);
    } catch { /* No second request is sent by the flow. */ }
    if (!attempted && current === job && job.phase === 'armed') job.entryRequested = false;
    return attempted ? { ok: true, ...status(platform) } : failure('flash-loader-request-failed');
  }

  function cancel(platform, jobId, owner) {
    const job = current;
    if (!job || job.platform !== platform || job.id !== jobId || job.owner !== owner || !active() || isProtected()) return failure('flash-cannot-cancel');
    finish(job, 'cancelled', 'flash-cancelled');
    return { ok: true, ...status(platform) };
  }

  function cancelPending() {
    if (active() && !isProtected()) finish(current, 'cancelled', 'flash-cancelled');
  }

  return { arm, choose, cancel, enterLoader, status, active, isProtected, cancelPending };
}

module.exports = { createFirmwareDirectFlow };
