const { tr } = require('./localization.cjs');
// electron/lib/vip.cjs
// VIP 授权运行时：Ed25519 验签 + 机器码绑定 + fail-closed
// 性能优化：全部异步化，机器码采集不阻塞 main 进程

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { getMachineIdAsync, getMachineIdSync, resolveMachineIdAsync, rememberMachineId } = require('./machine-id.cjs');
const { atomicWritePrivateFile } = require('./machine-identity.cjs');

// 应用内嵌公钥（对应开发者本地保存的私钥，用于验签）
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAaf5YkO6Yb4Oz7mcVQNAmx+pb5hiSEzCy9pRYzzR8pEs=
-----END PUBLIC KEY-----`;

const TOKEN_FILE = 'vip-token.txt';
// 激活记录、备注与复制历史持久化文件
const ACTIVATION_RECORDS_FILE = 'vip-activation-records.json';
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function getTokenPath() {
  return path.join(app.getPath('userData'), TOKEN_FILE);
}

// 激活记录数据读写：只记录本机激活流程证据，不参与授权判定。
function getActivationRecordsPath() {
  return path.join(app.getPath('userData'), ACTIVATION_RECORDS_FILE);
}

function readActivationRecordData() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getActivationRecordsPath(), 'utf8'));
    return {
      version: 1,
      records: Array.isArray(parsed.records) ? parsed.records : [],
      copyHistory: Array.isArray(parsed.copyHistory) ? parsed.copyHistory : []
    };
  } catch {
    return { version: 1, records: [], copyHistory: [] };
  }
}

function writeActivationRecordData(data) {
  const normalized = {
    version: 1,
    records: Array.isArray(data.records) ? data.records.slice(0, 200) : [],
    copyHistory: Array.isArray(data.copyHistory) ? data.copyHistory.slice(0, 200) : []
  };
  fs.mkdirSync(path.dirname(getActivationRecordsPath()), { recursive: true });
  fs.writeFileSync(getActivationRecordsPath(), JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

function appendActivationRecord(payload, machineId, token) {
  const data = readActivationRecordData();
  const tokenHash = crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 16);
  const duplicate = data.records.find(record => record.tokenHash === tokenHash && record.machineId === machineId);
  const record = {
    id: duplicate?.id || `act-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    activatedAt: new Date().toISOString(),
    machineId,
    scope: payload.s === 'vip' ? 'vip' : 'free',
    type: payload.t || null,
    issuedAt: payload.i || null,
    expiresAt: payload.e || null,
    tokenHash,
    note: duplicate?.note || '',
    reSignNote: tr("如更换设备或机器码变化，请复制当前机器码与本记录截图联系开发者重签。")
  };
  if (duplicate) {
    data.records = data.records.map(item => item.id === duplicate.id ? { ...duplicate, ...record } : item);
  } else {
    data.records.unshift(record);
  }
  writeActivationRecordData(data);
  return record;
}

