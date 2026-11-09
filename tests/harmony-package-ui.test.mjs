import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptsPackagePath, harmonyPackages, launchEntryValue, selectedLaunchEntry } from '../src/shared/packagePlatform.js';

test('package formats follow the selected transport, including previously saved Android records', () => {
  const harmony = { id: 'hdc:A' }, android = { id: 'A' };
  assert.equal(harmonyPackages(harmony), true);
  assert.equal(harmonyPackages(android), false);
  assert.equal(acceptsPackagePath(harmony, 'C:\\build\\app.apk'), false);
  assert.equal(acceptsPackagePath(android, 'C:\\build\\app.hap'), false);
  assert.equal(acceptsPackagePath(harmony, 'C:\\build\\app.HAP'), true);
  assert.equal(acceptsPackagePath(harmony, 'C:\\build\\shared.hsp'), true);
  assert.equal(acceptsPackagePath(android, 'C:\\build\\app.apk'), true);
});

test('UI can select only a native Ability; ambiguous data never silently chooses the first', () => {
  const first = { moduleName: 'one', abilityName: 'ActualPage' };
  const second = { moduleName: 'two', abilityName: 'OtherPage' };
  assert.equal(selectedLaunchEntry({ launchCandidates: [first, second] }, ''), null);
  assert.deepEqual(selectedLaunchEntry({ launchCandidates: [first] }, ''), first);
  assert.deepEqual(selectedLaunchEntry({ launchCandidates: [first, second] }, launchEntryValue(second)), second);
  assert.equal(selectedLaunchEntry({ launchCandidates: [] }, 'EntryAbility'), null);
});
