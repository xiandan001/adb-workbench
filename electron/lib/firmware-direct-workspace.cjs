const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { tr } = require('./localization.cjs');
const { createFirmwareDirectFlow } = require('./firmware-direct-flow.cjs');
const { prepareDirectFirmware, revalidateDirectFirmware, stageDirectFirmware, prepareStagedDirectFirmware,
  prepareMtkQuickReview, stageMtkQuickReview } = require('./firmware-direct-receipt.cjs');
const { preflightFirmware } = require('./firmware-preflight.cjs');
const { acceptedFlashProfiles } = require('./firmware-direct-profiles.cjs');
const { parseAdbDeviceRows } = require('./adb-device-parser.cjs');
const { explicitTransport, selectQualifiedUsbAnchor, queryMtkPortHistory, listMtkPortReservations, nativeFlashToolsIdle, sanitizeMtkBinding, sanitizeRkBinding } = require('./firmware-direct-binding.cjs');

const modesByPlatform = { rk: ['upgrade'], mtk: ['download-only', 'firmware-upgrade', 'format-all-download'] };
const modeLabels = {
  upgrade: () => tr('整包升级'),
  'download-only': () => tr('仅下载'),
  'firmware-upgrade': () => tr('固件升级'),
  'format-all-download': () => tr('格式化后下载'),
};
const serialValue = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const sameSerial = (left, right) => serialValue(left) && serialValue(right) && left === right;
const formatMode = 'format-all-download';
const fail = code => ({ ok: false, code });
const cancelled = () => ({ ok: false, cancelled: true });
const idText = value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const sessionReviewProfile = profile => Object.hasOwn(modesByPlatform, profile.platform) && profile.sessionReview === true;
const autoPowerOnProfile = profile => profile.platform === 'mtk' && Boolean(profile.product) &&
  sessionReviewProfile(profile) && profile.usb?.vid === '0e8d' && profile.usb.pid === '2000' && profile.usb.stage === 'preloader';
const hasFlashDevice = inventory => inventory.mtk.length > 0 || inventory.rk.length > 0;
const mtkPreloaderInstance = /^USB\\VID_0E8D&PID_2000(?:&MI_[a-f0-9]{2})?\\[a-z0-9._&-]{1,160}$/i;
const mtkPort = /^COM([1-9][0-9]{0,3})$/;
const sameMtkInstance = (left, right) => typeof left === 'string' && typeof right === 'string' && left.toUpperCase() === right.toUpperCase();
const sameMtkPort = (left, right) => Boolean(left && right && left.port === right.port && left.location === right.location &&
  sameMtkInstance(left.instanceId, right.instanceId));

function preparationFailure(code) {
  if (code === 'cancelled' || code === 'ABORT_ERR') return 'flash-cancelled';
  if (['missing-files', 'ENOENT'].includes(code)) return 'flash-firmware-missing-files';
  if (['firmware-disk-full', 'ENOSPC', 'EDQUOT'].includes(code)) return 'flash-firmware-space';
  if (code === 'firmware-changed') return 'flash-firmware-changed';
  if (code === 'unsupported-format') return 'flash-platform-mismatch';
  if (['invalid-firmware', 'invalid-manifest', 'invalid-path'].includes(code)) return 'flash-firmware-unavailable';
  return 'flash-firmware-read-failed';
}

function usbAnchorIsUnchanged(inventory, anchor, allowDisconnected) {
  if (!inventory?.ok || inventory.mtk.length || inventory.rk.length) return false;
  const atPort = inventory.adb.filter(row => row.location === anchor.location);
  return !atPort.length ? allowDisconnected : atPort.length === 1 && atPort[0].identity === anchor.identity;
}

function trustedModes(profiles, platform) {
  const active = profiles.filter(profile => profile.platform === platform);
  return modesByPlatform[platform].filter(mode => active.some(profile => profile.mode === mode));
}

function digestMatches(profile, receipt) {
  const expected = profile.contentSha256 || profile.firmwareSha256;
  return typeof expected === 'string' && expected === (profile.contentSha256 ? receipt.contentSha256 : receipt.sha256);
}

function selectFirmwareProfile(profiles, platform, mode, receipt, structureOnly) {
  const compatible = profiles.filter(profile => profile.platform === platform && profile.mode === mode &&
    profile.chip === receipt.chip && (!profile.project || profile.project === receipt.project));
  const matching = structureOnly || compatible.some(sessionReviewProfile) ? compatible : compatible.filter(profile => digestMatches(profile, receipt));
  if (matching.length === 1) return { ok: true, profile: matching[0] };
  return fail(!structureOnly && compatible.length && !matching.length ? 'flash-firmware-content-unverified' : 'flash-profile-no-match');
}

function targetAllowed(profile, item) {
  const stages = profile.usb.stages || [profile.usb.stage];
  return item.vid === profile.usb.vid && item.pid === profile.usb.pid &&
    stages.includes(item.mode || item.stage) && (Boolean(profile.product) || sameSerial(item.serial, profile.usb.serial));
}

function uniqueTargetRows(plan, nativeRows, inventory) {
  return nativeRows.filter(item => targetAllowed(plan.profile, item)).flatMap(item => {
    let target = item;
    if (plan.platform === 'mtk') {
      if (item.stage === 'brom') {
        const da = inventory.mtk.filter(row => row.stage === 'da' && row.location === item.location &&
          sameSerial(row.serial, item.serial) && row.pid === plan.profile.usb.daPid && row.port !== item.port);
        if (da.length !== 1) return [];
        target = { ...item, daPort: da[0].port, sameDeviceVerified: true, identity: item.identity + ':' + da[0].identity };
      } else if (item.stage !== 'preloader') return [];
    }
    const selector = plan.platform === 'rk' ? target.locationId : target.daPort ? target.port + '+' + target.daPort : target.port;
    if (!selector || !target.identity || !target.location) return [];
    return [{ ...target, id: target.identity, selector, label: target.label || plan.profile.board, details: selector, verified: true }];
  });
}

function findColdMtkTarget(plan, inventory) {
  if (!inventory?.ok || inventory.rk.length || inventory.mtk.length !== 1) return null;
  const [target] = uniqueTargetRows(plan, inventory.mtk, inventory);
  if (!target || target.stage !== 'preloader' || !mtkPreloaderInstance.test(target.instanceId) ||
    !mtkPort.test(target.port) || Number(target.port.slice(3)) > 4096 ||
    inventory.adb.some(row => row.location === target.location)) return null;
  return target;
}

