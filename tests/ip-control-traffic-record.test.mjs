import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { captureIpRecord, rowEndpoint } from '../src/shared/ipTrafficRecord.js';
const require = createRequire(import.meta.url);
const { createIpControlService } = require('../electron/lib/ip-control-service.cjs');
const { wholeSerialResponseProtocol } = require('../electron/lib/serial-response-framer.cjs');

test('only a single exact response frame qualifies; TCP fragments, coalesced frames and invalid CRC/tail are not frames', () => {
  for (const [hex, expected] of [
    ['FE09584248434D44020801CF', 'xbh'], ['AB050ADF4E', 'ab'], ['AB07984401860B', 'ab'],
    ['FE09584248'], ['434D44020801CF'], ['00FE09584248434D44020801CF'], ['AB050ADF4EAB050ADF4E'],
    ['FE09584248434D44020801FF'], ['FE095842FF434D44020801CF'], ['AB050ADF4F'], [''], ['00']
  ]) assert.equal(wholeSerialResponseProtocol(Buffer.from(hex,'hex')), expected, hex);
});

test('network service labels RX without altering displayed bytes or treating TX / split IO as verified protocol replies', async t => {
  const socket = Object.assign(new EventEmitter(), { connect() {}, write(_bytes, cb) { cb(); }, destroy() {} });
  const service = createIpControlService({ createSocket: () => socket }); t.after(service.dispose);
  const opening = service.connect({ host:'127.0.0.1', port:8192 }); socket.emit('connect'); const { sessionId } = await opening;
  const frame = 'FE09584248434D44020801CF';
  await service.send({ sessionId, hex:frame });
  for (const hex of [frame,frame.slice(0,8),frame.slice(8),frame+frame]) socket.emit('data',Buffer.from(hex,'hex'));
  const rows = service.read().entries;
  assert.deepEqual(rows.map(r=>r.hex), [frame,frame,frame.slice(0,8),frame.slice(8),frame+frame]);
  assert.deepEqual(rows.map(r=>r.protocol), [undefined,'xbh',undefined,undefined,undefined]);
});

test('detail snapshot is independent of current endpoint, peer replacement, live presentation and later row mutation', () => {
  const row = { id:1, at:1720000000000, direction:'RX', hex:'0100', peerHost:'::1',peerPort:41000 };
  const view = { mode:'tcp-server',host:'::1',port:8192,localPort:8192,sessionId:'A',peerHost:'::2',peerPort:41001,entries:[row] };
  const detail = captureIpRecord(row,view);
  view.sessionId = 'new'; view.port = 3333; row.hex = 'FF';
  assert.equal(detail.endpoint,'[::1]:41000'); assert.equal(detail.listener,'[::1]:8192'); assert.equal(detail.row.hex,'0100');
  assert.equal(detail.sessionId,'A'); assert.equal('entries' in detail,false);
  assert.equal(rowEndpoint({ direction:'TX' },{ host:'192.0.2.5', port:8192 }), '192.0.2.5:8192');
});
