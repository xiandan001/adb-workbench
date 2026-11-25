import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsCategories, settingsCategoryForSection, nextSettingsCategory } from '../src/shared/settingsNavigation.js';
import { filterSearchItems, searchDestinations } from '../src/shared/workbenchSearch.js';

test('settings routes put former controls under Software and keep separate Legal and Version tabs', () => {
  assert.deepEqual(settingsCategories().map(item => item.id), ['software', 'legal', 'version']);
  assert.equal(settingsCategoryForSection('settings-paths'), 'software');
  assert.equal(settingsCategoryForSection('settings-support'), 'software');
  assert.equal(settingsCategoryForSection('settings-legal'), 'legal');
  assert.equal(settingsCategoryForSection('settings-update'), 'version');
  assert.equal(settingsCategoryForSection('__proto__'), null);
});

test('keyboard navigation wraps and supports Home/End without taking over unrelated keys', () => {
  assert.equal(nextSettingsCategory('software', 'ArrowLeft'), 'version');
  assert.equal(nextSettingsCategory('version', 'ArrowRight'), 'software');
  assert.equal(nextSettingsCategory('version', 'Home'), 'software');
  assert.equal(nextSettingsCategory('software', 'End'), 'version');
  assert.equal(nextSettingsCategory('software', 'Tab'), null);
});

test('search leads to category anchors, preserving existing path-field destinations', () => {
  const results = searchDestinations();
  const first = query => filterSearchItems(results, query)[0].destination;
  assert.deepEqual(first('截图路径'), { kind: 'settings', id: 'settings-paths', field: 'screenshotPath' });
  assert.deepEqual(first('更新日志'), { kind: 'settings', id: 'settings-update' });
  assert.deepEqual(first('法律'), { kind: 'settings', id: 'settings-legal' });
  assert.deepEqual(first('问题反馈'), { kind: 'settings', id: 'settings-support' });
  assert.ok(results.filter(entry => entry.destination.kind === 'settings').every(entry => settingsCategoryForSection(entry.destination.id)));
});
