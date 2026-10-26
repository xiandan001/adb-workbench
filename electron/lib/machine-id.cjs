const { tr } = require('./localization.cjs');
// electron/lib/machine-id.cjs
// 采集 Windows 硬件指纹（CPU + 主板 + 磁盘 + MachineGuid），输出 SHA-256 机器码
// 性能优化：正常路径将 4 个 PowerShell 查询合并为 1 次 JSON 输出（~2秒）

const { execFile } = require('child_process');
const path = require('path');
const { app, safeStorage } = require('electron');
const { normalize, hashMachineId, candidateMachineIds, createIdentityStore } = require('./machine-identity.cjs');

let cachedMachineId = null;
let cachedSources = null;
let cachedEvidence = null;
let cachedCandidates = new Set();
let pendingPromise = null;
let lastRecoveryAttempt = 0;
let identityStore = null;

function getIdentityStore() {
  if (!identityStore) identityStore = createIdentityStore({
    file: path.join(app.getPath('userData'), 'machine-identity.dat'), safeStorage
  });
  return identityStore;
}

// 单次 PowerShell 脚本：一次性采集全部 4 源，输出 JSON（用 ConvertTo-Json 避免转义问题）
const PS_SCRIPT = "$ErrorActionPreference='SilentlyContinue'; $disks=@(Get-CimInstance Win32_DiskDrive); [ordered]@{cpu=(Get-CimInstance Win32_Processor).ProcessorId;board=(Get-CimInstance Win32_BaseBoard).SerialNumber;disk=($disks|Select-Object -First 1).SerialNumber;guid=(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid;disks=@($disks.SerialNumber)} | ConvertTo-Json -Compress";
const POWERSHELL_EXE = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';
const REG_EXE = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'reg.exe') : 'reg.exe';
const MACHINE_GUID_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Cryptography';
const SYSTEM_INFO_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\SystemInformation';

// 异步执行单条命令，返回 Promise<string>
function execFileAsync(file, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', timeout, windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : stdout.trim());
    });
  });
}

