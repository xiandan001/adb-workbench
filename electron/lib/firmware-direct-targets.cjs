const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { promisify } = require('node:util');

const runFile = promisify(execFile);
const maxRows = 96;
const portsClass = '{4d36e978-e325-11ce-bfc1-08002be10318}';
const rockusbClass = '{79dfc2a8-2574-493c-ae71-52958e41dd00}';
const adbCompatibleId = 'usb\\class_ff&subclass_42&prot_01';
const mtkStages = new Map([['0003', 'brom'], ['2000', 'preloader'], ['2001', 'da']]);
const adbServices = new Set(['winusb', 'androidusb']);
const mtkServices = new Set(['wdm_usb', 'usb2ser']);
const noCandidates = code => ({ ok: false, adb: [], rk: [], mtk: [], code });
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const fingerprint = identity => createHash('sha256').update(JSON.stringify(identity)).digest('hex');

function parseUsbInstance(instanceId) {
  if (typeof instanceId !== 'string' || instanceId.length > 256) return null;
  const decoded = /^USB\\VID_([A-F\d]{4})&PID_([A-F\d]{4})(?:&MI_([A-F\d]{2}))?\\([A-Z\d._&-]{1,160})$/i.exec(instanceId);
  return decoded && { instanceId, vid: lower(decoded[1]), pid: lower(decoded[2]), composite: Boolean(decoded[3]), suffix: decoded[4] };
}

