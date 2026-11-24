const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { parseAdbDeviceRows } = require('./adb-device-parser.cjs');

const run = promisify(execFile);
const portPattern = /^COM([1-9][0-9]{0,3})$/i;
const mtkInstance = /^USB\\VID_0E8D&PID_2000\\[A-Z0-9._&-]{1,160}$/i;
const adbSerial = /^[A-Za-z0-9_-]{1,128}$/;
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const normalizePort = value => typeof value === 'string' && portPattern.test(value) && Number(value.slice(3)) <= 4096 ? value.toUpperCase() : '';

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

function matchMtkPortHistory(snapshot, anchor) {
  const candidates = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  if (snapshot?.complete !== true || candidates.length > 128 || !Array.isArray(snapshot.activePorts) || !anchor?.location) return null;
  // Detached Windows PnP port reservations are hints tied to an exact physical USB path.
  // Never treat the COM number alone as a USB target and never arm an occupied COM.
  const anchored = candidates.filter(row => mtkInstance.test(row?.id || '') &&
    lower(row.location) === lower(anchor.location) && typeof row.service === 'string' &&
    /^(?:wdm_usb|usb2ser)$/i.test(row.service) && /^oem\d+\.inf$/i.test(row.inf || '') &&
    normalizePort(row.port));
  if (anchored.length !== 1) return null;
  const row = anchored[0];
  const port = normalizePort(row.port);
  if (candidates.some(candidate => normalizePort(candidate?.port) === port && lower(candidate.id) !== lower(row.id)) ||
    snapshot.activePorts.some(value => normalizePort(value) === port)) return null;
  return { instanceId: row.id, port, selector: port, location: anchor.location, label: anchor.label, stage: 'preloader', verified: true };
}

const historyScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Read-Port($id) {
  $key='HKLM:\SYSTEM\CurrentControlSet\Enum\'+$id+'\Device Parameters'
  if (Test-Path -LiteralPath $key) { (Get-ItemProperty -LiteralPath $key -ErrorAction Stop).PortName }
}
$mtk = @(Get-PnpDevice -Class Ports | Where-Object { $_.InstanceId -match '^USB\\VID_0E8D&PID_2000\\' })
if ($mtk.Count -gt 128) { @{complete=$false} | ConvertTo-Json -Compress; exit }
$nodes=@(foreach($d in $mtk){
  try {
    $props=Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_LocationPaths','DEVPKEY_Device_Service','DEVPKEY_Device_DriverInfPath'
    $map=@{}; foreach($p in $props){$map[$p.KeyName]=$p.Data}
    $usb=@($map['DEVPKEY_Device_LocationPaths'] | Where-Object { $_ -match '^PCI.*#USBROOT\(' })
    if($usb.Count -eq 1){ @{id=$d.InstanceId;location=$usb[0];port=(Read-Port $d.InstanceId);service=$map['DEVPKEY_Device_Service'];inf=$map['DEVPKEY_Device_DriverInfPath']} }
  } catch { throw }
})
$active=@(Get-PnpDevice -Class Ports -PresentOnly | ForEach-Object { Read-Port $_.InstanceId })
@{complete=$true;nodes=$nodes;activePorts=$active} | ConvertTo-Json -Depth 4 -Compress
`;

async function queryMtkPortHistory(anchor, { signal, exec = run } = {}) {
  if (process.platform !== 'win32' || signal?.aborted) return null;
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  try {
    const { stdout } = await exec(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(historyScript, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 18000, maxBuffer: 65536, encoding: 'utf8', signal });
    return matchMtkPortHistory(JSON.parse(stdout), anchor);
  } catch { return null; }
}

async function nativeFlashToolsIdle({ exec = run } = {}) {
  try {
    const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/tasklist.exe');
    const { stdout } = await exec(shell, ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000, maxBuffer: 262144 });
    return typeof stdout === 'string' && stdout.includes('","') && !/^"(?:RKDevTool|AndroidTool|upgrade_tool|SPFlashToolV6|flash_tool)\.exe"/im.test(stdout);
  } catch { return false; }
}

module.exports = { explicitTransport, selectQualifiedUsbAnchor, matchMtkPortHistory, queryMtkPortHistory, nativeFlashToolsIdle };
