import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaRecorderController } from '../electron/harmony-media-recorder.js';

const id = '11111111-1111-4111-8111-111111111111', streamId = '22222222-2222-4222-8222-222222222222';
const flush = async () => { for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(overrides = {}) {
  const calls = [], instances = []; let stoppedTracks = 0;
  class Recorder {
    static isTypeSupported(type) { return type === 'video/webm;codecs=vp8'; }
    constructor(stream, options) { this.stream = stream; this.options = options; this.state = 'inactive'; instances.push(this); }
    start() { this.state = 'recording'; queueMicrotask(() => this.onstart()); }
    stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable({ data: new Blob(['final']) }); this.onstop(); }); }
    data(value) { this.ondataavailable({ data: new Blob([value]) }); }
  }
  const api = {
    recordChunk: async args => { calls.push(['chunk', args]); return { success: true }; },
    recordEnd: async args => { calls.push(['end', args]); return { success: true }; },
    recordResponse: async args => { calls.push(['response', args]); return { success: true }; },
    recordStop: async () => { calls.push(['request-stop']); return { success: true }; }, ...overrides
  };
  const controller = createMediaRecorderController({ api, Recorder,
    canvas: { captureStream(fps) { assert.equal(fps, 20); return { getTracks: () => [{ stop() { stoppedTracks++; } }] }; } },
    getSession: () => ({ id: streamId, fps: 20, decoded: true }), getLabels: () => ({ recordFailed: 'recording-not-saved' }),
    onError: text => calls.push(['error', text]) });
  const command = action => controller.command({ commandId: action + '-command', action, id, streamId });
  return { controller, calls, instances, command, stoppedTracks: () => stoppedTracks };
}

test('recording appends ordered bounded WebM chunks and waits for all writes before final stop acknowledgement', async () => {
  let release;
  const chunks = [];
  const h = fixture({ recordChunk: args => { chunks.push(args); return chunks.length === 1 ? new Promise(resolve => { release = () => resolve({ success: true }); }) : Promise.resolve({ success: true }); } });
  h.command('start'); await h.controller.idle();
  assert.equal(h.calls[0][1].success, true);
  assert.equal(h.instances[0].options.mimeType, 'video/webm;codecs=vp8');
  h.instances[0].data(new Uint8Array(8 * 1024 * 1024 + 3));
  await flush(); h.command('stop'); await flush();
  assert.equal(h.calls.some(call => call[0] === 'end'), false);
  release(); await h.controller.idle();
  assert.deepEqual(chunks.map(chunk => [chunk.sequence, chunk.bytes.byteLength]), [[0, 8 * 1024 * 1024], [1, 3], [2, 5]]);
  const final = h.calls.filter(call => ['end', 'response'].includes(call[0]));
  assert.deepEqual(final.map(call => call[0]), ['response', 'end', 'response']);
  assert.equal(final.at(-1)[1].success, true);
  assert.ok(h.stoppedTracks() > 0);
});

test('failed chunk upload preserves an unfinished recording instead of sending recordEnd or a successful stop response', async () => {
  const h = fixture({ recordChunk: async () => ({ success: false }) });
  h.command('start'); await h.controller.idle();
  h.instances[0].data('fixture-data'); await flush();
  h.command('stop'); await h.controller.idle();
  assert.equal(h.calls.some(call => call[0] === 'end'), false);
  assert.equal(h.calls.filter(call => call[0] === 'response').at(-1)[1].success, false);
  assert.equal(h.calls.filter(call => call[0] === 'request-stop').length, 1);
});

test('recording rejects mismatched stream commands and replayed command IDs without creating another recorder', async () => {
  const h = fixture();
  h.controller.command({ commandId: 'wrong-stream', action: 'start', id, streamId: 'other' });
  await h.controller.idle(); assert.equal(h.instances.length, 0);
  h.command('start'); h.command('start'); await h.controller.idle();
  assert.equal(h.instances.length, 1);
  h.command('stop'); await h.controller.idle();
  assert.equal(h.calls.filter(call => call[0] === 'response' && call[1].commandId === 'start-command').length, 1);
});

test('disposing a renderer cannot mark pending or incomplete video as saved', async () => {
  const h = fixture(); h.command('start'); await h.controller.idle();
  h.controller.dispose(); await flush();
  h.command('stop'); await h.controller.idle();
  assert.equal(h.calls.some(call => call[0] === 'end'), false);
  assert.equal(h.calls.filter(call => call[0] === 'response').at(-1)[1].success, false);
});
