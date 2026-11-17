const PACKAGE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const encoder = new TextEncoder();
const version = value => typeof value === 'string' && /^[\p{L}\p{N}][\p{L}\p{N}._+() -]{0,79}$/u.test(value) ? value : '';
const emptyReview = () => ({ status: 'unverified', rootCause: '', solution: '', verification: '', packageName: '', version: '', tags: [] });
function capturedVersions(entry, packageName) {
  const text = entry.text.replace(/^\[L\d+\] ?/gm, '');
  if (entry.source === 'hdc') {
    try { const detail = JSON.parse(text); return detail.bundleName === packageName && version(detail.versionName) ? [detail.versionName] : []; }
    catch { return []; }
  }
  return [...text.matchAll(/^\s*versionName=([^\r\n]+)\s*$/gm)].map(match => version(match[1].trim())).filter(Boolean);
}
export function casebookPrefill(report) {
  const preview = report?.preview || {}, diagnostic = preview.diagnostic?.packageName || '';
  const result = { name: String(report?.name || preview.question || '').trim().slice(0, 80), review: emptyReview(),
    provenance: { packageSource: 'missing', versionSource: 'missing', deviceId: typeof preview.deviceId === 'string' ? preview.deviceId : '', capturedAt: '' } };
  if (report?.review) {
    result.review = { ...report.review, tags: [...(report.review.tags || [])] };
    result.provenance.packageSource = 'saved'; result.provenance.versionSource = 'saved'; return result;
  }
  if (!PACKAGE.test(diagnostic) || !/^[a-f\d]{24,64}$/.test(preview.targetFingerprint || '')
    || preview.comparison && preview.comparison.comparable !== true) return result;
  const entries = (preview.entries || []).slice(0, 32).filter(entry => ['adb', 'hdc'].includes(entry.source)
    && entry.evidenceKind === `${entry.source}:app_package` && entry.targetKey === preview.targetFingerprint
    && entry.diagnostic?.packageName === diagnostic && !entry.unavailable && !entry.truncated
    && entry.provenance?.trust !== 'renderer-view' && typeof entry.text === 'string' && entry.text.length <= 256 * 1024 && encoder.encode(entry.text).length <= 256 * 1024
    && (!preview.comparison || preview.comparison.afterIds?.includes(entry.id)));
  if (!entries.length) return result;
  result.review.packageName = diagnostic; result.provenance.packageSource = 'collected';
  const versions = [...new Set(entries.flatMap(entry => capturedVersions(entry, diagnostic)))];
  if (versions.length === 1) { result.review.version = versions[0]; result.provenance.versionSource = 'collected'; }
  else if (versions.length > 1) result.provenance.versionSource = 'conflict';
  result.provenance.capturedAt = entries[0].capturedAt || ''; return result;
}
