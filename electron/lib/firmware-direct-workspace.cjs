const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { tr } = require('./localization.cjs');
const { createFirmwareDirectFlow } = require('./firmware-direct-flow.cjs');
const { prepareDirectFirmware, revalidateDirectFirmware, stageDirectFirmware } = require('./firmware-direct-receipt.cjs');
const { acceptedFlashProfiles } = require('./firmware-direct-profiles.cjs');
const { parseAdbDeviceRows } = require('./adb-device-parser.cjs');
const { explicitTransport, selectQualifiedUsbAnchor, queryMtkPortHistory, nativeFlashToolsIdle, sanitizeMtkBinding } = require('./firmware-direct-binding.cjs');

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
const idText = value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);

function mtkAnchorIsUnchanged(inventory, anchor, allowDisconnected) {
  if (!inventory?.ok || inventory.mtk.length || inventory.rk.length) return false;
  const atPort = inventory.adb.filter(row => row.location === anchor.location);
  return !atPort.length ? allowDisconnected : atPort.length === 1 && atPort[0].identity === anchor.identity;
}

function trustedModes(profiles, platform) {
  const active = profiles.filter(profile => profile.platform === platform);
  return modesByPlatform[platform].filter(mode => active.some(profile => profile.mode === mode));
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

function bootTransport(list, serial) {
  if (!list.ok) return null;
  const matches = parseAdbDeviceRows(String(list.stdout)).filter(row => row.id === serial);
  if (matches.length !== 1 || matches[0].status !== 'device') return null;
  const ids = [...matches[0].detail.matchAll(/(?:^|\s)transport_id:([1-9][0-9]{0,9})(?=\s|$)/g)];
  return ids.length === 1 ? ids[0][1] : null;
}

async function verifyBoot(plan, candidate, { queryUsb, runAdb, retries = 18, interval = 2500 }) {
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
    ownerFor, getOwnerFrame, toolRoot, chooseToolRoot, rememberToolRoot, canStart, isWindows,
    profiles = acceptedFlashProfiles, ask = require('./app-message-dialog.cjs').ask,
    backend, targetProvider, firmware = { prepareDirectFirmware, revalidateDirectFirmware, stageDirectFirmware },
    runAdb = require('./adb-runtime.cjs').runAdb, createFlow = createFirmwareDirectFlow,
    resolveMtkPort = queryMtkPortHistory, toolsIdle = nativeFlashToolsIdle, mtkBindings,
  } = options;
  const getBackend = () => backend || (defaultBackend ||= require('./firmware-direct-backends.cjs').createDirectFlashBackends());
  const getTargets = () => targetProvider || require('./firmware-direct-targets.cjs');
  let defaultBackend;
  const selections = new Map();
  const readSavedMtk = async () => sanitizeMtkBinding(await mtkBindings?.read());
  const writeOptions = plan => ({ mode: plan.mode, reboot: plan.profile.reboot === true, permitFormatAll: plan.mode === formatMode });
  const scanQualifiedRk = async (plan, location) => {
    const targets = getTargets();
    const [native, tool] = await Promise.all([targets.queryDirectUsb({}), getBackend().listRk(plan.tool)]);
    if (!native.ok || !tool.ok || native.rk.length !== 1 || tool.devices.length !== 1 || native.mtk.length) return null;
    const rows = uniqueTargetRows(plan, targets.reconcileRkTargets(native.rk, tool.devices), native);
    return rows.length === 1 && rows[0].location === location ? rows[0] : null;
  };
  const flow = createFlow({
    services: {
      canStart: frame => canStart() && (!frame || frame === getOwnerFrame()),
      async prepare({ platform, filePath, mode, targetHint, frame, owner, useSavedTarget }, { signal }) {
        const receipt = await firmware.prepareDirectFirmware(platform, filePath, { signal });
        const matching = profiles.filter(profile => profile.platform === platform && profile.mode === mode &&
          (profile.contentSha256 ? profile.contentSha256 === receipt.contentSha256 : profile.firmwareSha256 === receipt.sha256) &&
          profile.chip === receipt.chip && (!profile.project || profile.project === receipt.project));
        if (matching.length !== 1) return fail('flash-profile-no-match');
        const profile = matching[0];
        const elevatedMtk = platform === 'mtk' && Boolean(profile.product);
        let anchor, boundMtk;
        if (useSavedTarget && !elevatedMtk) return fail('flash-invalid-request');
        if (profile.product) {
          const baseline = await getTargets().queryDirectUsb({ signal });
          if (!baseline?.ok || baseline.rk.length || baseline.mtk.length) return fail('flash-anchor-required');
          const saved = useSavedTarget ? await readSavedMtk() : null;
          if (useSavedTarget) {
            if (!saved || saved.product !== profile.product || !mtkAnchorIsUnchanged(baseline, saved, true)) return fail('flash-anchor-required');
            anchor = { ...saved, label: profile.board + ' · ' + saved.port };
          } else {
            anchor = await selectQualifiedUsbAnchor(baseline, profile, targetHint, runAdb);
          }
          if (!anchor) return fail('flash-anchor-required');
          if (!await toolsIdle()) return fail('flash-vendor-busy');
          if (elevatedMtk) {
            boundMtk = await resolveMtkPort(anchor, { signal });
            if (!boundMtk) return fail('flash-mtk-port-unknown');
            if (saved && (saved.port !== boundMtk.port || saved.instanceId.toUpperCase() !== boundMtk.instanceId.toUpperCase())) {
              return fail('flash-plan-changed');
            }
          }
        }
        let tool = await getBackend().inspect(platform, await toolRoot(platform));
        if (!tool.ok && chooseToolRoot && !signal.aborted && frame === getOwnerFrame()) {
          const root = await chooseToolRoot(platform, owner, frame, signal);
          if (root) {
            tool = await getBackend().inspect(platform, root);
            if (tool.ok && !signal.aborted && frame === getOwnerFrame()) await rememberToolRoot?.(platform, root);
          }
        }
        if (!tool.ok || tool.tool.version !== profile.toolVersion) return fail('flash-tool-unavailable');
        return { ok: true, platform, mode, targetHint, receipt, tool: tool.tool, profile, anchor, elevatedMtk, boundMtk, useSavedTarget };
      },
      async scan(plan, { signal }) {
        const targets = getTargets();
        const rk = plan.platform === 'rk' ? getBackend().listRk(plan.tool) : Promise.resolve(null);
        const [inventory, rockusb] = await Promise.all([targets.queryDirectUsb({ signal }), rk]);
        if (!inventory.ok || rockusb?.ok === false) return fail('flash-usb-unavailable');
        const adbMatches = plan.targetHint ? inventory.adb.filter(item => sameSerial(item.serial, plan.targetHint)) : [];
        const rows = plan.platform === 'rk' ? targets.reconcileRkTargets(inventory.rk, rockusb.devices) : inventory.mtk;
        if (plan.profile.product) {
          const anchor = plan.useSavedTarget ? (mtkAnchorIsUnchanged(inventory, plan.anchor, true) ? plan.anchor : null)
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
        const targetLabel = target?.label || target?.serial;
        const answer = await ask({
          type: 'warning', title: tr('确认开始直刷'),
          message: target?.selector ? tr('确认目标后将立即写入，请保持 USB 连接和设备供电。')
            : tr('确认固件和刷机模式。已确认的目标进入刷机模式后将开始写入。'),
          detail: [
            plan.profile.board, path.basename(plan.receipt.path), modeLabels[plan.mode](),
            targetLabel ? tr('目标：{0}', { 0: targetLabel }) : tr('目标尚未绑定，识别到刷机设备后需要选择目标。'),
            ...(plan.profile.product ? [tr('保持目标设备接在原 USB 口，不要换线或更换设备。')] : []),
            dangerous ? tr('格式化后下载会先清除存储，可能影响设备配置和校准数据。')
              : plan.mode === 'firmware-upgrade' ? tr('固件升级可能改写分区并清除数据，请先备份。')
                : tr('确认后可能覆盖设备上的系统和数据。'),
          ].join('\n'),
          buttons: [tr('取消'), tr('开始刷机')], defaultId: 0, cancelId: 0,
          ...(dangerous ? { checkboxLabel: tr('我已了解格式化会清除设备数据') } : {}),
        });
        return !signal.aborted && owner === getOwnerFrame() && answer?.response === 1 && (!dangerous || answer.checkboxChecked === true);
      },
      stage: (plan, context) => firmware.stageDirectFirmware(plan.platform, plan.receipt, context),
      validate: async (plan, staged) => staged.firmware.sha256 === plan.receipt.sha256 && await firmware.revalidateDirectFirmware(staged.firmware),
      async armVendor(plan, anchor, staged, context) {
        return getBackend().write({
          platform: 'mtk', tool: plan.tool, target: plan.boundMtk, firmware: staged.firmware,
          options: { ...writeOptions(plan), elevated: true },
        }, { ...context, async beforeDispatch() {
          if (!context.beforeDispatch() || !await toolsIdle() || !await firmware.revalidateDirectFirmware(staged.firmware)) return false;
          const port = await resolveMtkPort(anchor, {});
          if (!port || port.port !== plan.boundMtk.port || port.instanceId.toLowerCase() !== plan.boundMtk.instanceId.toLowerCase()) return false;
          const live = await getTargets().queryDirectUsb({});
          if (!mtkAnchorIsUnchanged(live, anchor, plan.useSavedTarget === true) || !context.beforeDispatch() || !await toolsIdle()) return false;
          if (!plan.useSavedTarget && mtkBindings) {
            // The approved, still-live ADB target and its Windows port reservation were checked together.
            await mtkBindings.remember({ ...anchor, product: plan.profile.product, instanceId: port.instanceId, port: port.port }).catch(() => {});
          }
          return context.beforeDispatch();
        }});
      },
      async enterLoader(plan, anchor, canSend) {
        const live = await getTargets().queryDirectUsb({});
        if (!mtkAnchorIsUnchanged(live, anchor, false)) return false;
        const attached = await selectQualifiedUsbAnchor(live, plan.profile, anchor.serial, runAdb);
        if (!attached || attached.identity !== anchor.identity || attached.location !== anchor.location || !canSend()) return false;
        // Windows may briefly lose ADB before its reply returns. Never send this command a second time.
        try { await runAdb(['-t', attached.transport, 'reboot', 'loader'], { timeoutMs: 9000 }); } catch { /* The request may already have arrived. */ }
        return true;
      },
      async write(plan, target, staged, context) {
        const backend = getBackend(), options = writeOptions(plan);
        if (plan.platform !== 'rk' || !plan.profile.product) return backend.write({
          platform: plan.platform, tool: plan.tool, target, firmware: staged.firmware, options,
        }, context);
        if (!await toolsIdle()) return { transferCompleted: false, code: 'flash-vendor-busy' };
        const checked = await backend.prepareRk({
          tool: plan.tool, firmware: staged.firmware, target,
          scanTarget: () => scanQualifiedRk(plan, target.location),
          beforeRamBoot: async () => await context.beforeDispatch() && await toolsIdle(),
        });
        if (!checked?.ok) return { transferCompleted: false, code: 'flash-rk-storage-unverified' };
        return backend.write({ platform: 'rk', tool: plan.tool, target: checked.target, firmware: staged.firmware, options }, {
          ...context, async beforeDispatch() {
            if (!await context.beforeDispatch(checked.target) || !await toolsIdle()) return false;
            context.onWriteStart();
            return true;
          },
        });
      },
      verify: (plan, candidate) => verifyBoot(plan, candidate, {
        queryUsb: () => getTargets().queryDirectUsb(), runAdb, retries: plan.profile.boot ? 55 : 18,
      }),
    },
  });
  const enabledModes = platform => isWindows ? trustedModes(profiles, platform) : [];
  const respond = async platform => {
    const modes = enabledModes(platform);
    const saved = platform === 'mtk' && mtkBindings && modes.length ? await readSavedMtk() : null;
    const product = saved && profiles.find(row => row.platform === platform && row.product === saved.product);
    const display = product ? { label: product.board, port: saved.port } : null;
    return { ok: true, enabled: modes.length > 0, modes, ...(modes.length ? {} : { code: 'flash-profile-unverified' }),
      ...(platform === 'mtk' && mtkBindings ? { savedTarget: display } : {}), ...flow.status(platform) };
  };

  function handle(action, call) {
    ipcMain.handle('firmware:direct:' + action, async (event, platform, payload) => {
      const owner = ownerFor(event);
      if (!owner || typeof platform !== 'string' || !Object.hasOwn(modesByPlatform, platform)) return fail('flash-invalid-request');
      try { return await call(platform, payload, event.senderFrame, owner); }
      catch { return fail('flash-preparation-failed'); }
    });
  }
  handle('state', platform => respond(platform));
  handle('arm', async (platform, payload, frame, owner) => {
    const modes = enabledModes(platform);
    if (!modes.length) return fail('flash-profile-unverified');
    const saved = selections.get(platform);
    if (!idText(payload?.firmwareId) || saved?.id !== payload.firmwareId || saved.frame !== frame) return fail('flash-firmware-unavailable');
    if (!modes.includes(payload.mode) || (payload.targetHint !== undefined && payload.targetHint !== null && !serialValue(payload.targetHint))) return fail('flash-invalid-request');
    if ((payload.useSavedTarget !== undefined && typeof payload.useSavedTarget !== 'boolean') ||
      payload.useSavedTarget === true && (platform !== 'mtk' || payload.targetHint)) return fail('flash-invalid-request');
    return flow.arm({ platform, filePath: saved.filePath, mode: payload.mode, targetHint: payload.targetHint || '',
      useSavedTarget: payload.useSavedTarget === true, frame, owner }, frame);
  });
  handle('choose', (platform, payload, frame) => idText(payload?.jobId) && typeof payload.targetId === 'string' && payload.targetId.length <= 512
    ? flow.choose(platform, payload.jobId, payload.targetId, frame) : fail('flash-invalid-request'));
  handle('cancel', (platform, jobId, frame) => idText(jobId) ? flow.cancel(platform, jobId, frame) : fail('flash-invalid-request'));
  handle('enter-loader', (platform, jobId, frame) => idText(jobId) ? flow.enterLoader(platform, jobId, frame) : fail('flash-invalid-request'));

  return {
    rememberFile(platform, filePath, frame) {
      const id = randomUUID();
      selections.set(platform, { id, filePath, frame });
      return id;
    },
    isActive: flow.active,
    isProtected: flow.isProtected,
    cancelPending: flow.cancelPending,
  };
}

module.exports = { registerFirmwareDirectWorkspace, trustedModes, uniqueTargetRows, verifyBoot };
