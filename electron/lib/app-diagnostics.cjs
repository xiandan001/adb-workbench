const { tr } = require('./localization.cjs');
const nodeOs = require('node:os');
const { execFile: nativeExecFile } = require('node:child_process');

const CIM_SCRIPT = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
$computer = Get-CimInstance -ClassName Win32_ComputerSystem -Property Manufacturer,Model,TotalPhysicalMemory
$system = Get-CimInstance -ClassName Win32_OperatingSystem -Property Caption,Version,BuildNumber
$processors = @(Get-CimInstance -ClassName Win32_Processor -Property Name,NumberOfLogicalProcessors)
[pscustomobject]@{manufacturer=$computer.Manufacturer;model=$computer.Model;memoryBytes=$computer.TotalPhysicalMemory;cpu=$processors[0].Name;logicalCores=($processors | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum;osName=$system.Caption;osVersion=$system.Version;osBuild=$system.BuildNumber} | ConvertTo-Json -Compress`;

function safeText(value, limit = 160) {
  if (typeof value !== 'string' || value.length > limit) return null;
  const text = value.trim();
  if (!text || !/^[\p{L}\p{N} ._()+,@:-]+$/u.test(text)
    || /password|passwd|secret|api.?key|token|authorization|bearer|cookie|private.?key|gh[pousr]_|sk-/i.test(text)) return null;
  return text;
}
const number = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max ? value : null;
const safely = operation => { try { return operation(); } catch { return undefined; } };
const versionText = value => typeof value === 'string' && /^[0-9][0-9A-Za-z.+_-]{0,63}$/.test(value) ? value : null;

function createAppDiagnostics({ app, screen, os = nodeOs, execFile = nativeExecFile, platform = os.platform(),
  versions = process.versions, now = () => new Date(), uptime = () => process.uptime() } = {}) {
  let pending;
  function cim() {
    if (platform !== 'win32') return Promise.resolve(null);
    return new Promise(resolve => {
      let settled = false; let child;
      const done = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => { done(null); try { child?.kill(); } catch { /* Metadata failure cannot block reporting. */ } }, 2500);
      try {
        child = execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', CIM_SCRIPT],
          { windowsHide: true, timeout: 2500, maxBuffer: 16384, encoding: 'utf8' }, (error, stdout) => {
            if (error || typeof stdout !== 'string' || Buffer.byteLength(stdout) > 16384) { done(null); return; }
            try { const value = JSON.parse(stdout.replace(/^\uFEFF/, '')); done(value && typeof value === 'object' && !Array.isArray(value) ? value : null); }
            catch { done(null); }
          });
      } catch { done(null); }
    });
  }
  async function perform() {
    const cpus = safely(() => os.cpus());
    const cpuList = Array.isArray(cpus) ? cpus : [];
    const locale = safely(() => app.getLocale());
    const arch = safely(() => os.arch());
    const seconds = safely(uptime);
    const result = { collectedAt: now().toISOString(),
      app: { name: tr("卓控台"), version: versionText(safely(() => app.getVersion())), electron: versionText(versions.electron),
        chrome: versionText(versions.chrome), node: versionText(versions.node), packaged: app?.isPackaged === true,
        uptimeSeconds: Number.isFinite(seconds) && seconds >= 0 ? Math.min(Math.floor(seconds), 315360000) : null },
      os: { platform: ['win32', 'darwin', 'linux', 'freebsd', 'openbsd', 'aix', 'sunos'].includes(platform) ? platform : null,
        name: safeText(safely(() => os.version())) || safeText(safely(() => os.type())), version: versionText(safely(() => os.release())), build: null,
        architecture: ['x64', 'arm64', 'ia32', 'arm', 'ppc64', 's390x', 'riscv64'].includes(arch) ? arch : null,
        locale: typeof locale === 'string' && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(locale) ? locale : null },
      computer: { manufacturer: null, model: null, cpu: safeText(cpuList[0]?.model), logicalCores: number(cpuList.length, 4096),
        memoryBytes: number(safely(() => os.totalmem()), 1024 ** 5) }, displays: [], unavailable: [] };
    const displays = safely(() => screen.getAllDisplays());
    if (Array.isArray(displays)) for (const display of displays.slice(0, 16)) {
      const width = number(display.bounds?.width, 100000); const height = number(display.bounds?.height, 100000);
      const scaleFactor = display.scaleFactor;
      if (width && height && Number.isFinite(scaleFactor) && scaleFactor > 0 && scaleFactor <= 16) result.displays.push({ width, height, scaleFactor });
    }
    const native = await cim();
    if (native) {
      for (const key of ['manufacturer', 'model', 'cpu']) result.computer[key] = safeText(native[key]) || result.computer[key];
      result.computer.logicalCores = number(native.logicalCores, 4096) || result.computer.logicalCores;
      result.computer.memoryBytes = number(native.memoryBytes, 1024 ** 5) || result.computer.memoryBytes;
      result.os.name = safeText(native.osName) || result.os.name;
      result.os.version = versionText(native.osVersion) || result.os.version;
      result.os.build = typeof native.osBuild === 'string' && /^\d{1,12}$/.test(native.osBuild) ? native.osBuild : null;
    }
    for (const group of ['app', 'os', 'computer']) for (const [key, value] of Object.entries(result[group])) if (value === null) result.unavailable.push(`${group}.${key}`);
    if (!result.displays.length) result.unavailable.push('displays');
    return result;
  }
  return { collect() { if (!pending) pending = perform().finally(() => { pending = undefined; }); return pending.then(value => structuredClone(value)); } };
}

module.exports = { createAppDiagnostics };
