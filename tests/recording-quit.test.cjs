const test = require('node:test');
const assert = require('node:assert/strict');
const { confirmRecordingQuit } = require('../electron/lib/recording-quit.cjs');

test('no recording needs no confirmation, and cancel never stops or saves a session', async () => {
  const recordings = { listUnresolved: () => [], stopAllRecordings: () => assert.fail('unexpected stop') };
  assert.equal(await confirmRecordingQuit({ recordings, ask: () => assert.fail('unexpected prompt') }), true);
  recordings.listUnresolved = () => [{ id: 'one' }];
  assert.equal(await confirmRecordingQuit({ recordings, ask: async () => ({ response: 1 }) }), false);
});

test('quit waits for save and failed save requires explicit recovery-preserving exit choice', async () => {
  let pending = [{ id: 'one' }];
  const recordings = { listUnresolved: () => pending, stopAllRecordings: async () => { pending = []; } };
  assert.equal(await confirmRecordingQuit({ recordings, ask: async () => ({ response: 0 }) }), true);
  pending = [{ id: 'one' }]; recordings.stopAllRecordings = async () => ({ success: false });
  let prompts = 0;
  assert.equal(await confirmRecordingQuit({ recordings, ask: async () => ({ response: prompts++ ? 0 : 0 }) }), false);
  prompts = 0;
  assert.equal(await confirmRecordingQuit({ recordings, ask: async () => ({ response: prompts++ ? 1 : 0 }) }), true);
});