// 异步采集所有硬件源（仅 1 个 PowerShell 进程）
async function collectSourcesAsync() {
  const out = await execFileAsync(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT]);
  if (!out) return { cpu: '', board: '', disk: '', guid: '' };
  let parsed = {};
  try {
    parsed = JSON.parse(out);
  } catch (e) {
    // JSON 解析失败，尝试正则提取
    const extract = (key) => {
      const m = out.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`, 'i'));
      return m ? m[1] : '';
    };
    parsed = { cpu: extract('cpu'), board: extract('board'), disk: extract('disk'), guid: extract('guid') };
  }
  return {
    cpu: normalize(parsed.cpu),
    board: normalize(parsed.board),
    disk: normalize(parsed.disk),
    guid: normalize(parsed.guid),
    disks: Array.isArray(parsed.disks) ? parsed.disks.slice(0, 32).map(normalize).filter(Boolean) : []
  };
}

function parseRegistryValue(output, valueName) {
  const pattern = new RegExp(`^\\s*${valueName}\\s+REG_\\w+\\s+(.+?)\\s*$`, 'i');
  const line = String(output || '').split(/\r?\n/).find(item => pattern.test(item));
  return normalize(line?.match(pattern)?.[1]);
}

async function readRegistryValue(key, valueName) {
  const output = await execFileAsync(REG_EXE, ['query', key, '/v', valueName, '/reg:64'], 3000);
  return parseRegistryValue(output, valueName);
}

async function collectRegistrySourcesAsync() {
  const [guid, hardwareId] = await Promise.all([
    readRegistryValue(MACHINE_GUID_KEY, 'MachineGuid'),
    readRegistryValue(SYSTEM_INFO_KEY, 'ComputerHardwareId')
  ]);
  return { cpu: '', board: hardwareId, disk: '', guid };
}

function mergeSources(primary, fallback) {
  return {
    cpu: primary.cpu || fallback.cpu,
    board: primary.board || fallback.board,
    disk: primary.disk || fallback.disk,
    guid: primary.guid || fallback.guid
  };
}

function countSources(sources) {
  return ['cpu', 'board', 'disk', 'guid'].filter(key => sources[key]).length;
}

// 异步生成机器码（合并 CIM 查询，并行读取稳定注册表来源）
async function getMachineIdAsync() {
  if (cachedMachineId) {
    return { success: true, machineId: cachedMachineId, sources: cachedSources };
  }
  // 避免并发重复采集
  if (pendingPromise) return pendingPromise;

  pendingPromise = (async () => {
    try {
      const [primary, registry] = await Promise.all([collectSourcesAsync(), collectRegistrySourcesAsync()]);
      let sources = Object.fromEntries(['cpu', 'board', 'disk', 'guid'].map(key => [key, primary[key] || '']));
      if (countSources(sources) < 2) {
        sources = mergeSources(sources, registry);
      }
      cachedEvidence = { primary, registry, disks: primary.disks || [] };
      cachedCandidates = candidateMachineIds(cachedEvidence);
      const remembered = getIdentityStore().read(cachedEvidence);
      if (remembered) {
        cachedMachineId = remembered;
        cachedSources = sources;
        pendingPromise = null;
        return { success: true, machineId: remembered, sources };
      }
      if (countSources(sources) >= 2) {
        cachedMachineId = hashMachineId(sources);
        cachedSources = sources;
        const result = { success: true, machineId: cachedMachineId, sources: cachedSources };
        pendingPromise = null;
        return result;
      }
      if (sources.guid) {
        cachedMachineId = hashMachineId(sources, 'registry-guid-v1');
        cachedSources = sources;
        const result = { success: true, machineId: cachedMachineId, sources: cachedSources, fallback: 'registry_guid' };
        pendingPromise = null;
        return result;
      }
      const result = {
        success: false,
        error: 'hardware_fingerprint_insufficient',
        message: tr("无法采集足够的硬件指纹（至少需要 2 个源）"),
        sources
      };
      pendingPromise = null;
      return result;
    } catch (e) {
      pendingPromise = null;
      return { success: false, error: 'collect_failed', message: e.message, sources: {} };
    }
  })();
  return pendingPromise;
}

// Called only after the license signature and expiry have been checked. A
// transient startup CIM failure gets one bounded, coalesced recovery attempt.
async function resolveMachineIdAsync(expectedId) {
  let result = await getMachineIdAsync();
  if (result.success && (result.machineId === expectedId || cachedCandidates.has(expectedId))) {
    return { ...result, machineId: expectedId };
  }
  if (Date.now() - lastRecoveryAttempt >= 30000) {
    lastRecoveryAttempt = Date.now();
    cachedMachineId = null;
    result = await getMachineIdAsync();
  } else if (pendingPromise) {
    result = await pendingPromise;
  }
  if (result.success && cachedCandidates.has(expectedId)) return { ...result, machineId: expectedId };
  return result;
}

function rememberMachineId(machineId) {
  if (!cachedEvidence || (cachedMachineId !== machineId && !cachedCandidates.has(machineId))) return false;
  cachedMachineId = machineId;
  return getIdentityStore().remember(machineId, cachedEvidence);
}

// 同步版本：仅返回缓存（无缓存时返回 null，不阻塞）
function getMachineIdSync() {
  if (cachedMachineId) {
    return { success: true, machineId: cachedMachineId, sources: cachedSources };
  }
  return { success: false, error: 'not_ready', message: tr("机器码采集中，请稍后") };
}

// 启动时预采集（在 app.whenReady 中调用）
function preloadMachineId() {
  return getMachineIdAsync();
}

module.exports = { getMachineIdAsync, getMachineIdSync, preloadMachineId, resolveMachineIdAsync, rememberMachineId };
