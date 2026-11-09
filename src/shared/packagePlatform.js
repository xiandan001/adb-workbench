export function harmonyPackages(device) {
  return device?.transport === 'hdc' || device?.platform === 'harmony' || String(device?.id || '').startsWith('hdc:');
}

export function acceptsPackagePath(device, value) {
  return typeof value === 'string' && (harmonyPackages(device) ? /\.(hap|hsp)$/i.test(value) : /\.apk$/i.test(value));
}

export function launchEntryValue(entry) {
  return JSON.stringify([entry.moduleName || '', entry.abilityName]);
}

export function selectedLaunchEntry(detail, value) {
  const entries = detail?.launchCandidates || [];
  return entries.find(entry => launchEntryValue(entry) === value) || (entries.length === 1 ? entries[0] : null);
}