function bootTransport(list, serial) {
  if (!list.ok) return null;
  const matches = parseAdbDeviceRows(String(list.stdout)).filter(row => row.id === serial);
  if (matches.length !== 1 || matches[0].status !== 'device') return null;
  const ids = [...matches[0].detail.matchAll(/(?:^|\s)transport_id:([1-9][0-9]{0,9})(?=\s|$)/g)];
  return ids.length === 1 ? ids[0][1] : null;
}

async function verifyBoot(plan, candidate, { queryUsb, runAdb, retries = 18, interval = 2500 }) {
  if (plan.sessionReview) return verifyReviewBoot(plan, candidate, { queryUsb, runAdb, retries, interval });
  if (plan.profile.boot) return verifyQualifiedBoot(plan, candidate, { queryUsb, runAdb, retries, interval });
  const serial = plan.profile.bootSerial;
  const build = plan.profile.bootFingerprint;
  if (!serialValue(serial) || typeof build !== 'string' || !build) return false;
  for (let attempt = 0; attempt < retries; attempt++) {
    const inventory = await queryUsb();
    if (inventory.ok && inventory.adb.filter(item => sameSerial(item.serial, serial) && item.location === candidate.location).length === 1) {
      const transport = bootTransport(await runAdb(['devices', '-l'], { timeoutMs: 2500 }), serial);
      if (transport) {
        const observed = await runAdb(['-t', transport, 'shell', 'getprop', 'ro.build.fingerprint'], { timeoutMs: 2500 });
        if (observed.ok && String(observed.stdout).trim() === build) {
          const checked = await queryUsb();
          if (checked.ok && checked.adb.filter(item => sameSerial(item.serial, serial) && item.location === candidate.location).length === 1 &&
            bootTransport(await runAdb(['devices', '-l'], { timeoutMs: 2500 }), serial) === transport) return true;
        }
      }
    }
    if (attempt + 1 < retries) await delay(interval);
  }
  return false;
}

async function verifyReviewBoot(plan, candidate, { queryUsb, runAdb, retries, interval }) {
  const { profile } = plan;
  for (let attempt = 0; attempt < retries; attempt++) {
    const inventory = await queryUsb();
    const targets = inventory?.ok ? inventory.adb.filter(row => row.location === candidate.location && profile.adbVids.includes(row.vid)) : [];
    if (targets.length === 1) {
      const [target] = targets;
      const qualified = await selectQualifiedUsbAnchor(inventory, profile, target.serial, runAdb);
      if (qualified && qualified.identity === target.identity && qualified.location === candidate.location) {
        const fresh = await queryUsb();
        const atPort = fresh?.ok ? fresh.adb.filter(row => row.location === candidate.location) : [];
        if (atPort.length === 1 && atPort[0].identity === target.identity && sameSerial(atPort[0].serial, target.serial) &&
          explicitTransport(await runAdb(['devices', '-l'], { timeoutMs: 2500 }), target.serial)?.id === qualified.transport) return true;
      }
    }
    if (attempt + 1 < retries) await delay(interval);
  }
  return false;
}

async function verifyQualifiedBoot(plan, candidate, { queryUsb, runAdb, retries, interval }) {
  const expected = plan.profile.boot;
  for (let attempt = 0; attempt < retries; attempt++) {
    const inventory = await queryUsb();
    const usb = inventory.ok && inventory.adb.filter(row => row.location === candidate.location && plan.profile.adbVids.includes(row.vid));
    if (usb?.length === 1) {
      const serial = usb[0].serial;
      const transport = explicitTransport(await runAdb(['devices', '-l'], { timeoutMs: 2500 }), serial);
      if (transport?.detail.split(/\s+/).includes('product:' + plan.profile.product)) {
        const result = await runAdb(['-t', transport.id, 'shell',
          'getprop ro.product.build.fingerprint; getprop ro.system.build.fingerprint; getprop ro.vendor.build.fingerprint; getprop ro.boot.vbmeta.digest; getprop sys.boot_completed'], { timeoutMs: 5000 });
        const values = result?.ok && String(result.stdout).trim().split(/\r?\n/);
        if (values?.length === 5 && values[0] === expected.product && values[1] === expected.system && values[2] === expected.vendor &&
          lowerFingerprint(values[3]) === expected.avb && values[4] === '1') {
          const check = await queryUsb();
          const again = explicitTransport(await runAdb(['devices', '-l'], { timeoutMs: 2500 }), serial);
          if (check.ok && check.adb.some(row => row.location === candidate.location && row.serial === serial) && again?.id === transport.id) return true;
        }
      }
    }
    if (attempt + 1 < retries) await delay(interval);
  }
  return false;
}

const lowerFingerprint = text => typeof text === 'string' ? text.toLowerCase() : '';

