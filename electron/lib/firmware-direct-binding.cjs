const path = require('node:path');
const { createHash } = require('node:crypto');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const { parseAdbDeviceRows } = require('./adb-device-parser.cjs');
const { atomicWriteAsync } = require('./ai-workspace-store-async.cjs');

const run = promisify(execFile);
const portPattern = /^COM([1-9][0-9]{0,3})$/i;
const mtkInstance = /^USB\\VID_0E8D&PID_2000\\[A-Z0-9._&-]{1,160}$/i;
const adbSerial = /^[A-Za-z0-9_-]{1,128}$/;
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const normalizePort = value => typeof value === 'string' && portPattern.test(value) && Number(value.slice(3)) <= 4096 ? value.toUpperCase() : '';
const canonicalLocation = value => typeof value === 'string' && value.length <= 384 &&
  /^[A-Z0-9_.#()-]+#USBROOT\([A-F0-9]{1,4}\)(?:#USB\([A-F0-9]{1,4}\))+$/i.test(value) ? value.toUpperCase() : '';

function explicitTransport(list, serial) {
  if (!list?.ok || !adbSerial.test(serial)) return null;
  const rows = parseAdbDeviceRows(list.stdout).filter(row => row.id === serial);
  if (rows.length !== 1 || rows[0].status !== 'device') return null;
  const ids = [...rows[0].detail.matchAll(/(?:^|\s)transport_id:([1-9][0-9]{0,9})(?=\s|$)/g)];
  return ids.length === 1 ? { id: ids[0][1], detail: rows[0].detail } : null;
}

async function selectQualifiedUsbAnchor(inventory, profile, hint, runAdb) {
  if (!inventory?.ok || !Array.isArray(inventory.adb)) return null;
  const list = await runAdb(['devices', '-l'], { timeoutMs: 3500 });
  const possible = inventory.adb.flatMap(row => {
    if (!row.location || !profile.adbVids.includes(row.vid) || hint && row.serial !== hint) return [];
    const transport = explicitTransport(list, row.serial);
    const product = transport?.detail.split(/\s+/).find(token => token.startsWith('product:'))?.slice(8);
    return product === profile.product ? [{ ...row, transport: transport.id }] : [];
  });
  if (possible.length !== 1) return null;
  const anchor = possible[0];
  const response = await runAdb(['-t', anchor.transport, 'shell',
    'getprop ro.product.model; getprop ro.board.platform; getprop sys.boot_completed'], { timeoutMs: 3500 });
  const info = (response?.ok ? String(response.stdout) : '').trim().split(/\r?\n/);
  if (info[0].replace(/_/g, '-') !== profile.product.replace(/_/g, '-') ||
    lower(info[1]) !== profile.boardPlatform || info[2] !== '1') return null;
  return { ...anchor, label: profile.board, product: profile.product };
}

function listMtkPortReservationsFromSnapshot(snapshot) {
  if (snapshot?.complete !== true || !Array.isArray(snapshot.nodes) || snapshot.nodes.length > 128 ||
    !Array.isArray(snapshot.activePorts) || snapshot.activePorts.length > 4096) return [];
  // Detached Windows PnP port reservations are hints tied to an exact physical USB path.
  // Never treat the COM number alone as a USB target and never arm an occupied COM.
  const busy = new Set(snapshot.activePorts.map(normalizePort));
  const rows = snapshot.nodes.map(row => ({
    instanceId: typeof row?.id === 'string' ? row.id.toUpperCase() : '',
    location: canonicalLocation(row?.location), port: normalizePort(row?.port),
    service: lower(row?.service), inf: lower(row?.inf),
  }));
  return rows.flatMap(row => {
    const { instanceId, location, port, service, inf } = row;
    if (!mtkInstance.test(instanceId) || !location || !port || busy.has(port) ||
      !['wdm_usb', 'usb2ser'].includes(service) || !/^oem\d+\.inf$/.test(inf)) return [];
    if (rows.some(other => other !== row && (other.port === port || other.location === location || other.instanceId === instanceId))) return [];
    const id = createHash('sha256').update(JSON.stringify([instanceId, location, port, service, inf])).digest('hex');
    return [{ id, instanceId, port, location, selector: port, stage: 'preloader', verified: true }];
  }).sort((left, right) => Number(left.port.slice(3)) - Number(right.port.slice(3)));
}

function matchMtkPortHistory(snapshot, anchor) {
  const found = listMtkPortReservationsFromSnapshot(snapshot).find(row => row.location === canonicalLocation(anchor?.location));
  if (!found) return null;
  const { instanceId, port, selector, stage, verified } = found;
  return { instanceId, port, selector, location: anchor.location, label: anchor.label, stage, verified };
}

const historyScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Read-Port($id) {
  $key='HKLM:\SYSTEM\CurrentControlSet\Enum\'+$id+'\Device Parameters'
  if (Test-Path -LiteralPath $key) { (Get-ItemProperty -LiteralPath $key -ErrorAction Stop).PortName }
}
$ports = @(Get-PnpDevice -Class Ports)
$mtk = @($ports | Where-Object { $_.InstanceId -match '^USB\\VID_0E8D&PID_2000\\' })
if ($mtk.Count -gt 128 -or @($ports | Where-Object { $null -eq $_.Present }).Count) { @{complete=$false} | ConvertTo-Json -Compress; exit }
$nodes=@(foreach($d in $mtk){
  try {
    $props=Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_LocationPaths','DEVPKEY_Device_Service','DEVPKEY_Device_DriverInfPath'
    $map=@{}; foreach($p in $props){$map[$p.KeyName]=$p.Data}
    $usb=@($map['DEVPKEY_Device_LocationPaths'] | Where-Object { $_ -match '^PCI.*#USBROOT\(' })
    $location=$null
    if($usb.Count -eq 1){ $location=$usb[0] }
    @{id=$d.InstanceId;location=$location;port=(Read-Port $d.InstanceId);service=$map['DEVPKEY_Device_Service'];inf=$map['DEVPKEY_Device_DriverInfPath']}
  } catch { throw }
})
$active=@($ports | Where-Object { $_.Present -eq $true } | ForEach-Object { Read-Port $_.InstanceId })
@{complete=$true;nodes=$nodes;activePorts=$active} | ConvertTo-Json -Depth 4 -Compress
`;

async function readMtkPortHistory({ signal, exec = run } = {}) {
  if (process.platform !== 'win32' || signal?.aborted) return null;
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  try {
    const { stdout } = await exec(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(historyScript, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 18000, maxBuffer: 65536, encoding: 'utf8', signal });
    return signal?.aborted ? null : JSON.parse(stdout);
  } catch { return null; }
}

async function listMtkPortReservations(options) {
  return listMtkPortReservationsFromSnapshot(await readMtkPortHistory(options));
}

async function queryMtkPortHistory(anchor, options) {
  return matchMtkPortHistory(await readMtkPortHistory(options), anchor);
}

async function nativeFlashToolsIdle({ exec = run } = {}) {
  try {
    const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/tasklist.exe');
    const { stdout } = await exec(shell, ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000, maxBuffer: 262144 });
    return typeof stdout === 'string' && stdout.includes('","') && !/^"(?:RKDevTool|AndroidTool|upgrade_tool|SPFlashToolV6|flash_tool)\.exe"/im.test(stdout);
  } catch { return false; }
}

function sanitizeRkBinding(value) {
  if (!value || typeof value.product !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.product) ||
    typeof value.location !== 'string' || !/^[A-Za-z0-9_#().-]{5,512}$/.test(value.location) ||
    !value.location.includes('#USB(') || typeof value.serial !== 'string' || !adbSerial.test(value.serial) ||
    typeof value.identity !== 'string' || !/^[a-f0-9]{64}$/.test(value.identity)) return null;
  const { product, location, serial, identity } = value;
  return { product, location, serial, identity };
}

function sanitizeMtkBinding(value) {
  const common = sanitizeRkBinding(value);
  if (!common || typeof value.instanceId !== 'string' || !mtkInstance.test(value.instanceId) || !normalizePort(value.port)) return null;
  return { ...common, instanceId: value.instanceId, port: normalizePort(value.port) };
}

function createBindingStore(filename, sanitize, { io = fs, atomicWrite = atomicWriteAsync } = {}) {
  let loaded;
  const read = () => loaded ||= (async () => {
    try {
      const meta = await io.lstat(filename);
      if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 2048) return null;
      const raw = await io.readFile(filename);
      if (raw.length > 2048) return null;
      const value = JSON.parse(raw.toString('utf8'));
      return value?.version === 1 ? sanitize(value.target) : null;
    } catch { return null; }
  })();
  async function remember(value) {
    const target = sanitize(value);
    if (!target) return false;
    await io.mkdir(path.dirname(filename), { recursive: true });
    await atomicWrite(filename, JSON.stringify({ version: 1, target }));
    loaded = Promise.resolve(target);
    return true;
  }
  return { read, remember };
}

const createMtkBindingStore = (filename, options) => createBindingStore(filename, sanitizeMtkBinding, options);
const createRkBindingStore = (filename, options) => createBindingStore(filename, sanitizeRkBinding, options);

module.exports = {
  explicitTransport, selectQualifiedUsbAnchor, matchMtkPortHistory, queryMtkPortHistory,
  listMtkPortReservationsFromSnapshot, listMtkPortReservations, nativeFlashToolsIdle,
  sanitizeMtkBinding, createMtkBindingStore, sanitizeRkBinding, createRkBindingStore };
