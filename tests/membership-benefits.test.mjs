import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import limits from '../electron/lib/membership-limits.json' with { type: 'json' };
import { getMembershipBenefitGroups, readMembershipComparison, saveMembershipComparison } from '../src/shared/membershipBenefits.js';

const byId = (groups, id) => groups.flatMap(group => group.items).find(item => item.id === id);

test('comparison shows member-only operations and keeps free operations in the full view', () => {
  const differences = getMembershipBenefitGroups(false);
  const all = getMembershipBenefitGroups(true);
  assert.equal(byId(differences, 'regression'), undefined);
  assert.equal(byId(all, 'regression').free, true);
  assert.equal(byId(all, 'local-diagnosis').free, true);
  assert.equal(byId(differences, 'inspection').free, false);
  assert.equal(byId(differences, 'ai-analysis').free, false);
  assert.equal(byId(differences, 'inspection').vip, true);
});

test('connection history wording follows the free display and on-disk retention limits', () => {
  const history = byId(getMembershipBenefitGroups(false), 'connection-history');
  assert.match(history.free, new RegExp(`\\b${limits.freeConnectionHistoryLimit}\\b`));
  assert.match(history.vip, new RegExp(`\\b${limits.storedConnectionHistoryLimit}\\b`));
  const storageModule = readFileSync(new URL('../electron/lib/history.cjs', import.meta.url), 'utf8');
  assert.match(storageModule, /\{ storedConnectionHistoryLimit: MAX_HISTORY_SIZE \} = require\('\.\/membership-limits\.json'\)/);
});

test('the comparison defaults to differences and persists only the chosen view', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  assert.equal(readMembershipComparison(storage), false);
  saveMembershipComparison(true, storage);
  assert.equal(readMembershipComparison(storage), true);
  assert.deepEqual([...data.values()], ['all']);
  saveMembershipComparison(false, storage);
  assert.equal(readMembershipComparison(storage), false);
  assert.deepEqual([...data.values()], ['differences']);
  assert.equal(readMembershipComparison({ getItem() { throw new Error('blocked'); } }), false);
});
