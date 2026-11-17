import test from 'node:test';
import assert from 'node:assert/strict';
import { casebookPrefill } from '../src/shared/aiCasebookPrefill.js';
const fingerprint = 'a'.repeat(24), target = 'USB-DEVICE';
const capture = extra => ({ id: 'E1', source: 'adb', evidenceKind: 'adb:app_package', targetKey: fingerprint,
  diagnostic: { packageName: 'com.fixture.app', symptom: 'crash' }, text: '[L1] 目标应用：com.fixture.app\n[L2] versionName=1.2.3', capturedAt: '2026-11-17T00:00:00.000Z', ...extra });
const report = entries => ({ name: 'Stored report', preview: { question: 'Question', diagnostic: { packageName: 'com.fixture.app' }, deviceId: target, targetFingerprint: fingerprint, entries }, result: { summary: 'AI guessed root cause and versionName=99' } });
test('case form reuses report identity and only a unique trusted capture version, never model conclusions or verified status', () => {
  const value = casebookPrefill(report([capture()])); assert.equal(value.name, 'Stored report'); assert.equal(value.review.packageName, 'com.fixture.app'); assert.equal(value.review.version, '1.2.3');
  assert.equal(value.review.status, 'unverified'); for (const key of ['rootCause', 'solution', 'verification']) assert.equal(value.review[key], '');
  assert.equal(value.provenance.deviceId, target); assert.equal(value.provenance.versionSource, 'collected');
  const harmony = capture({ source: 'hdc', evidenceKind: 'hdc:app_package', platform: 'harmony', text: '[L1] {\n[L2] "bundleName":"com.fixture.app",\n[L3] "versionName":"3.0"\n[L4] }' });
  assert.equal(casebookPrefill(report([harmony])).review.version, '3.0');
});
test('untrusted, incomplete, conflicting and cross-target facts cannot prefill a version', () => {
  for (const patch of [{ source: 'text' }, { evidenceKind: 'log' }, { targetKey: 'b'.repeat(24) }, { unavailable: true }, { truncated: true }, { provenance: { trust: 'renderer-view' } }, { text: 'x'.repeat(262145) }]) assert.equal(casebookPrefill(report([capture(patch)])).review.version, '');
  const conflict = casebookPrefill(report([capture(), capture({ id: 'E2', text: '[L1] versionName=2.0' })])); assert.equal(conflict.review.version, ''); assert.equal(conflict.provenance.versionSource, 'conflict');
  const comparison = report([capture()]); comparison.preview.comparison = { comparable: false, afterIds: ['E1'] }; assert.equal(casebookPrefill(comparison).review.version, '');
  const unicodeOverLimit = capture({ text: `${'中'.repeat(100000)}\n[L2] versionName=1.2.3` });
  assert.equal(casebookPrefill(report([unicodeOverLimit])).review.version, '', '256 KiB applies to UTF-8 bytes, not only UTF-16 character units');
});
test('existing human review remains authoritative and is cloned rather than overwritten', () => {
  const original = report([capture()]); original.review = { status: 'verified', packageName: 'com.user.app', version: '', rootCause: 'User fact', solution: 'Action', verification: 'Checked', tags: ['tag'] };
  const value = casebookPrefill(original); assert.deepEqual(value.review, original.review); value.review.tags.push('new'); assert.equal(original.review.tags.length, 1);
});
