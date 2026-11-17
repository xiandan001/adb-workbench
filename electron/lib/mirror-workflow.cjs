const path = require('node:path');
const { tr } = require('./localization.cjs');
const { mirrorSessions } = require('./mirror-session-state.cjs');
const { createMirrorProfileStore, safeMirrorSettings, profileIdentityKey } = require('./mirror-profile-store.cjs');
const { readMirrorIdentity } = require('./mirror-device-identity.cjs');
const { resolveDeviceRef } = require('./device-registry.cjs');
const fail = code => Object.assign(new Error({
  MIRROR_OWNER: tr('请在卓控台主窗口核对当前投屏会话后重试。'),
  MIRROR_DEVICE_CHANGED: tr('设备连接已变化，未继续启动或保存投屏配置。'),
  MIRROR_SESSION: tr('投屏会话已结束或已变化，请核对当前设备。'),
  MIRROR_IDENTITY_TIMEOUT: tr('设备身份确认超时，本次不套用其他设备的配置。')
}[code] || tr('投屏操作未完成，请核对设备后重试。')), { code });
let singleton;

function createMirrorWorkflow({ profiles, state = mirrorSessions, getOwner, resolveRef = resolveDeviceRef, readIdentity = readMirrorIdentity,
  identityTimeoutMs = 1500 } = {}) {
  const contexts = new Map(), ownerGenerations = new WeakMap();
  function authorize(event) {
    const owner = getOwner(), contents = owner?.webContents;
    if (!owner || owner.isDestroyed() || !contents || contents.isDestroyed() || event?.sender !== contents || event.senderFrame !== contents.mainFrame) throw fail('MIRROR_OWNER');
    if (!ownerGenerations.has(contents)) {
      ownerGenerations.set(contents, 0);
      contents.on?.('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) ownerGenerations.set(contents, ownerGenerations.get(contents) + 1); });
    }
    const generation = ownerGenerations.get(contents);
    return () => { const current = getOwner(); if (current !== owner || owner.isDestroyed() || contents.isDestroyed() || contents !== current.webContents || generation !== ownerGenerations.get(contents)) throw fail('MIRROR_OWNER'); };
  }
  function verify(context) {
    if (!state.active(context.ticket)) throw fail('MIRROR_SESSION');
    const current = resolveRef(context.ticket.deviceId);
    if (current.status !== 'device' || current.generation !== context.ref.generation || current.targetKey !== context.ref.targetKey || current.transport !== context.ref.transport) throw fail('MIRROR_DEVICE_CHANGED');
    return current;
  }
  async function identity(context) {
    let timer;
    try { return await Promise.race([readIdentity(context.ticket.deviceId, context.ref), new Promise((_, reject) => { timer = setTimeout(() => reject(fail('MIRROR_IDENTITY_TIMEOUT')), identityTimeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  async function prepare(event, deviceId, settings = {}, options = {}) {
    const checkOwner = authorize(event), ref = resolveRef(deviceId);
    if (ref.status !== 'device') throw fail('MIRROR_DEVICE_CHANGED');
    const started = state.begin({ deviceId, transport: ref.transport, generation: ref.generation });
    if (started.alreadyActive) return { ticket: started.ticket, alreadyActive: true };
    for (const [id, context] of contexts) if (!state.current(context.ticket)) contexts.delete(id);
    const context = { ticket: started.ticket, ref, checkOwner, settings: safeMirrorSettings(settings), globalSettings: safeMirrorSettings(settings), identity: null, hdcOrdinal: null };
    contexts.set(started.ticket.id, context);
    const output = { ticket: context.ticket, settings: { ...settings }, profileMode: 'global', audioMode: null };
    try {
      const store = await profiles.list(); checkOwner(); verify(context);
      if (!store.profiles.length || options.profileMode === 'global') return output;
      context.identity = await identity(context); checkOwner(); verify(context);
      const saved = await profiles.find(context.identity); checkOwner(); verify(context);
      if (!saved) { state.update(context.ticket, { profileStatus: profileIdentityKey(context.identity) ? 'none' : 'unavailable' }); return output; }
      context.profileId = saved.id;
      if (options.profileMode !== 'remembered' && JSON.stringify(context.globalSettings) !== JSON.stringify(saved.globalSettings)) {
        state.update(context.ticket, { profileStatus: 'changed' }); return output;
      }
      context.settings = { ...saved.settings }; output.settings = { ...settings, ...saved.settings }; output.audioMode = saved.settings.audioMode || null; output.profileMode = 'remembered';
      state.update(context.ticket, { profileStatus: 'available', profileUsed: true }); return output;
    } catch (error) {
      if (['MIRROR_OWNER', 'MIRROR_DEVICE_CHANGED', 'MIRROR_SESSION'].includes(error.code)) { state.fail(context.ticket); throw error; }
      state.update(context.ticket, { profileStatus: 'error' }); return output;
    }
  }
  async function performRemember(context, checkOwner, verification) {
    checkOwner(); verify(context);
    if (!state.confirm(context.ticket, verification)) throw fail('MIRROR_SESSION');
    state.update(context.ticket, { profileStatus: 'saving' });
    try {
      const value = await identity(context); checkOwner(); verify(context);
      if (!profileIdentityKey(value)) { state.update(context.ticket, { profileStatus: 'unavailable' }); return { ok: false, code: 'MIRROR_IDENTITY', error: tr('无法可靠识别此设备，未保存或套用其他设备的投屏配置。') }; }
      const current = state.current(context.ticket), settings = { ...context.settings, ...(current.audioMode ? { audioMode: current.audioMode === 'disabled' ? 'disabled' : 'default' } : {}) };
      if (context.ref.transport === 'hdc') { delete settings.bitrate; delete settings.maxSize; settings.audioMode = 'disabled'; }
      await profiles.remember({ identity: value, settings, globalSettings: context.globalSettings, verification, toolVersion: current.toolVersion || '' }, () => { checkOwner(); verify(context); });
      context.profileId = profileIdentityKey(value); state.update(context.ticket, { profileStatus: 'saved' }); return { ok: true };
    } catch (error) {
      if (state.current(context.ticket)?.profileStatus === 'saving') state.update(context.ticket, { profileStatus: 'error' });
      if (['MIRROR_OWNER', 'MIRROR_DEVICE_CHANGED', 'MIRROR_SESSION'].includes(error.code)) throw error;
      state.update(context.ticket, { profileStatus: 'error' }); return { ok: false, error: tr('投屏配置未能保存，原配置保持不变；当前投屏不受影响。') };
    }
  }
  function remember(context, checkOwner, verification) {
    if (!context.rememberFlight) context.rememberFlight = performRemember(context, checkOwner, verification).finally(() => { context.rememberFlight = null; });
    return context.rememberFlight;
  }
  function observe(ticket, diagnostic) {
    const accepted = state.observe(ticket, diagnostic), context = contexts.get(ticket.id);
    if (accepted && context && diagnostic.readiness === 'decoded-frame' && !context.savingDecoded) {
      context.savingDecoded = true; void remember(context, context.checkOwner, 'decoded-frame').catch(() => {});
    }
  }
  return { prepare, observe, snapshot: () => state.snapshot(),
    guard(ticket) { const context = contexts.get(ticket.id); if (!context) throw fail('MIRROR_SESSION'); context.checkOwner(); verify(context); },
    beginAudioFallback(ticket, fromAttempt) {
      const context = contexts.get(ticket.id); if (!context) throw fail('MIRROR_SESSION'); context.checkOwner(); verify(context);
      if (!state.beginAudioFallback(ticket, fromAttempt)) throw fail('MIRROR_SESSION');
    },
    fail(ticket, reason) { state.fail(ticket, reason); },
    completeHdc(ticket, ordinal) {
      const context = contexts.get(ticket.id); if (!context || !Number.isSafeInteger(ordinal)) return;
      context.checkOwner(); verify(context); context.hdcOrdinal = ordinal;
      observe(ticket, { source: 'mirror', transport: 'hdc', event: 'ready', readiness: 'decoded-frame', audioMode: 'disabled', attemptNumber: 1 });
    },
    observeHdc(deviceId, ordinal, ref, diagnostic) {
      const current = state.get(deviceId), context = current && contexts.get(current.id);
      if (!context || context.ref.transport !== 'hdc' || context.ref.generation !== ref.generation || context.hdcOrdinal !== null && context.hdcOrdinal !== ordinal) return;
      context.hdcOrdinal = ordinal; observe(context.ticket, diagnostic);
    },
    async confirm(event, args) { const checkOwner = authorize(event), context = contexts.get(args?.sessionId);
      if (!context || context.ticket.deviceId !== args?.deviceId) throw fail('MIRROR_SESSION'); return remember(context, checkOwner, 'user-confirmed'); },
    async forget(event, args) { const checkOwner = authorize(event), context = contexts.get(args?.sessionId);
      if (!context || context.ticket.deviceId !== args?.deviceId || !context.profileId) throw fail('MIRROR_SESSION'); verify(context);
      await profiles.forget(context.profileId, () => { checkOwner(); verify(context); }); state.update(context.ticket, { profileStatus: 'none', profileUsed: false }); return { ok: true }; },
    authorize, state };
}
function register(ipcMain) {
  const { app } = require('electron'), ctx = require('./app-context.cjs');
  const profiles = createMirrorProfileStore({ filename: path.join(app.getPath('userData'), 'mirror-profiles.v1.json') });
  singleton = createMirrorWorkflow({ profiles, getOwner: ctx.getMainWindow });
  mirrorSessions.setNotify(value => { const owner = ctx.getMainWindow(); if (owner && !owner.isDestroyed() && !owner.webContents.isDestroyed()) owner.webContents.send('mirror:changed', value); });
  ipcMain.handle('mirror:state', event => { singleton.authorize(event)(); return { ok: true, ...singleton.snapshot() }; });
  for (const method of ['confirm', 'forget']) ipcMain.handle('mirror:' + method, async (event, args) => {
    try { return await singleton[method](event, args); } catch { return { ok: false, error: tr('投屏会话或设备已变化，请核对当前设备后重试。') }; }
  });
  return singleton;
}
module.exports = { createMirrorWorkflow, register, getWorkflow: () => singleton };