function addCopyHistory(kind, value) {
  const safeKind = String(kind || 'machineId').trim().slice(0, 40) || 'machineId';
  const safeValue = String(value || '').trim();
  if (!safeValue) return readActivationRecordData();
  const data = readActivationRecordData();
  data.copyHistory.unshift({
    id: `copy-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    kind: safeKind,
    value: safeValue,
    copiedAt: new Date().toISOString()
  });
  return writeActivationRecordData(data);
}

// 返回 free 基线状态（携带本机机器码）
function freeBaseStatus(mid, reason) {
  return {
    activated: false,
    scope: 'free',
    type: null,
    issuedAt: null,
    expiresAt: null,
    machineId: mid?.machineId || null,
    reason
  };
}

// 验证一个 token 字符串（不依赖文件），返回 { valid, payload, error }
function verifyToken(token) {
  const parts = String(token).trim().split('.');
  if (parts.length !== 2) return { valid: false, error: 'bad_format' };

  const payloadBytes = decodeCanonicalBase64Url(parts[0]);
  if (!payloadBytes) return { valid: false, error: 'bad_payload' };

  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch (e) {
    return { valid: false, error: 'bad_payload' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      typeof payload.m !== 'string' || !/^[a-f0-9]{64}$/.test(payload.m)) {
    return { valid: false, error: 'bad_payload' };
  }

  const sig = decodeCanonicalBase64Url(parts[1]);
  if (!sig || sig.length !== 64) {
    return { valid: false, error: 'bad_signature' };
  }

  // Ed25519 必须使用 crypto.verify(null, data, key, sig)，不支持 createVerify(null)
  let valid;
  try {
    valid = crypto.verify(null, Buffer.from(parts[0]), PUBLIC_KEY, sig);
  } catch (e) {
    return { valid: false, error: 'bad_signature' };
  }
  if (!valid) return { valid: false, error: 'bad_signature' };
  return { valid: true, payload };
}

function decodeCanonicalBase64Url(segment) {
  const value = String(segment || '');
  if (!value || !BASE64URL_RE.test(value)) return null;
  let decoded;
  try {
    decoded = Buffer.from(value, 'base64url');
  } catch {
    return null;
  }
  return decoded.toString('base64url') === value ? decoded : null;
}

// 异步解析并验证 token：读文件 → 验签与过期检查 → 验证本机身份
async function computeStatusAsync() {
  // 1. 取机器码（异步，不阻塞 main 进程）
  let mid = await getMachineIdAsync();

  // 2. 读 token
  let token;
  try {
    token = fs.readFileSync(getTokenPath(), 'utf8').trim();
  } catch (e) {
    return mid.success ? freeBaseStatus(mid, 'no_token') :
      { ...freeBaseStatus(null, 'machine_id_failed'), error: mid.error };
  }

  // 3. 验签
  const { valid, payload, error } = verifyToken(token);
  if (!valid) return freeBaseStatus(mid, error);

  // 4. 过期检查（订阅制预留）
  if (payload.t === 'subscription' && payload.e) {
    if (Math.floor(Date.now() / 1000) > payload.e) {
      return freeBaseStatus(mid, 'expired');
    }
  }

  // 5. Only a valid, unexpired signed license may select a reconstructed local
  // fingerprint. The encrypted identity is a binding aid, never an entitlement.
  mid = await resolveMachineIdAsync(payload.m);
  if (!mid.success) return { ...freeBaseStatus(null, 'machine_id_failed'), error: mid.error };
  if (payload.m !== mid.machineId) return freeBaseStatus(mid, 'machine_mismatch');
  rememberMachineId(payload.m);

  // 6. 全部通过
  return {
    activated: true,
    scope: payload.s === 'vip' ? 'vip' : 'free',
    type: payload.t,
    issuedAt: payload.i,
    expiresAt: payload.e,
    machineId: mid.machineId,
    reason: null
  };
}

function register(ipcMain) {
  // 返回当前会员状态（异步，不阻塞）
  ipcMain.handle('vip:getStatus', async () => {
    return computeStatusAsync();
  });

  // 返回本机机器码（异步）
  ipcMain.handle('vip:getMachineId', async () => {
    return getMachineIdAsync();
  });

  // 激活：验签并持久化 token
  ipcMain.handle('vip:activate', async (event, token) => {
    if (!token || typeof token !== 'string') {
      return { success: false, error: 'token_empty' };
    }
    const { valid, payload, error } = verifyToken(token);
    if (!valid) return { success: false, error };

    if (payload.t === 'subscription' && payload.e &&
        Math.floor(Date.now() / 1000) > payload.e) {
      return { success: false, error: 'expired' };
    }
    const mid = await resolveMachineIdAsync(payload.m);
    if (!mid.success) return { success: false, error: 'machine_id_failed' };
    if (payload.m !== mid.machineId) return { success: false, error: 'machine_mismatch' };

    // 持久化
    try {
      atomicWritePrivateFile(getTokenPath(), String(token).trim());
    } catch (e) {
      return { success: false, error: 'write_failed', detail: e.message };
    }
    rememberMachineId(payload.m);
    // Ancillary history cannot turn a durably saved license into a failed
    // activation; it is not used for authorization or identity recovery.
    try { appendActivationRecord(payload, mid.machineId, token); } catch { /* best effort */ }
    return { success: true, status: await computeStatusAsync() };
  });

  // 解绑（预留换机）
  ipcMain.handle('vip:deactivate', async () => {
    try {
      fs.unlinkSync(getTokenPath());
    } catch (e) { /* 文件不存在无碍 */ }
    return { success: true, status: await computeStatusAsync() };
  });

  // 激活记录增强：记录、备注、复制历史与重签流程说明。
  ipcMain.handle('vip:getActivationRecords', async () => {
    return { ok: true, ...readActivationRecordData() };
  });

  ipcMain.handle('vip:updateActivationRecordNote', async (event, args) => {
    const id = String(args?.id || '').trim();
    const note = String(args?.note || '').slice(0, 1000);
    if (!id) return { ok: false, error: 'record_id_required' };
    const data = readActivationRecordData();
    let updated = false;
    data.records = data.records.map(record => {
      if (record.id !== id) return record;
      updated = true;
      return { ...record, note, noteUpdatedAt: new Date().toISOString() };
    });
    writeActivationRecordData(data);
    return { ok: true, updated, ...readActivationRecordData() };
  });

  ipcMain.handle('vip:addCopyHistory', async (event, args) => {
    const data = addCopyHistory(args?.kind, args?.value);
    return { ok: true, ...data };
  });

  ipcMain.handle('vip:clearCopyHistory', async () => {
    const data = readActivationRecordData();
    data.copyHistory = [];
    writeActivationRecordData(data);
    return { ok: true, ...readActivationRecordData() };
  });
}

// 供其他 main 进程模块同步调用的状态查询（使用缓存，不阻塞）
// 注意：首次调用时缓存可能未就绪，返回 free 状态
function getStatus() {
  const mid = getMachineIdSync();
  if (!mid.success) {
    return { ...freeBaseStatus(null, 'not_ready') };
  }
  let token;
  try {
    token = fs.readFileSync(getTokenPath(), 'utf8').trim();
  } catch (e) {
    return freeBaseStatus(mid, 'no_token');
  }
  const { valid, payload, error } = verifyToken(token);
  if (!valid) return freeBaseStatus(mid, error);
  if (payload.m !== mid.machineId) return freeBaseStatus(mid, 'machine_mismatch');
  if (payload.t === 'subscription' && payload.e &&
      Math.floor(Date.now() / 1000) > payload.e) {
    return freeBaseStatus(mid, 'expired');
  }
  return {
    activated: true, scope: payload.s === 'vip' ? 'vip' : 'free', type: payload.t,
    issuedAt: payload.i, expiresAt: payload.e,
    machineId: mid.machineId, reason: null
  };
}

// 启动预采集并恢复有效的旧授权身份（在 app.whenReady 中异步调用）
function preload() {
  return computeStatusAsync();
}

module.exports = {
  register,
  getStatus,
  // 供新增巡检模块使用异步会员状态，避免机器码缓存未就绪时误判为基础版
  getStatusAsync: computeStatusAsync,
  readActivationRecordData,
  addCopyHistory,
  verifyToken,
  preload
};