function physicalLocations(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string' &&
    value.length <= 384 && /^[A-Z\d_.#()-]+$/i.test(value)).map(value =>
    value.toUpperCase().replace(/#USBMI\([A-F\d]{1,4}\)$/, '')).filter(value =>
    /^.+#USBROOT\([A-F\d]{1,4}\)(?:#USB\([A-F\d]{1,4}\))+$/u.test(value)))];
}

function uniqueSerial(instance, capabilities) {
  return Number.isInteger(capabilities) && (capabilities & 0x10) !== 0 &&
    /^[\w.-]{1,128}$/u.test(instance.suffix) ? instance.suffix : undefined;
}

function parentOf(device, row) {
  if (!device.composite) return null;
  const parent = parseUsbInstance(row.parentInstanceId);
  return parent && !parent.composite && parent.vid === device.vid && parent.pid === device.pid ? parent : null;
}

function roleOf(device, row) {
  if (row.problemCode !== 0) return null;
  const service = lower(row.service), guid = lower(row.classGuid);
  if (device.vid === '2207' && service === 'rockusb' && guid === rockusbClass) return 'rk';
  if (device.vid === '0e8d' && mtkStages.has(device.pid) && mtkServices.has(service) && guid === portsClass) return 'mtk';
  return adbServices.has(service) && Array.isArray(row.compatibleIds) &&
    row.compatibleIds.some(value => lower(value) === adbCompatibleId) ? 'adb' : null;
}

function unresolvedFlashNode(row) {
  if (row.problemCode !== 0 || typeof row.instanceId !== 'string') return false;
  return (/^USB\\VID_2207&PID_/i.test(row.instanceId) && lower(row.service) === 'rockusb') ||
    (/^USB\\VID_0E8D&PID_(0003|2000|2001)(?:&|\\)/i.test(row.instanceId) && mtkServices.has(lower(row.service)));
}

function normalizePort(port) {
  if (typeof port !== 'string') return null;
  const match = /^COM([1-9]\d{0,3})$/i.exec(port);
  return match && Number(match[1]) <= 4096 ? 'COM' + match[1] : null;
}

function describeTarget(role, device, row) {
  const parent = parentOf(device, row);
  const parentLocations = parent ? physicalLocations(row.parentLocations) : [];
  const locations = physicalLocations(row.locations);
  const location = (locations.length ? locations : parentLocations)[0];
  if (!location || locations.length > 1 || parentLocations.some(other => other !== location)) return null;
  const serial = device.composite
    ? (parentLocations.length === 1 ? uniqueSerial(parent, row.parentCapabilities) : undefined)
    : uniqueSerial(device, row.capabilities);
  if (role === 'adb' && !serial) return undefined;
  const instanceId = role === 'adb' && parent ? parent.instanceId : device.instanceId;
  const driverInf = lower(row.driverInf);
  const base = { location, instanceId, vid: device.vid, pid: device.pid,
    label: typeof row.label === 'string' ? row.label.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120) : '',
    ...(/^[a-z\d_.-]{1,80}\.inf$/.test(driverInf) ? { driverInf } : {}),
    ...(serial ? { serial } : {}) };
  if (role === 'mtk') {
    const port = normalizePort(row.port);
    if (!port) return null;
    base.port = port;
    base.stage = mtkStages.get(device.pid);
  }
  return { ...base, identity: fingerprint([role, location, lower(instanceId), serial?.toLowerCase(),
    lower(row.service), base.driverInf, base.stage, base.port]) };
}

function scanSnapshot(capture) {
  const rows = capture?.rows;
  if (capture?.complete !== true || !Array.isArray(rows) || rows.length > maxRows) return noCandidates('usb-inventory-incomplete');
  const groups = { adb: new Map(), rk: new Map(), mtk: new Map() };
  const portOwners = new Map();
  for (const row of rows) {
    if (row?.present === false || row?.problemCode !== 0 || lower(row.classGuid) !== portsClass) continue;
    const port = normalizePort(row.port);
    const owner = lower(row.instanceId);
    if (port && owner) {
      const reported = portOwners.get(port);
      portOwners.set(port, reported === undefined || reported === owner ? owner : null);
    }
  }
  for (const row of rows) {
    if (!row || typeof row !== 'object') return noCandidates('usb-inventory-incomplete');
    if (row.present === false) continue;
    const device = parseUsbInstance(row.instanceId);
    if (!device && unresolvedFlashNode(row)) return noCandidates('usb-inventory-incomplete');
    const role = device && roleOf(device, row);
    if (!role) continue;
    const target = describeTarget(role, device, row);
    if (target === undefined) continue; // An ADB alias lacking a USB serial cannot be a continuity anchor.
    if (!target) return noCandidates('usb-inventory-incomplete');
    const existing = groups[role].get(target.location);
    if (existing?.identity === target.identity) continue;
    if (existing || (role === 'mtk' && portOwners.get(target.port) !== lower(target.instanceId))) return noCandidates('usb-address-ambiguous');
    groups[role].set(target.location, target);
  }
  return { ok: true, adb: [...groups.adb.values()], rk: [...groups.rk.values()], mtk: [...groups.mtk.values()] };
}

const windowsProbe = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32;

public sealed class FirmwareUsbNode {
  public string instanceId, parentInstanceId, service, classGuid, label, port, driverInf;
  public string[] locations, parentLocations, compatibleIds;
  public uint? capabilities, parentCapabilities, problemCode;
}

public static class FirmwareUsbProbe {
  private const uint Success = 0;
  private const uint BufferSmall = 0x1a;
  private const uint NoValue = 0x25;
  private const uint Present = 0x100;
  private const uint Started = 0x8;
  private const uint UInt32Type = 7;
  private const uint GuidType = 13;
  private const uint StringType = 0x12;
  private const uint StringListType = 0x2012;

  private static readonly Guid Device = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
  private static readonly Guid Relations = new Guid("4340a6c5-93fa-4706-972c-7b648008a5a7");
  private static readonly Guid Driver = new Guid("a8b865dd-2e3d-4094-ad97-e593a70c75d6");
  private static readonly Guid Ports = new Guid("4d36e978-e325-11ce-bfc1-08002be10318");
  private static readonly Regex Usb = new Regex(@"^USB\\VID_[A-F0-9]{4}&PID_[A-F0-9]{4}", RegexOptions.IgnoreCase);
  private static readonly Regex Composite = new Regex(@"&MI_[A-F0-9]{2}\\", RegexOptions.IgnoreCase);

  [StructLayout(LayoutKind.Sequential)]
  private struct Key { public Guid group; public uint id; }

  [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
  private static extern uint CM_Get_Device_ID_List_Size(out uint length, string filter, uint flags);
  [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
  private static extern uint CM_Get_Device_ID_List(string filter, [Out] char[] buffer, uint length, uint flags);
  [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
  private static extern uint CM_Locate_DevNode(out uint node, string instance, uint flags);
  [DllImport("cfgmgr32.dll")]
  private static extern uint CM_Get_DevNode_Status(out uint status, out uint problem, uint node, uint flags);
  [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
  private static extern uint CM_Get_DevNode_Property(uint node, ref Key key, out uint type, [Out] byte[] buffer, ref uint bytes, uint flags);

  private static byte[] Property(uint node, Guid group, uint id, uint expectedType) {
    var key = new Key { group = group, id = id };
    uint type, count = 0;
    var result = CM_Get_DevNode_Property(node, ref key, out type, null, ref count, 0);
    if (result == NoValue) return null;
    if (result != BufferSmall || count < 1 || count > 8192 || type != expectedType) throw new InvalidOperationException("usb-property-unavailable");
    var buffer = new byte[count];
    if (CM_Get_DevNode_Property(node, ref key, out type, buffer, ref count, 0) != Success ||
        count != buffer.Length || type != expectedType) throw new InvalidOperationException("usb-property-changed");
    return buffer;
  }

  private static string Text(uint node, Guid group, uint id) {
    var bytes = Property(node, group, id, StringType);
    return bytes == null ? null : Encoding.Unicode.GetString(bytes).TrimEnd('\0');
  }
  private static string[] TextList(uint node, uint id) {
    var bytes = Property(node, Device, id, StringListType);
    return bytes == null ? new string[0] : Encoding.Unicode.GetString(bytes).Split(new[] { '\0' }, StringSplitOptions.RemoveEmptyEntries);
  }
  private static uint? Capabilities(uint node) {
    var bytes = Property(node, Device, 17, UInt32Type);
    return bytes == null ? null : (uint?)BitConverter.ToUInt32(bytes, 0);
  }

  private static string[] PresentIds() {
    uint capacity;
    if (CM_Get_Device_ID_List_Size(out capacity, null, Present) != Success || capacity < 1 || capacity > 65536)
      throw new InvalidOperationException("usb-list-unavailable");
    var buffer = new char[capacity];
    if (CM_Get_Device_ID_List(null, buffer, capacity, Present) != Success) throw new InvalidOperationException("usb-list-changed");
    var ids = new string(buffer).Split(new[] { '\0' }, StringSplitOptions.RemoveEmptyEntries);
    Array.Sort(ids, StringComparer.OrdinalIgnoreCase);
    return ids;
  }

  private static uint Locate(string id) {
    uint node;
    if (CM_Locate_DevNode(out node, id, 0) != Success) throw new InvalidOperationException("usb-device-changed");
    return node;
  }

  public static FirmwareUsbNode[] Capture() {
    var rows = new List<FirmwareUsbNode>();
    foreach (var id in PresentIds()) {
      uint node = Locate(id);
      var guidBytes = Property(node, Device, 10, GuidType);
      var guid = guidBytes == null ? Guid.Empty : new Guid(guidBytes);
      var isPorts = guid == Ports;
      var isUsb = Usb.IsMatch(id);
      if (!isPorts && !isUsb) continue;
      var service = (Text(node, Device, 6) ?? "").ToLowerInvariant();
      if (!isPorts && !id.StartsWith(@"USB\VID_2207&PID_", StringComparison.OrdinalIgnoreCase) &&
          !id.StartsWith(@"USB\VID_0E8D&PID_", StringComparison.OrdinalIgnoreCase) &&
          service != "winusb" && service != "androidusb") continue;
      if (rows.Count >= 96) throw new InvalidOperationException("usb-list-too-large");
      uint status, problem;
      if (CM_Get_DevNode_Status(out status, out problem, node, 0) != Success) throw new InvalidOperationException("usb-status-unavailable");
      var row = new FirmwareUsbNode {
        instanceId = id, classGuid = guid.ToString("B"), service = service,
        problemCode = problem == 0 && (status & Started) == 0 ? null : (uint?)problem,
        label = Text(node, Device, 14) ?? Text(node, Device, 2)
      };
      if (isUsb) {
        row.locations = TextList(node, 37);
        row.compatibleIds = TextList(node, 4);
        row.capabilities = Capabilities(node);
        row.driverInf = Text(node, Driver, 5);
        if (Composite.IsMatch(id)) {
          row.parentInstanceId = Text(node, Relations, 8);
          if (row.parentInstanceId != null && Usb.IsMatch(row.parentInstanceId)) {
            uint parent = Locate(row.parentInstanceId);
            row.parentLocations = TextList(parent, 37);
            row.parentCapabilities = Capabilities(parent);
          }
        }
      }
      if (isPorts && row.problemCode == 0) {
        using (var key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Enum\" + id + @"\Device Parameters", false)) {
          if (key != null) row.port = key.GetValue("PortName") as string;
        }
      }
      rows.Add(row);
    }
    return rows.ToArray();
  }
}
'@
$rows = [FirmwareUsbProbe]::Capture()
$same = (ConvertTo-Json -InputObject $rows -Depth 4 -Compress) -ceq (ConvertTo-Json -InputObject ([FirmwareUsbProbe]::Capture()) -Depth 4 -Compress)
[ordered]@{ complete = $same; rows = $rows } | ConvertTo-Json -Depth 4 -Compress
`;

async function captureWindowsUsb({ signal }) {
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const encoded = Buffer.from(windowsProbe, 'utf16le').toString('base64');
  const { stdout } = await runFile(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true, timeout: 8000, maxBuffer: 128 * 1024, encoding: 'utf8', signal
  });
  return JSON.parse(stdout.trim());
}

async function queryDirectUsb({ signal, hostPlatform = process.platform, capture = captureWindowsUsb } = {}) {
  if (hostPlatform !== 'win32') return noCandidates('usb-host-unsupported');
  if (signal?.aborted) return noCandidates('usb-probe-cancelled');
  try {
    const snapshot = await capture({ signal });
    return signal?.aborted ? noCandidates('usb-probe-cancelled') : scanSnapshot(snapshot);
  } catch {
    return noCandidates(signal?.aborted ? 'usb-probe-cancelled' : 'usb-probe-failed');
  }
}

function reconcileRkTargets(inventoryRows, cliDevices) {
  if (!Array.isArray(inventoryRows) || !Array.isArray(cliDevices) ||
    inventoryRows.length > maxRows || cliDevices.length > maxRows) return [];
  const locate = value => typeof value === 'string' && /^[a-f\d]{1,8}$/i.test(value)
    ? value.toLowerCase().replace(/^0+(?=[a-f\d])/i, '') : '';
  const windowsLocations = new Set(), cliLocations = new Set();
  const known = inventoryRows.every(row => {
    const device = parseUsbInstance(row?.instanceId);
    if (!device || device.vid !== '2207' || device.vid !== row.vid || device.pid !== row.pid ||
      typeof row.identity !== 'string' || !row.identity || !row.location || physicalLocations([row.location])[0] !== row.location ||
      windowsLocations.has(row.location)) return false;
    windowsLocations.add(row.location);
    return true;
  });
  if (!known || !cliDevices.every(row => {
    const locationId = locate(row?.locationId);
    if (!locationId || row.vid !== '2207' || !/^[a-f\d]{4}$/i.test(row.pid) ||
      !['loader', 'maskrom'].includes(row.mode) || cliLocations.has(locationId)) return false;
    cliLocations.add(locationId);
    return true;
  })) return [];

  // Only exact VID/PID singletons can pair without a certified vendor-to-PnP location mapping.
  return inventoryRows.flatMap(row => {
    if (inventoryRows.filter(other => other.pid === row.pid).length !== 1) return [];
    const matches = cliDevices.filter(other => lower(other.pid) === row.pid);
    if (matches.length !== 1) return [];
    const { mode, serial, locationId: rawLocation } = matches[0];
    const vendorSerial = typeof serial === 'string' && /^[\w.-]{1,128}$/u.test(serial) ? serial : undefined;
    if (row.serial && vendorSerial && lower(row.serial) !== lower(vendorSerial)) return [];
    const locationId = locate(rawLocation);
    return [{ ...row, mode, locationId, ...(vendorSerial ? { vendorSerial } : {}),
      identity: fingerprint([row.identity, mode, locationId]) }];
  });
}

module.exports = { queryDirectUsb, reconcileRkTargets };
