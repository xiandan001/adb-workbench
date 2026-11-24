const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { queryWindowsDrivers, installWindowsDriver, launchWindowsTool } = require('./firmware-tools-windows.cjs');
const vendorFiles = require('./firmware-tools-vendor.json');

const profiles = {
  rk: {
    folder: 'RK',
    installerName: 'Rockusb 5.13',
    installerDirectory: 'DriverAssitant_v5.13/Driver/x64/win10',
    installFiles: {
      'rockusb.inf': '4fc1ea1a32e235f03805b0955dc06203be15738d0672d9679a9539ccc23e8887',
      'rockusb.cat': 'f9098e5a0067b5d01cb6f5be87f42a196503aee7e2d1fc41d573c80fd5c9f10f',
      'rockusb.sys': 'dbe50ec840008e3db5f4acd6063f622438f3bbb049e4db84e1721ea0425fcac1',
    },
    toolName: 'RKDevTool 3.28',
    toolFile: 'RKDevTool_v3.28_for_window/RKDevTool.exe',
  },
  mtk: {
    folder: 'MTK',
    installerName: 'MediaTek SP Driver',
    installerDirectory: 'Driver_Auto_Installer_SP_Drivers_20230214',
    installFiles: { 'DriverInstall.exe': '3cf1997d5a33411e2385e1e492689adc88b87255845a99e9c12965361602df98' },
    toolName: 'SP Flash Tool V6',
    toolFile: 'SP_Flash_Tool_V6/SPFlashToolV6.exe',
  },
};

const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const comparablePath = value => process.platform === 'win32' ? value.toLowerCase() : value;
const samePath = (a, b) => comparablePath(a) === comparablePath(b);
const knownProfile = platform => Object.hasOwn(profiles, platform) ? profiles[platform] : null;
const failure = code => ({ ok: false, code });

function matchesPackage(platform, entry) {
  if (!entry?.signer || !/^oem\d+\.inf$/i.test(entry.published)) return false;
  const inf = lower(entry.inf);
  const provider = lower(entry.provider);
  return platform === 'rk' ? inf === 'rockusb.inf' && provider.includes('rockchip')
    : /^(cdc-acm|mtk_sp_usb2ser|mtk_usb[a-z0-9_]*|usbvcom[a-z0-9_]*)\.inf$/.test(inf) && provider.includes('mediatek');
}

function matchesDevice(platform, hardwareId, service) {
  if (platform === 'mtk') return /^VID_0E8D&PID_(0003|2000|2001)$/i.test(hardwareId || '');
  const pid = /^VID_2207&PID_([0-9A-F]{4})$/i.exec(hardwareId || '')?.[1].toUpperCase();
  return Boolean(pid && (lower(service) === 'rockusb'
    || /^(06|08|09|11|12|16|18|19|21|22|31|32|33|35|36|37|38|39)0[A-F]$/.test(pid)
    || /^(261A|262C|262D|273A|281A|282B|290A|292A|292C|300A|300B|301A)$/.test(pid)));
}

function describeDriver(platform, inventory) {
  if (!Array.isArray(inventory?.devices) || !Array.isArray(inventory?.packages)) {
    return { state: 'unknown', driverPackage: null, devices: [], errorCode: 'probe-failed' };
  }
  const packages = inventory.packages.filter(entry => matchesPackage(platform, entry));
  const driverPackage = packages[0] ? { inf: packages[0].inf, provider: packages[0].provider } : null;
  const devices = inventory.devices.filter(entry => matchesDevice(platform, entry.hardwareId, entry.service)).map(entry => {
    const problemCode = Number.isInteger(entry.problemCode) && entry.problemCode >= 0 ? entry.problemCode : null;
    const driverInf = typeof entry.driverInf === 'string' ? entry.driverInf.slice(0, 60) : '';
    const matched = packages.some(candidate => lower(candidate.published) === lower(driverInf));
    return {
      name: typeof entry.name === 'string' ? entry.name.slice(0, 140) : '',
      hardwareId: entry.hardwareId,
      problemCode, driverInf, bound: matched && problemCode === 0,
    };
  });
  const state = devices.length ? (devices.every(device => device.bound) ? 'bound' : 'problem')
    : driverPackage ? 'installed' : 'missing';
  return { state, driverPackage, devices };
}

async function inspectFile(folder, relative, sha256, io) {
  const filename = path.join(folder, relative);
  try {
    const canonical = await io.realpath(filename);
    if (!samePath(canonical, filename)) return { code: 'untrusted-package' };
    const file = await io.open(filename, 'r');
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size <= 0 || before.size > 64 * 1024 * 1024) return { code: 'untrusted-package' };
      const hash = createHash('sha256');
      for await (const block of file.createReadStream({ autoClose: false })) hash.update(block);
      const after = await file.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || hash.digest('hex') !== sha256) {
        return { code: 'untrusted-package' };
      }
      return { path: filename, sha256 };
    } finally { await file.close(); }
  } catch (error) {
    return { code: ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing-file' : 'untrusted-package' };
  }
}

async function localFolder(root, profile, io) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) return null;
  try {
    const canonical = await io.realpath(root);
    if (process.platform === 'win32' && !/^[a-z]:\\/i.test(canonical)) return null;
    if (lower(path.basename(canonical)) === lower(profile.folder)) return canonical;
    const candidate = path.join(canonical, profile.folder);
    return samePath(await io.realpath(candidate), candidate) ? candidate : null;
  } catch { return null; }
}