function registerFirmwareDirectWorkspace(ipcMain, options) {
  const {
    ownerFor, getOwnerFrame, toolRoot, toolRoots, prepareTool, canStart, isWindows,
    profiles = acceptedFlashProfiles, ask = require('./app-message-dialog.cjs').ask,
    backend, targetProvider, firmware = { preflightFirmware, prepareDirectFirmware, revalidateDirectFirmware, stageDirectFirmware,
      prepareStagedDirectFirmware, prepareMtkQuickReview, stageMtkQuickReview },
    runAdb = require('./adb-runtime.cjs').runAdb, createFlow = createFirmwareDirectFlow,
    resolveMtkPort = queryMtkPortHistory, windowsMtkPorts = listMtkPortReservations, toolsIdle = nativeFlashToolsIdle, mtkBindings, rkBindings,
  } = options;
  const getBackend = () => backend || (defaultBackend ||= require('./firmware-direct-backends.cjs').createDirectFlashBackends());
  const getTargets = () => targetProvider || require('./firmware-direct-targets.cjs');
  let defaultBackend;
  let configuringTool = false;
  const selections = new Map();
  const validations = new Map();
  const sessionReviews = new Map();
  const reviewRequests = new Map();
  const toolChecks = new Map();
  const coldMtkObservations = new WeakMap();
  const onePass = typeof firmware.preflightFirmware === 'function' && typeof firmware.prepareStagedDirectFirmware === 'function';
  const mtkProfiles = profiles.filter(profile => profile.platform === 'mtk');
  const fastMtk = isWindows && mtkProfiles.length > 0 && mtkProfiles.every(autoPowerOnProfile) &&
    typeof firmware.prepareMtkQuickReview === 'function' && typeof firmware.stageMtkQuickReview === 'function';
  const requiresSessionReview = (platform, mode) => profiles.some(profile => profile.platform === platform &&
    sessionReviewProfile(profile) && (mode === undefined || profile.mode === mode));
  function invalidateSessionReview(platform) {
    sessionReviews.delete(platform);
    reviewRequests.delete(platform);
  }
  const ownsSessionReview = (platform, review) => sessionReviews.get(platform) === review &&
    selections.get(platform) === review.selection && getOwnerFrame() === review.selection.frame;
  function sessionReviewForArm(platform, firmwareId, mode, frame, owner) {
    const review = sessionReviews.get(platform);
    return review && review.selection.id === firmwareId && review.selection.frame === frame && review.owner === owner &&
      (review.quick ? review.modes.has(mode) : review.approvedMode === mode) &&
      ownsSessionReview(platform, review) ? review : null;
  }
  const authorizedPlan = plan => !plan.sessionReview ||
    (ownsSessionReview(plan.platform, plan.sessionReview) &&
      (plan.sessionReview.quick ? plan.quickConfirmed === true : plan.sessionReview.approvedMode === plan.mode));
  async function unchangedReview(review) {
    try { return await firmware.revalidateDirectFirmware(review.receipt) === true; }
    catch { return false; }
  }
  function stopValidation(platform) {
    const validation = validations.get(platform);
    if (validation) {
      validations.delete(platform);
      validation.abort();
    }
  }
  async function inspectConfiguredTool(platform) {
    const roots = toolRoots ? await toolRoots(platform) : [await toolRoot?.(platform)];
    for (const root of roots) {
      if (!root) continue;
      const result = await getBackend().inspect(platform, root);
      if (result.ok) return result;
    }
    return fail('flash-tool-unavailable');
  }
  function checkTool(platform, fresh = false) {
    const previous = toolChecks.get(platform);
    if (!fresh && previous && Date.now() < previous.expires) return previous.result;
    const pending = { expires: Infinity };
    pending.result = inspectConfiguredTool(platform).catch(() => fail('flash-tool-unavailable')).then(result => {
      pending.expires = Date.now() + (result.ok ? 30000 : 5000);
      return result;
    });
    toolChecks.set(platform, pending);
    return pending.result;
  }
  const bindingsFor = platform => platform === 'mtk' ? mtkBindings : rkBindings;
  const readSaved = async platform => {
    const saved = await bindingsFor(platform)?.read();
    return (platform === 'mtk' ? sanitizeMtkBinding : sanitizeRkBinding)(saved);
  };
  const writeOptions = plan => ({ mode: plan.mode, reboot: plan.profile.reboot === true, permitFormatAll: plan.mode === formatMode });
  function observeColdMtk(plan, observed, inventory) {
    if (!inventory?.ok) {
      if (inventory?.code === 'usb-address-ambiguous') observed.target = null;
      return;
    }
    if (inventory.rk.length) observed.blocked = 'flash-platform-mismatch';
    if (inventory.mtk.length || inventory.rk.length || inventory.adb.some(row => row.location === observed.target?.location)) {
      observed.target = findColdMtkTarget(plan, inventory);
    }
  }
  function coldMtkObservation(plan, signal, inventory) {
    let observed = coldMtkObservations.get(plan);
    if (!observed) {
      observed = { target: null };
      coldMtkObservations.set(plan, observed);
      const targets = getTargets();
      if (!signal.aborted && typeof targets.watchDirectUsb === 'function') {
        observed.ready = new Promise(resolve => {
          const ready = () => {
            clearTimeout(timeout);
            signal.removeEventListener('abort', ready);
            resolve();
          };
          const timeout = setTimeout(ready, 8500);
          timeout.unref?.();
          signal.addEventListener('abort', ready, { once: true });
          try {
            observed.stop = targets.watchDirectUsb({
              signal,
              onSnapshot: value => {
                ready();
                if (signal.aborted) return;
                observed.watchedAt = value?.ok ? Date.now() : undefined;
                observeColdMtk(plan, observed, value);
              },
            });
          } catch { ready(); } // Confirmations and writes still require a fresh inventory.
        });
      }
    }
    observeColdMtk(plan, observed, inventory);
    return observed;
  }
  function fastMtkUsbReader(signal) {
    const targets = getTargets();
    if (typeof targets.watchDirectUsb !== 'function') return null;
    let pending, stop;
    const publish = value => {
      if (!pending) return;
      const { resolve, timer } = pending;
      pending = null;
      clearTimeout(timer);
      resolve(value);
    };
    const close = () => {
      signal.removeEventListener('abort', close);
      publish(null);
      stop?.();
    };
    signal.addEventListener('abort', close, { once: true });
    return {
      close,
      read: () => signal.aborted ? Promise.resolve(null) : new Promise(resolve => {
        // A ready worker provides the next fresh sample without compiling the Windows probe again.
        pending = { resolve, timer: setTimeout(() => publish(null), 8500) };
        pending.timer.unref?.();
        try { stop ??= targets.watchDirectUsb({ signal, onSnapshot: publish }); }
        catch { publish(null); }
      }),
    };
  }
  const coldMtkCandidates = observed => observed.blocked ? fail(observed.blocked)
    : { ok: true, anchor: null, candidates: observed.target ? [observed.target] : [] };
  async function verifyColdMtkPort(plan, target, signal) {
    const targets = getTargets();
    const isEmptyAtTarget = inventory => inventory?.ok && !inventory.rk.length && !inventory.mtk.length &&
      !inventory.adb.some(row => row.location === target.location);
    const isSameLiveTarget = inventory => {
      const current = findColdMtkTarget(plan, inventory);
      return sameMtkPort(current, target) && current.identity === target.identity;
    };
    const first = await targets.queryDirectUsb({ signal });
    if (isSameLiveTarget(first)) return true;
    if (!isEmptyAtTarget(first)) return false;
    const ports = await windowsMtkPorts({ signal });
    if (!Array.isArray(ports)) return false;
    const matches = ports.filter(row => row.port === target.port || row.location === target.location ||
      sameMtkInstance(row.instanceId, target.instanceId));
    if (matches.length !== 1 || matches[0].stage !== 'preloader' || matches[0].verified !== true ||
      !sameMtkPort(matches[0], target)) return false;
    const latest = await targets.queryDirectUsb({ signal });
    return isEmptyAtTarget(latest) || isSameLiveTarget(latest);
  }
  const scanQualifiedRk = async (plan, location) => {
    const targets = getTargets();
    const [native, tool] = await Promise.all([targets.queryDirectUsb({}), getBackend().listRk(plan.tool)]);
    if (!native.ok || !tool.ok || native.rk.length !== 1 || tool.devices.length !== 1 || native.mtk.length) return null;
    const rows = uniqueTargetRows(plan, targets.reconcileRkTargets(native.rk, tool.devices), native);
    return rows.length === 1 && rows[0].location === location ? rows[0] : null;
  };
  const flow = createFlow({
    services: {
      canStart: frame => !configuringTool && canStart() && (!frame || frame === getOwnerFrame()),
      async prepare({ platform, firmwareId, filePath, mode, targetHint, useSavedTarget, coldStart, frame, owner }, { signal, onPreparation }) {
        const sessionReview = sessionReviewForArm(platform, firmwareId, mode, frame, owner);
        const quick = sessionReview?.quick === true;
        if (requiresSessionReview(platform, mode) && !sessionReview) return fail('flash-firmware-review-required');
        if (sessionReview && !await unchangedReview(sessionReview)) {
          if (ownsSessionReview(platform, sessionReview)) invalidateSessionReview(platform);
          return fail('flash-firmware-changed');
        }
        if (sessionReview && !ownsSessionReview(platform, sessionReview)) return fail('flash-firmware-review-required');
        // Stage from the exact source verified during review, not from a renderer input or a retargeted alias.
        const source = sessionReview ? sessionReview.receipt.path : filePath;
        let structure;
        try {
          structure = quick ? sessionReview.receipt : onePass ? await firmware.preflightFirmware(platform, source)
            : await firmware.prepareDirectFirmware(platform, source, { signal });
        } catch (error) { return fail(preparationFailure(error?.code)); }
        if (!structure || structure.ok === false) return fail(preparationFailure(structure?.code));
        const matching = selectFirmwareProfile(profiles, platform, mode, structure, onePass || quick);
        if (!matching.ok) return matching;
        const { profile } = matching;
        if (sessionReview && (sessionReview.modes.get(mode) !== profile || !ownsSessionReview(platform, sessionReview) ||
          !onePass && !quick && structure.sha256 !== sessionReview.receipt.sha256)) return fail('flash-firmware-changed');
        const autoPowerOn = coldStart === true && autoPowerOnProfile(profile);
        const elevatedMtk = platform === 'mtk' && Boolean(profile.product) && (!coldStart || autoPowerOn);
        let anchor, boundMtk, baseline;
        const usbReader = quick && autoPowerOn ? fastMtkUsbReader(signal) : null;
        if ((useSavedTarget || coldStart) && !profile.product) return fail('flash-invalid-request');
        if (profile.product) {
          baseline = await (usbReader ? usbReader.read() : getTargets().queryDirectUsb({ signal }));
          if (!baseline?.ok) return fail('flash-usb-unavailable');
          if (autoPowerOn && hasFlashDevice(baseline)) return fail('flash-mtk-auto-target-present');
          if ((platform === 'rk' ? baseline.mtk : baseline.rk).length) return fail('flash-platform-mismatch');
          if (!coldStart && (baseline.mtk.length || baseline.rk.length)) return fail('flash-anchor-required');
          const saved = useSavedTarget ? await readSaved(platform) : null;
          if (useSavedTarget) {
            if (!saved || saved.product !== profile.product || !usbAnchorIsUnchanged(baseline, saved, true)) return fail('flash-anchor-required');
            anchor = { ...saved, label: [profile.board, saved.port].filter(Boolean).join(' · ') };
          } else if (!coldStart) {
            anchor = await selectQualifiedUsbAnchor(baseline, profile, targetHint, runAdb);
            const considered = targetHint ? baseline.adb.filter(row => row.serial === targetHint) : baseline.adb;
            if (!anchor && considered.length && considered.every(row => !profile.adbVids.includes(row.vid) &&
              profiles.some(other => other.platform !== platform && other.adbVids?.includes(row.vid)))) return fail('flash-platform-mismatch');
          }
          if (!anchor && !coldStart) return fail('flash-anchor-required');
          if (!await toolsIdle()) return fail('flash-vendor-busy');
          if (autoPowerOn) {
            boundMtk = { stage: 'preloader-auto', verified: true };
          } else if (elevatedMtk) {
            boundMtk = await resolveMtkPort(anchor, { signal });
            if (!boundMtk) return fail('flash-mtk-port-unknown');
            if (saved && (saved.port !== boundMtk.port || saved.instanceId.toUpperCase() !== boundMtk.instanceId.toUpperCase())) {
              return fail('flash-plan-changed');
            }
          }
        }
        const tool = await checkTool(platform, true);
        if (!tool.ok || tool.tool.version !== profile.toolVersion) return fail('flash-tool-unavailable');
        const plan = { ok: true, platform, mode, targetHint, tool: tool.tool, profile, anchor, elevatedMtk, boundMtk,
          coldStart, autoPowerOn, useSavedTarget, sessionReview, usbReader, ...(autoPowerOn && quick ? { initialUsb: baseline } : {}) };
        if (coldStart && platform === 'mtk' && !autoPowerOn) coldMtkObservation(plan, signal, baseline);
        let preparedCopy;
        if (onePass && !quick) {
          onPreparation?.('staging-firmware', 0);
          let lastPercent = 0;
          try {
            preparedCopy = await firmware.prepareStagedDirectFirmware(platform, source, { signal, onProgress: ({ copiedBytes, totalBytes }) => {
              if (!(totalBytes > 0)) return;
              const progress = Math.max(0, Math.min(100, Math.floor(copiedBytes / totalBytes * 100)));
              if (progress > lastPercent) { lastPercent = progress; onPreparation?.('staging-firmware', progress); }
            } });
          } catch (error) { return fail(preparationFailure(error?.code)); }
          const sealed = preparedCopy?.firmware;
          let code = !sealed ? 'flash-firmware-unavailable'
            : sealed.chip !== profile.chip || profile.project && sealed.project !== profile.project ? 'flash-firmware-changed'
              : !sessionReview && !digestMatches(profile, sealed) ? 'flash-firmware-content-unverified' : null;
          if (!code && sessionReview && (sealed.sha256 !== sessionReview.receipt.sha256 ||
            !await unchangedReview(sessionReview) || !authorizedPlan(plan))) code = 'flash-firmware-changed';
          if (code) {
            await preparedCopy?.release?.();
            if (code === 'flash-firmware-changed' && sessionReview && ownsSessionReview(platform, sessionReview)) invalidateSessionReview(platform);
            return fail(code);
          }
        }
        return Object.assign(plan, { receipt: preparedCopy?.firmware || structure, preparedCopy });
      },
      async scan(plan, { signal, fresh = false }) {
        const targets = getTargets();
        const observed = coldMtkObservations.get(plan);
        // Allow the observer to warm up before the UI asks for the first power-on.
        if (observed?.ready) await observed.ready;
        if (signal.aborted) return fail('flash-cancelled');
        if (!fresh && plan.initialUsb) {
          const initial = plan.initialUsb;
          plan.initialUsb = null;
          return hasFlashDevice(initial) ? fail('flash-mtk-auto-target-present') : { ok: true, anchor: null, candidates: [] };
        }
        if (observed?.blocked || (!fresh && observed?.watchedAt !== undefined && Date.now() - observed.watchedAt < 1500)) {
          return coldMtkCandidates(observed);
        }
        const rk = plan.platform === 'rk' && !plan.coldStart ? getBackend().listRk(plan.tool) : null;
        const [inventory, rockusb] = await Promise.all([targets.queryDirectUsb({ signal }), rk]);
        if (!inventory.ok) {
          if (observed) observeColdMtk(plan, observed, inventory);
          return fail('flash-usb-unavailable');
        }
        if (plan.autoPowerOn) return hasFlashDevice(inventory) ? fail('flash-mtk-auto-target-present')
          : { ok: true, anchor: null, candidates: [] };
        const adbMatches = plan.targetHint ? inventory.adb.filter(item => sameSerial(item.serial, plan.targetHint)) : [];
        const otherPlatform = plan.platform === 'rk' ? inventory.mtk : inventory.rk;
        if (otherPlatform.some(row => plan.coldStart || row.location === plan.anchor?.location)) return fail('flash-platform-mismatch');
        if (plan.coldStart) {
          if (plan.platform === 'mtk') {
            return coldMtkCandidates(coldMtkObservation(plan, signal, inventory));
          }
          if (inventory.rk.length !== 1) return { ok: true, anchor: null, candidates: [] };
          const result = await getBackend().listRk(plan.tool);
          const candidates = result?.ok && result.devices.length === 1
            ? uniqueTargetRows(plan, targets.reconcileRkTargets(inventory.rk, result.devices), inventory) : [];
          return { ok: true, anchor: null, candidates };
        }
        if (rockusb?.ok === false) return fail('flash-usb-unavailable');
        const rows = plan.platform === 'rk' ? targets.reconcileRkTargets(inventory.rk, rockusb.devices) : inventory.mtk;
        if (plan.profile.product) {
          const anchor = plan.useSavedTarget ? (usbAnchorIsUnchanged(inventory, plan.anchor, true) ? plan.anchor : null)
            : inventory.adb.find(item => item.location === plan.anchor.location && item.identity === plan.anchor.identity) ? plan.anchor : null;
          const candidates = inventory.rk.length <= 1 && inventory.mtk.length <= 1 ?
            uniqueTargetRows(plan, rows, inventory).filter(row => row.location === plan.anchor.location) : [];
          return { ok: true, anchor, candidates };
        }
        return { ok: true, anchor: adbMatches.length === 1 ? adbMatches[0] : null, candidates: uniqueTargetRows(plan, rows, inventory) };
      },
      matchesAnchor: (anchor, target, plan) => anchor.location === target.location &&
        (Boolean(plan.profile.product) || sameSerial(anchor.serial, target.serial) ||
          sameSerial(anchor.serial, plan.profile.bootSerial) && sameSerial(target.serial, plan.profile.usb.serial)),
      async confirm(plan, target, { owner, signal }) {
        if (signal.aborted || owner !== getOwnerFrame()) return false;
        const dangerous = plan.mode === formatMode;
        const coldMtk = plan.coldStart && plan.platform === 'mtk';
        const quick = plan.sessionReview?.quick === true;
        const checkboxLabel = quick && !plan.autoPowerOn
          ? dangerous ? tr('我确认固件来自可信渠道且适用于此板卡，并了解格式化会清除数据')
            : tr('我确认固件来自可信渠道，适用于此板卡和所选刷机模式')
          : plan.autoPowerOn
          ? dangerous ? tr('我已确认只连接这一台 MTK 设备、固件与板卡一致，并了解格式化会清除数据')
            : tr('我已确认只连接这一台 MTK 设备，且固件与板卡一致')
          : coldMtk
          ? dangerous ? tr('我已确认 MTK 板卡型号与固件一致，并了解格式化会清除设备数据') : tr('我已确认这块 MTK 板卡的型号与所选固件一致')
          : dangerous ? tr('我已了解格式化会清除设备数据')
            : plan.coldStart ? tr('我已确认这块 RK 板卡的型号与所选镜像一致') : undefined;
        const targetLabel = target?.label ? [target.label, target.details].filter(Boolean).join(' · ') : target?.serial;
        const answer = await ask({
          type: 'warning', title: plan.autoPowerOn ? tr('准备 MTK 上电自动刷机') : tr('确认开始直刷'),
          message: plan.autoPowerOn ? tr('只连接这一台待刷设备并保持断电。工具就绪后，一上电识别到下载端口就会自动刷机。')
            : coldMtk ? tr('仅对刷机确认的 USB 目标写入。若设备已退出下载模式，等工具就绪后再上电。')
            : target?.selector ? tr('确认目标后将立即写入，请保持 USB 连接和设备供电。')
              : tr('确认固件和刷机模式。已确认的目标进入刷机模式后将开始写入。'),
          detail: [
            plan.profile.board, path.basename(plan.receipt.path), modeLabels[plan.mode](),
            ...(quick ? [tr('请确认固件来自可信渠道，且适用于当前板卡和刷机模式。')] : []),
            ...(targetLabel ? [tr('目标：{0}', { 0: targetLabel })]
              : !plan.autoPowerOn ? [tr('目标尚未绑定，识别到刷机设备后需要选择目标。')] : []),
            ...(plan.profile.product && !plan.autoPowerOn ? [tr('保持目标设备接在原 USB 口，不要换线或更换设备。')] : []),
            dangerous ? tr('格式化后下载会先清除存储，可能影响设备配置和校准数据。')
              : plan.mode === 'firmware-upgrade' ? tr('固件升级可能改写分区并清除数据，请先备份。')
                : tr('确认后可能覆盖设备上的系统和数据。'),
          ].join('\n'),
          buttons: [tr('取消'), plan.autoPowerOn ? tr('确认并等待上电') : tr('开始刷机')], defaultId: 0, cancelId: 0,
          ...(checkboxLabel ? { checkboxLabel } : {}),
        });
        const confirmed = !signal.aborted && owner === getOwnerFrame() && answer?.response === 1 &&
          (!checkboxLabel || answer.checkboxChecked === true);
        if (quick && confirmed) plan.quickConfirmed = ownsSessionReview(plan.platform, plan.sessionReview);
        return quick ? plan.quickConfirmed === true : confirmed;
      },
      async stage(plan, context) {
        if (plan.sessionReview?.quick) {
          if (!authorizedPlan(plan)) return fail('flash-firmware-review-required');
          try {
            return await firmware.stageMtkQuickReview(plan.receipt, context);
          } catch (error) {
            if (error?.code === 'firmware-changed' && ownsSessionReview(plan.platform, plan.sessionReview)) {
              invalidateSessionReview(plan.platform);
            }
            return fail(preparationFailure(error?.code));
          }
        }
        const staged = await firmware.stageDirectFirmware(plan.platform, plan.receipt, context);
        if (plan.sessionReview && (staged?.firmware?.sha256 !== plan.sessionReview.receipt.sha256 ||
          !await unchangedReview(plan.sessionReview) || !authorizedPlan(plan))) {
          await staged?.release?.();
          return null;
        }
        return staged;
      },
      validate: async (plan, staged) => authorizedPlan(plan) && staged.firmware.sha256 === plan.receipt.sha256 &&
        await firmware.revalidateDirectFirmware(staged.firmware) && authorizedPlan(plan),
      async armVendor(plan, anchor, staged, context) {
        let autoTargetPresent = false;
        const result = await getBackend().write({
          platform: 'mtk', tool: plan.tool, target: plan.boundMtk, firmware: staged.firmware,
          options: { ...writeOptions(plan), elevated: true, ...(staged.protectedFiles ? { protectedFiles: staged.protectedFiles } : {}) },
        }, { ...context, async beforeDispatch() {
          if (!authorizedPlan(plan) || !context.beforeDispatch() || staged.isActive?.() === false ||
            !await toolsIdle() || !await firmware.revalidateDirectFirmware(staged.firmware)) return false;
          if (plan.autoPowerOn) {
            const live = await (plan.usbReader ? plan.usbReader.read() : getTargets().queryDirectUsb({}));
            plan.usbReader?.close();
            autoTargetPresent = live?.ok === true && hasFlashDevice(live);
            return live?.ok === true && !autoTargetPresent && context.beforeDispatch() && authorizedPlan(plan) && staged.isActive?.() !== false;
          }
          const port = await resolveMtkPort(anchor, {});
          if (!port || port.port !== plan.boundMtk.port || port.instanceId.toLowerCase() !== plan.boundMtk.instanceId.toLowerCase()) return false;
          const live = await getTargets().queryDirectUsb({});
          if (!usbAnchorIsUnchanged(live, anchor, plan.useSavedTarget === true) || !context.beforeDispatch() || !await toolsIdle()) return false;
          if (!plan.useSavedTarget && mtkBindings) {
            // The approved, still-live ADB target and its Windows port reservation were checked together.
            await mtkBindings.remember({ ...anchor, product: plan.profile.product, instanceId: port.instanceId, port: port.port }).catch(() => {});
          }
          return (await firmware.revalidateDirectFirmware(staged.firmware)) && context.beforeDispatch() &&
            authorizedPlan(plan) && staged.isActive?.() !== false;
        }});
        return autoTargetPresent ? { transferCompleted: false, code: 'flash-mtk-auto-target-present' } : result;
      },
      async enterLoader(plan, anchor, canSend, sealed) {
        const live = await getTargets().queryDirectUsb({});
        if (!usbAnchorIsUnchanged(live, anchor, false)) return false;
        const attached = await selectQualifiedUsbAnchor(live, plan.profile, anchor.serial, runAdb);
        if (!attached || attached.identity !== anchor.identity || attached.location !== anchor.location ||
          !await firmware.revalidateDirectFirmware(sealed.firmware) || !canSend() || !authorizedPlan(plan)) return false;
        // Windows may briefly lose ADB before its reply returns. Never send this command a second time.
        try { await runAdb(['-t', attached.transport, 'reboot', 'loader'], { timeoutMs: 9000 }); } catch { /* The request may already have arrived. */ }
        return true;
      },
      async write(plan, target, staged, context) {
        const backend = getBackend(), options = writeOptions(plan);
        if (plan.coldStart && plan.platform === 'mtk') {
          return backend.write({ platform: 'mtk', tool: plan.tool, target, firmware: staged.firmware,
            options: { ...options, elevated: true } }, {
            ...context,
            async beforeDispatch() {
              if (!authorizedPlan(plan) || !await context.beforeDispatch() || !await firmware.revalidateDirectFirmware(staged.firmware) ||
                !await toolsIdle() || !await verifyColdMtkPort(plan, target, context.signal)) return false;
              const observed = coldMtkObservations.get(plan);
              if (!observed || observed.blocked || observed.target?.identity !== target.identity ||
                !sameMtkPort(observed.target, target) || !context.canDispatch() || !authorizedPlan(plan)) return false;
              observed.stop?.();
              return true;
            },
          });
        }
        if (plan.platform !== 'rk' || !plan.profile.product) return backend.write({
          platform: plan.platform, tool: plan.tool, target, firmware: staged.firmware, options,
        }, context);
        if (!await toolsIdle()) return { transferCompleted: false, code: 'flash-vendor-busy' };
        const checked = await backend.prepareRk({
          tool: plan.tool, firmware: staged.firmware, target,
          scanTarget: () => scanQualifiedRk(plan, target.location),
          beforeRamBoot: async () => authorizedPlan(plan) && await context.beforeDispatch() && await toolsIdle() && authorizedPlan(plan),
        });
        if (!checked?.ok) return { transferCompleted: false, code: 'flash-rk-storage-unverified' };
        return backend.write({ platform: 'rk', tool: plan.tool, target: checked.target, firmware: staged.firmware, options }, {
          ...context, async beforeDispatch() {
            if (!authorizedPlan(plan) || !await context.beforeDispatch(checked.target) || !await toolsIdle() ||
                !await firmware.revalidateDirectFirmware(staged.firmware) || !authorizedPlan(plan)) return false;
            context.onWriteStart();
            return true;
          },
        });
      },
      verify: (plan, candidate) => verifyBoot(plan, candidate, {
        queryUsb: () => getTargets().queryDirectUsb(), runAdb, retries: plan.sessionReview || plan.profile.boot ? 55 : 18,
      }),
    },
  });
  const enabledModes = platform => isWindows ? trustedModes(profiles, platform) : [];
  const respond = async platform => {
    const modes = enabledModes(platform);
    const saved = bindingsFor(platform) && modes.length ? await readSaved(platform) : null;
    const product = saved && profiles.find(row => row.platform === platform && row.product === saved.product);
    const display = product ? { label: product.board, ...(saved.port ? { port: saved.port } : {}) } : null;
    const tool = prepareTool && modes.length ? await checkTool(platform) : null;
    return { ok: true, enabled: modes.length > 0, modes, ...(modes.length ? {} : { code: 'flash-profile-unverified' }),
      ...(modes.some(mode => requiresSessionReview(platform, mode)) ? { sessionReviewRequired: true } : {}),
      ...(platform === 'mtk' && profiles.some(profile => modes.includes(profile.mode) && autoPowerOnProfile(profile)) ? { mtkAutoPowerOn: true } : {}),
      ...(platform === 'mtk' && fastMtk && modes.length ? { mtkFastReview: true } : {}),
      ...(tool ? { toolReady: tool.ok === true } : {}),
      ...(bindingsFor(platform) ? { savedTarget: display } : {}), ...flow.status(platform) };
  };

  function handle(action, call, noOwner = () => fail('flash-invalid-request')) {
    ipcMain.handle('firmware:direct:' + action, async (event, platform, payload) => {
      const owner = ownerFor(event);
      if (typeof platform !== 'string' || !Object.hasOwn(modesByPlatform, platform)) return fail('flash-invalid-request');
      if (!owner) return noOwner();
      try { return await call(platform, payload, event.senderFrame, owner); }
      catch { return fail('flash-preparation-failed'); }
    });
  }
  handle('state', platform => respond(platform));
  handle('validate-file', async (platform, payload, frame, owner) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Reflect.ownKeys(payload).length !== 1 ||
      !Object.hasOwn(payload, 'firmwareId') || !idText(payload.firmwareId)) return fail('flash-invalid-request');
    const saved = selections.get(platform);
    if (frame !== getOwnerFrame() || saved?.id !== payload.firmwareId || saved.frame !== frame) return cancelled();
    const modes = enabledModes(platform);
    if (!modes.length) return fail('flash-profile-unverified');
    if (requiresSessionReview(platform) && flow.active?.()) return fail('flash-busy');

    stopValidation(platform);
    invalidateSessionReview(platform);
    const controller = new AbortController();
    validations.set(platform, controller);
    const close = () => controller.abort();
    const stillOwned = () => !controller.signal.aborted && validations.get(platform) === controller &&
      selections.get(platform) === saved && frame === getOwnerFrame();
    owner.once?.('closed', close);
    try {
      const quick = platform === 'mtk' && fastMtk;
      const receipt = quick ? await firmware.prepareMtkQuickReview(saved.filePath, { signal: controller.signal })
        : await firmware.prepareDirectFirmware(platform, saved.filePath, { signal: controller.signal });
      if (!stillOwned()) return cancelled();
      if (!receipt || receipt.ok === false) return fail(preparationFailure(receipt?.code));
      let contentMismatch = false;
      const reviewModes = new Map();
      const approved = modes.filter(mode => {
        const matching = selectFirmwareProfile(profiles, platform, mode, receipt, onePass || quick);
        if (matching.ok && sessionReviewProfile(matching.profile)) {
          reviewModes.set(mode, matching.profile);
          return false;
        }
        if (matching.ok && digestMatches(matching.profile, receipt)) return true;
        if (matching.ok || matching.code === 'flash-firmware-content-unverified') contentMismatch = true;
        return false;
      });
      if (reviewModes.size) {
        const boards = new Set([...reviewModes.values()].map(profile => profile.board));
        if (boards.size !== 1 || ![...boards][0]) return fail('flash-profile-no-match');
        if ((!quick && !isHash(receipt.sha256)) || !receipt.path || !Array.isArray(receipt.files) || !receipt.files.length) return fail('flash-firmware-read-failed');
        const [board] = boards;
        sessionReviews.set(platform, { selection: saved, receipt, owner, modes: reviewModes, approvedMode: null, quick });
        return { ok: true, reviewRequired: true, modes: [...reviewModes.keys()], board,
          ...(quick ? { quickReview: true } : { fingerprint: receipt.sha256.toLowerCase() }) };
      }
      if (approved.length) return { ok: true, modes: approved };
      if (!contentMismatch) return fail('flash-profile-no-match');
      const fingerprint = platform === 'rk' ? receipt.contentSha256 : receipt.sha256;
      return { ...fail('flash-firmware-content-unverified'),
        ...(isHash(fingerprint) ? { fingerprint: fingerprint.toLowerCase() } : {}) };
    } catch (error) {
      return stillOwned() ? fail(preparationFailure(error?.code)) : cancelled();
    } finally {
      owner.removeListener?.('closed', close);
      if (validations.get(platform) === controller) validations.delete(platform);
    }
  }, cancelled);
  handle('review-file', async (platform, payload, frame, owner) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Reflect.ownKeys(payload).length !== 2 ||
      !Object.hasOwn(payload, 'firmwareId') || !Object.hasOwn(payload, 'mode') || !idText(payload.firmwareId) ||
      !enabledModes(platform).includes(payload.mode) || !requiresSessionReview(platform, payload.mode)) return fail('flash-invalid-request');
    const saved = selections.get(platform);
    if (frame !== getOwnerFrame() || saved?.id !== payload.firmwareId || saved.frame !== frame) return cancelled();
    if (reviewRequests.has(platform) || flow.active?.()) return fail('flash-busy');
    const review = sessionReviews.get(platform);
    const profile = review?.modes.get(payload.mode);
    if (review?.selection !== saved || review.owner !== owner || !profile || review.quick) return fail('flash-firmware-review-required');
    const request = Symbol();
    reviewRequests.set(platform, request);
    const stillOwned = () => reviewRequests.get(platform) === request && ownsSessionReview(platform, review) && !flow.active?.();
    const close = () => { if (ownsSessionReview(platform, review)) invalidateSessionReview(platform); };
    owner.once?.('closed', close);
    const checkReview = async () => {
      const unchanged = await unchangedReview(review);
      if (!stillOwned()) return cancelled();
      if (unchanged) return null;
      invalidateSessionReview(platform);
      return fail('flash-firmware-changed');
    };
    try {
      const before = await checkReview();
      if (before) return before;
      if (!stillOwned()) return cancelled();
      const mode = payload.mode;
      const answer = await ask({
        type: 'warning', title: tr('核对本次固件'),
        message: tr('仅核对当前文件与所选模式，不会开始刷机。结构检查无法验证固件来源，请确认它来自可信渠道。'),
        detail: [
          tr('板卡：{0}', { 0: profile.board }),
          tr('固件：{0}', { 0: path.basename(review.receipt.path) }),
          tr('刷机模式：{0}', { 0: modeLabels[mode]() }),
          tr('整包指纹（SHA-256）：{0}', { 0: review.receipt.sha256.toLowerCase() }),
          ...(mode === formatMode ? [tr('格式化后下载会先清除存储，可能影响设备配置和校准数据。')]
            : mode === 'firmware-upgrade' ? [tr('固件升级可能改写分区并清除数据，请先备份。')] : []),
        ].join('\n'),
        buttons: [tr('取消'), tr('确认本次固件')], defaultId: 0, cancelId: 0,
        checkboxLabel: tr('我确认固件来自可信渠道，适用于此板卡和所选刷机模式'),
      });
      if (!stillOwned()) return cancelled();
      const after = await checkReview();
      if (after) return after;
      if (!stillOwned() || answer?.response !== 1 || answer.checkboxChecked !== true) return cancelled();
      review.approvedMode = mode;
      return { ok: true, mode };
    } finally {
      owner.removeListener?.('closed', close);
      if (reviewRequests.get(platform) === request) reviewRequests.delete(platform);
    }
  }, cancelled);
  handle('prepare-tool', async (platform, payload, frame, owner) => {
    if (!prepareTool || !enabledModes(platform).length) return fail('flash-profile-unverified');
    if (payload !== undefined && (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        Object.keys(payload).some(key => key !== 'local') ||
        (payload.local !== undefined && typeof payload.local !== 'boolean'))) return fail('flash-invalid-request');
    if (configuringTool || flow.active() || !canStart() || frame !== getOwnerFrame()) return fail('flash-busy');
    configuringTool = true;
    const controller = new AbortController();
    const close = () => controller.abort();
    owner.once?.('closed', close);
    try {
      const result = await prepareTool(platform, {
        owner, frame, signal: controller.signal, local: payload?.local === true,
        findExisting: () => checkTool(platform, true),
        inspect: root => getBackend().inspect(platform, root),
      });
      if (frame !== getOwnerFrame() || controller.signal.aborted) return { ok: false, cancelled: true };
      if (!result?.ok) return result || fail('flash-tool-unavailable');
      toolChecks.set(platform, { expires: Date.now() + 30000, result: Promise.resolve(result) });
      return await respond(platform);
    } finally {
      owner.removeListener?.('closed', close);
      configuringTool = false;
    }
  });
  handle('register-target', async (platform, _payload, frame) => {
    const bindings = bindingsFor(platform);
    if (!isWindows || !bindings || flow.active() || !canStart()) return fail('flash-invalid-request');
    const preferredMode = platform === 'mtk' ? 'download-only' : 'upgrade';
    const enrolled = profiles.find(row => row.platform === platform && row.mode === preferredMode && row.product);
    if (!enrolled) return fail('flash-profile-unverified');
    const baseline = await getTargets().queryDirectUsb({});
    if (!baseline?.ok) return fail('flash-usb-unavailable');
    if ((platform === 'rk' ? baseline.mtk : baseline.rk).length) return fail('flash-platform-mismatch');
    if (baseline.mtk.length || baseline.rk.length) return fail('flash-anchor-required');
    const anchor = await selectQualifiedUsbAnchor(baseline, enrolled, '', runAdb);
    if (!anchor) return fail('flash-anchor-required');
    let port;
    if (platform === 'mtk') {
      const ports = (await windowsMtkPorts({})).filter(item => item.location === anchor.location);
      if (ports.length !== 1) return fail('flash-mtk-port-unknown');
      port = ports[0];
    }
    const fresh = await getTargets().queryDirectUsb({});
    if (flow.active() || frame !== getOwnerFrame() || !usbAnchorIsUnchanged(fresh, anchor, false)) return fail('flash-plan-changed');
    if (!await bindings.remember({ ...anchor, product: enrolled.product, ...(port ? { instanceId: port.instanceId, port: port.port } : {}) })) {
      return fail('flash-preparation-failed');
    }
    return { ok: true, savedTarget: { label: enrolled.board, ...(port ? { port: port.port } : {}) } };
  });
  handle('arm', async (platform, payload, frame, owner) => {
    const modes = enabledModes(platform);
    if (!modes.length) return fail('flash-profile-unverified');
    const saved = selections.get(platform);
    if (!idText(payload?.firmwareId) || saved?.id !== payload.firmwareId || saved.frame !== frame || frame !== getOwnerFrame()) return fail('flash-firmware-unavailable');
    if (!modes.includes(payload.mode) || (payload.targetHint !== undefined && payload.targetHint !== null && !serialValue(payload.targetHint))) return fail('flash-invalid-request');
    if ((payload.useSavedTarget !== undefined && typeof payload.useSavedTarget !== 'boolean') ||
      payload.useSavedTarget === true && (payload.targetHint || payload.coldStart)) return fail('flash-invalid-request');
    if ((payload.coldStart !== undefined && typeof payload.coldStart !== 'boolean') ||
      payload.coldStart === true && payload.targetHint) return fail('flash-invalid-request');
    if (payload.windowsPortId !== undefined) return fail('flash-invalid-request');
    if (requiresSessionReview(platform, payload.mode)) {
      if (reviewRequests.has(platform)) return fail('flash-busy');
      if (!sessionReviewForArm(platform, saved.id, payload.mode, frame, owner)) return fail('flash-firmware-review-required');
    }
    const autoPowerOn = payload.coldStart === true && platform === 'mtk' &&
      profiles.some(profile => profile.mode === payload.mode && autoPowerOnProfile(profile));
    return flow.arm({ platform, firmwareId: saved.id, filePath: saved.filePath, mode: payload.mode, targetHint: payload.targetHint || '',
      useSavedTarget: payload.useSavedTarget === true, coldStart: payload.coldStart === true,
      autoPowerOn, frame, owner }, frame);
  });
  handle('choose', (platform, payload, frame) => idText(payload?.jobId) && typeof payload.targetId === 'string' && payload.targetId.length <= 512
    ? flow.choose(platform, payload.jobId, payload.targetId, frame) : fail('flash-invalid-request'));
  handle('cancel', (platform, jobId, frame) => idText(jobId) ? flow.cancel(platform, jobId, frame) : fail('flash-invalid-request'));
  handle('enter-loader', (platform, jobId, frame) => idText(jobId) ? flow.enterLoader(platform, jobId, frame) : fail('flash-invalid-request'));

  return {
    rememberFile(platform, filePath, frame) {
      const id = randomUUID();
      stopValidation(platform);
      invalidateSessionReview(platform);
      selections.set(platform, { id, filePath, frame });
      return id;
    },
    forgetFile(platform, frame) {
      if (frame !== getOwnerFrame()) return;
      stopValidation(platform);
      invalidateSessionReview(platform);
      selections.delete(platform);
    },
    isActive: flow.active,
    isProtected: flow.isProtected,
    cancelPending() {
      for (const platform of validations.keys()) stopValidation(platform);
      sessionReviews.clear();
      reviewRequests.clear();
      flow.cancelPending();
    },
  };
}

module.exports = { registerFirmwareDirectWorkspace, trustedModes, uniqueTargetRows, verifyBoot };
