// electron/lib/machine-id.cjs
// 采集 Windows 硬件指纹（CPU + 主板 + 磁盘 + MachineGuid），输出 SHA-256 机器码
// 性能优化：正常路径将 4 个 PowerShell 查询合并为 1 次 JSON 输出（~2秒）

const { execFile } = require('child_process');
const crypto = require('crypto');
const path = require('path');

let cachedMachineId = null;
let cachedSources = null;
let pendingPromise = null;

// 单次 PowerShell 脚本：一次性采集全部 4 源，输出 JSON（用 ConvertTo-Json 避免转义问题）
const PS_SCRIPT = "$ErrorActionPreference='SilentlyContinue'; [ordered]@{cpu=(Get-CimInstance Win32_Processor).ProcessorId;board=(Get-CimInstance Win32_BaseBoard).SerialNumber;disk=(Get-CimInstance Win32_DiskDrive|Select-Object -First 1).SerialNumber;guid=(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid} | ConvertTo-Json -Compress";
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

// 规范化硬件字符串：去空白、转大写、过滤空值
function normalize(s) {
  if (!s) return '';
  const v = String(s).trim().toUpperCase();
  if (['', '0', 'NONE', 'NULL', 'TO BE FILLED BY O.E.M.', 'DEFAULT'].includes(v)) return '';
  return v;
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
    guid: normalize(parsed.guid)
  };
}

function parseRegistryValue(output, valueName) {
  const pattern = new RegExp(`^\\s*${valueName}\\s+REG_\\w+\\s+(.+?)\\s*$`, 'i');
  const line = String(output || '').split(/\r?\n/).find(item => pattern.test(item));
  return normalize(line?.match(pattern)?.[1]);
}

async function readRegistryValue(key, valueName) {
  const output = await execFileAsync(REG_EXE, ['query', key, '/v', valueName], 3000);
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
  return Object.values(sources).filter(Boolean).length;
}

function hashMachineId(sources, prefix = '') {
  const raw = ['cpu', 'board', 'disk', 'guid'].map(key => sources[key] || '').join('|');
  return crypto.createHash('sha256').update(prefix ? `${prefix}|${raw}` : raw).digest('hex');
}

// 异步生成机器码（采集 + 缓存，仅 1 个子进程）
async function getMachineIdAsync() {
  if (cachedMachineId) {
    return { success: true, machineId: cachedMachineId, sources: cachedSources };
  }
  // 避免并发重复采集
  if (pendingPromise) return pendingPromise;

  pendingPromise = (async () => {
    try {
      let sources = await collectSourcesAsync();
      if (countSources(sources) < 2) {
        sources = mergeSources(sources, await collectRegistrySourcesAsync());
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
        message: '无法采集足够的硬件指纹（至少需要 2 个源）',
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

// 同步版本：仅返回缓存（无缓存时返回 null，不阻塞）
function getMachineIdSync() {
  if (cachedMachineId) {
    return { success: true, machineId: cachedMachineId, sources: cachedSources };
  }
  return { success: false, error: 'not_ready', message: '机器码采集中，请稍后' };
}

// 启动时预采集（在 app.whenReady 中调用）
function preloadMachineId() {
  return getMachineIdAsync();
}

module.exports = { getMachineIdAsync, getMachineIdSync, preloadMachineId };