async function inspectVendorFiles(folder, entryPoint, files, io) {
  const checks = await Promise.all(Object.entries(files).map(([name, hash]) => inspectFile(folder, name, hash, io)));
  if (checks.some(file => file.code === 'untrusted-package')) return { code: 'untrusted-package' };
  if (checks.some(file => !file.path)) return { code: 'missing-file' };

  const filenames = new Set(Object.keys(files).map(name => lower(path.normalize(name))));
  const directories = new Set([...filenames].map(name => path.dirname(name)));
  if ([...directories].some(directory => directory.startsWith('plugins' + path.sep))) directories.add('plugins');
  try {
    for (const directory of directories) {
      const entries = await io.readdir(path.join(folder, directory), { withFileTypes: true });
      for (const entry of entries) {
        const relative = lower(path.join(directory, entry.name));
        if (directory === 'plugins' && (entry.isDirectory() || entry.isSymbolicLink()) && !directories.has(relative)) {
          return { code: 'untrusted-package' };
        }
        if (relative === 'qt.conf') return { code: 'untrusted-package' };
        if (/\.(exe|dll|sys|com|ocx|cpl|pyd|scr)$/i.test(entry.name) && !filenames.has(relative)) {
          return { code: 'untrusted-package' };
        }
      }
    }
    return { path: path.join(folder, entryPoint) };
  } catch { return { code: 'untrusted-package' }; }
}

async function inspectTools(platform, root, io) {
  const profile = knownProfile(platform);
  const folder = profile && await localFolder(root, profile, io);
  const [files, tool] = folder ? await Promise.all([
    Promise.all(Object.entries(profile.installFiles).map(([name, hash]) =>
      inspectFile(folder, path.join(profile.installerDirectory, name), hash, io))),
    inspectVendorFiles(path.join(folder, path.dirname(profile.toolFile)), path.basename(profile.toolFile), vendorFiles[platform], io),
  ]) : [[], null];
  const installer = {
    available: files.length > 0 && files.every(file => file.path),
    needsConfirmation: platform === 'mtk',
    name: profile?.installerName || '',
  };
  const toolView = { available: Boolean(tool?.path), name: profile?.toolName || '' };
  if (!installer.available) installer.code = files.some(file => file.code === 'untrusted-package') ? 'untrusted-package' : 'installer-unavailable';
  if (!toolView.available) toolView.code = tool?.code === 'untrusted-package' ? 'untrusted-package' : 'tool-unavailable';
  return { installer, tool: toolView, paths: { files, tool: tool?.path } };
}

async function withStagedInstaller(files, action, io, tempDirectory) {
  const staging = await io.mkdtemp(path.join(tempDirectory, 'veylo-driver-'));
  const staged = files.map(file => ({ ...file, path: path.join(staging, path.basename(file.path)) }));
  try {
    for (let index = 0; index < files.length; index++) await io.copyFile(files[index].path, staged[index].path);
    return await action(staged);
  } catch { return failure('install-failed'); }
  finally {
    await Promise.all(staged.map(file => io.unlink(file.path).catch(() => {})));
    await io.rmdir(staging).catch(() => {});
  }
}

function createFirmwareTools({ platform: host = process.platform, arch = process.arch, io = fs,
  query = queryWindowsDrivers, elevate = installWindowsDriver, launch = launchWindowsTool, inspect = inspectTools,
  tempDirectory = os.tmpdir() } = {}) {
  let pendingQuery, installing = false;
  const supported = platform => host === 'win32' && arch === 'x64' && Boolean(knownProfile(platform));
  const inventory = () => {
    if (!pendingQuery) pendingQuery = Promise.resolve().then(query).catch(() => null).finally(() => { pendingQuery = null; });
    return pendingQuery;
  };

  async function status(platform, root) {
    if (!supported(platform)) return { ...describeDriver(platform, null), errorCode: 'unsupported-platform',
      installer: { available: false, needsConfirmation: false }, tool: { available: false } };
    const [snapshot, { installer, tool }] = await Promise.all([inventory(), inspect(platform, root, io)]);
    return { ...describeDriver(platform, snapshot), installer, tool };
  }

  async function install(platform, root, { confirmed = false } = {}) {
    if (!supported(platform)) return failure('unsupported-platform');
    if (installing) return failure('busy');
    installing = true;
    try {
      const { installer, paths } = await inspect(platform, root, io);
      if (!installer.available) return failure(installer.code);
      if (installer.needsConfirmation && confirmed !== true) return failure('confirmation-required');
      const result = await withStagedInstaller(paths.files, staged => elevate(platform, staged), io, tempDirectory);
      const current = await status(platform, root);
      if (result.code === 'uac-cancelled') return { ...failure(result.code), cancelled: true, status: current };
      const available = current.driverPackage || current.state === 'bound';
      if (result.ok && !available && result.code !== 'restart-required') {
        return { ...failure('install-not-detected'), status: current, exitCode: result.exitCode };
      }
      return { ...result, status: current };
    } catch { return failure('install-failed'); }
    finally { installing = false; }
  }

  async function open(platform, root) {
    if (!supported(platform)) return failure('unsupported-platform');
    const { tool, paths } = await inspect(platform, root, io);
    if (!tool.available) return failure(tool.code);
    try { await launch(paths.tool); return { ok: true }; }
    catch { return failure('tool-launch-failed'); }
  }

  return { status, install, open };
}

module.exports = { createFirmwareTools, describeDriver, inspectFile, inspectVendorFiles };
