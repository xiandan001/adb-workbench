const { tr } = require('./localization.cjs');
const path = require('node:path');
const { readSafe, atomicReplace, checksum } = require('./ai-tools-file-safety.cjs');

const DEVICE_URL = 'https://github.com/login/device';
const FILE_NAME = 'feedback-github-auth.enc';
const LIMIT = 64 * 1024;
const ACCESS_TTL = 8 * 60 * 60;
const REFRESH_TTL = 183 * 24 * 60 * 60;
const MAX_REFRESH_TTL = 366 * 24 * 60 * 60;
const safeError = (code, message) => Object.assign(new Error(message), { code });
const tokenValid = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,4096}$/.test(value);
const loginValid = value => typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value);
const validDuration = (value, maximum) => Number.isInteger(value) && value > 0 && value <= maximum;

function createFeedbackAuth({ clientId = '', directory, canEncrypt = () => false, encrypt, decrypt, github, openExternal,
  now = Date.now, schedule = setTimeout, cancelTimer = clearTimeout } = {}) {
  const configured = typeof clientId === 'string' && /^[A-Za-z0-9_.-]{1,200}$/.test(clientId);
  const file = path.join(path.resolve(directory), FILE_NAME);
  let loaded = false; let disposed = false; let epoch = 0; let credentials; let persistent = false;
  let pending; let timer; let refreshFlight; let error = ''; let fileHash = null; let storageBlocked = false;
  const permitted = guard => { try { return !disposed && (!guard || guard() === true); } catch { return false; } };
  const active = (sequence, guard) => epoch === sequence && permitted(guard);
  const cryptoAvailable = () => { try { return canEncrypt() === true && typeof encrypt === 'function' && typeof decrypt === 'function'; } catch { return false; } };
  const validRefresh = item => item?.refreshToken && item.refreshExpiresAt > now();
  function publicStatus() {
    const authenticated = Boolean(credentials && (credentials.expiresAt > now() || validRefresh(credentials)));
    return { configured, authenticated, login: authenticated ? credentials.login : '', persistent: authenticated && persistent, pending: Boolean(pending),
      ...(pending?.userCode ? { userCode: pending.userCode, verificationUrl: DEVICE_URL, expiresAt: pending.expiresAt } : {}), ...(error ? { error } : {}) };
  }
  function initialize() {
    if (loaded || disposed) return;
    loaded = true;
    if (!configured) return;
    try {
      const saved = readSafe(file, undefined, LIMIT); fileHash = saved.hash;
      if (!saved.exists || !cryptoAvailable()) return;
      const plaintext = decrypt(saved.bytes);
      if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > 24000) throw new Error('Invalid record');
      const value = JSON.parse(plaintext);
      if (!value || value.version !== 1 || value.clientId !== clientId || !loginValid(value.login) || !tokenValid(value.accessToken)
        || !Number.isFinite(value.expiresAt) || value.expiresAt < 0
        || (value.refreshToken !== undefined && (!tokenValid(value.refreshToken) || !Number.isFinite(value.refreshExpiresAt) || value.refreshExpiresAt < 0))) throw new Error('Invalid record');
      credentials = { login: value.login, accessToken: value.accessToken, expiresAt: value.expiresAt,
        ...(value.refreshToken ? { refreshToken: value.refreshToken, refreshExpiresAt: value.refreshExpiresAt } : {}) };
      persistent = true;
    } catch {
      storageBlocked = true; error = tr("无法安全读取已保存的 GitHub 授权；当前仅可使用会话登录。");
    }
  }
  function persist() {
    persistent = false;
    if (!cryptoAvailable()) return;
    try {
      if (storageBlocked) throw new Error('Unsafe storage');
      const bytes = encrypt(JSON.stringify({ version: 1, clientId, ...credentials }));
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > LIMIT) throw new Error('Invalid encryption');
      atomicReplace(file, bytes, fileHash, undefined, LIMIT); fileHash = checksum(bytes); persistent = true;
    } catch { error = tr("GitHub 授权仅保留在本次会话中，安全保存未完成。"); }
  }
  function invalidate() {
    epoch++; if (timer !== undefined) cancelTimer(timer); timer = undefined; pending = undefined; refreshFlight = undefined;
  }
  function failPending(sequence, message) {
    if (sequence !== epoch || disposed) return;
    if (timer !== undefined) cancelTimer(timer); timer = undefined; pending = undefined; error = message;
  }
  function assertActive(sequence, guard) {
    if (!active(sequence, guard)) throw safeError('FEEDBACK_AUTH_CANCELLED', tr("授权操作已取消，请重试。"));
  }
  function tokenRecord(raw, prior) {
    if (!raw || !tokenValid(raw.access_token)) throw new Error('Invalid token response');
    const accessTtl = raw.expires_in === undefined ? ACCESS_TTL : raw.expires_in;
    if (!validDuration(accessTtl, ACCESS_TTL)) throw new Error('Invalid token expiry');
    const result = { accessToken: raw.access_token, expiresAt: now() + accessTtl * 1000 };
    if (raw.refresh_token !== undefined) {
      const refreshTtl = raw.refresh_token_expires_in === undefined ? REFRESH_TTL : raw.refresh_token_expires_in;
      if (!tokenValid(raw.refresh_token) || !validDuration(refreshTtl, MAX_REFRESH_TTL)) throw new Error('Invalid refresh token');
      result.refreshToken = raw.refresh_token; result.refreshExpiresAt = now() + refreshTtl * 1000;
    } else if (prior?.refreshToken) {
      result.refreshToken = prior.refreshToken; result.refreshExpiresAt = prior.refreshExpiresAt;
    }
    return result;
  }
  function queuePoll(job) {
    if (!active(job.sequence, job.guard)) { failPending(job.sequence, tr("授权操作已取消。")); return; }
    if (job.expiresAt <= now()) { failPending(job.sequence, tr("授权码已过期，请重新登录。")); return; }
    timer = schedule(() => { timer = undefined; void poll(job); }, Math.min(job.interval, job.expiresAt - now()));
  }
  async function poll(job) {
    if (!active(job.sequence, job.guard)) { failPending(job.sequence, tr("授权操作已取消。")); return; }
    if (job.expiresAt <= now()) { failPending(job.sequence, tr("授权码已过期，请重新登录。")); return; }
    try {
      const raw = await github.pollDevice(clientId, job.deviceCode);
      if (!active(job.sequence, job.guard)) { failPending(job.sequence, tr("授权操作已取消。")); return; }
      if (job.expiresAt <= now()) { failPending(job.sequence, tr("授权码已过期，请重新登录。")); return; }
      if (raw?.error === 'authorization_pending') { queuePoll(job); return; }
      if (raw?.error === 'slow_down') { job.interval += 5000; queuePoll(job); return; }
      if (raw?.error) {
        failPending(job.sequence, raw.error === 'access_denied' ? tr("GitHub 授权已拒绝，可重新登录。") : raw.error === 'expired_token' ? tr("授权码已过期，请重新登录。") : tr("GitHub 授权未完成，请重新登录。")); return;
      }
      const next = tokenRecord(raw); const user = await github.user(next.accessToken);
      if (!active(job.sequence, job.guard)) { failPending(job.sequence, tr("授权操作已取消。")); return; }
      if (job.expiresAt <= now()) { failPending(job.sequence, tr("授权码已过期，请重新登录。")); return; }
      if (!loginValid(user?.login)) throw new Error('Invalid user response');
      credentials = { ...next, login: user.login }; pending = undefined; error = ''; persist();
    } catch {
      if (!active(job.sequence, job.guard)) { failPending(job.sequence, tr("授权操作已取消。")); return; }
      failPending(job.sequence, tr("无法完成 GitHub 授权，请检查网络后重新登录。"));
    }
  }
  async function status() { initialize(); return publicStatus(); }
  async function start(guard) {
    initialize();
    if (!permitted(guard)) throw safeError('FEEDBACK_AUTH_CANCELLED', tr("授权操作已取消，请重试。"));
    if (!configured) { error = tr("应用尚未配置 GitHub 授权，请联系维护者。"); return publicStatus(); }
    if (pending) return publicStatus();
    invalidate(); error = ''; const job = { sequence: epoch, guard }; pending = job;
    try {
      const raw = await github.startDevice(clientId); assertActive(job.sequence, guard);
      if (!raw || !tokenValid(raw.device_code) || typeof raw.user_code !== 'string' || !/^[A-Z0-9-]{4,32}$/.test(raw.user_code)
        || raw.verification_uri !== DEVICE_URL || !validDuration(raw.expires_in, 3600)
        || (raw.interval !== undefined && !validDuration(raw.interval, 600))) throw new Error('Invalid device response');
      Object.assign(job, { deviceCode: raw.device_code, userCode: raw.user_code, expiresAt: now() + raw.expires_in * 1000, interval: Math.max(5, raw.interval || 5) * 1000 });
      try { await openExternal(DEVICE_URL); } catch { if (active(job.sequence, guard)) error = tr("未能打开浏览器，请手动打开授权网页并输入验证码。"); }
      assertActive(job.sequence, guard); queuePoll(job); return publicStatus();
    } catch (caught) {
      failPending(job.sequence, caught?.code === 'FEEDBACK_AUTH_CANCELLED' ? tr("授权操作已取消。") : tr("无法获取 GitHub 授权码，请检查配置和网络后重试。"));
      if (caught?.code === 'FEEDBACK_AUTH_CANCELLED') throw safeError('FEEDBACK_AUTH_CANCELLED', tr("授权操作已取消，请重试。"));
      return publicStatus();
    }
  }
  async function cancel() { initialize(); invalidate(); error = ''; return publicStatus(); }
  async function logout() {
    if (disposed) return publicStatus();
    initialize(); invalidate(); credentials = undefined; persistent = false; error = '';
    try {
      // Validate even when no file was previously loaded; never delete an external replacement.
      atomicReplace(file, null, fileHash, undefined, LIMIT); fileHash = null; storageBlocked = false;
    } catch { error = tr("已退出本次会话，但未能安全清除本机授权文件。"); }
    return publicStatus();
  }
  async function getAccessToken(guard) {
    initialize(); const sequence = epoch; assertActive(sequence, guard);
    if (!credentials) throw safeError('FEEDBACK_AUTH_REQUIRED', tr("请先登录 GitHub。"));
    if (credentials.expiresAt > now() + 30000) return credentials.accessToken;
    if (!validRefresh(credentials)) throw safeError('FEEDBACK_AUTH_EXPIRED', tr("GitHub 授权已过期，请重新登录。"));
    if (!refreshFlight) {
      const flight = { sequence, guards: new Set() }; refreshFlight = flight; flight.guards.add(guard);
      const live = () => active(sequence) && [...flight.guards].some(permitted);
      flight.promise = (async () => {
        const prior = credentials;
        try {
          const raw = await github.refresh(clientId, prior.refreshToken);
          if (!live()) throw safeError('FEEDBACK_AUTH_CANCELLED', tr("授权操作已取消，请重试。"));
          if (raw?.error) throw new Error('Refresh rejected');
          const next = tokenRecord(raw, prior); const user = await github.user(next.accessToken);
          if (!live()) throw safeError('FEEDBACK_AUTH_CANCELLED', tr("授权操作已取消，请重试。"));
          if (!loginValid(user?.login) || user.login.toLowerCase() !== prior.login.toLowerCase()) throw new Error('Account changed');
          credentials = { ...next, login: user.login }; error = ''; persist(); return next.accessToken;
        } catch (caught) {
          if (caught?.code === 'FEEDBACK_AUTH_CANCELLED') throw safeError('FEEDBACK_AUTH_CANCELLED', tr("授权操作已取消，请重试。"));
          if (live()) error = tr("GitHub 授权刷新未完成，请重新登录或稍后重试。");
          throw safeError('FEEDBACK_AUTH_REFRESH', tr("GitHub 授权刷新未完成，请重新登录或稍后重试。"));
        } finally { if (refreshFlight === flight) refreshFlight = undefined; }
      })();
    } else refreshFlight.guards.add(guard);
    const accessToken = await refreshFlight.promise; assertActive(sequence, guard); return accessToken;
  }
  async function getAccessSession(guard) {
    initialize(); const sequence = epoch; assertActive(sequence, guard);
    if (pending) throw safeError('FEEDBACK_AUTH_PENDING', tr("请先完成或取消当前 GitHub 授权。"));
    const accessToken = await getAccessToken(guard); assertActive(sequence, guard);
    if (pending || credentials?.accessToken !== accessToken) throw safeError('FEEDBACK_AUTH_CHANGED', tr("GitHub 授权已变化，请重试。"));
    return { accessToken, login: credentials.login, epoch: sequence };
  }
  function isSessionCurrent(session) {
    return Boolean(session && credentials && !disposed && !pending && session.epoch === epoch && credentials.accessToken === session.accessToken
      && credentials.login === session.login && credentials.expiresAt > now());
  }
  function dispose() { invalidate(); disposed = true; credentials = undefined; persistent = false; }
  return { status, start, cancel, logout, getAccessToken, getAccessSession, isSessionCurrent, dispose };
}

module.exports = { createFeedbackAuth };
