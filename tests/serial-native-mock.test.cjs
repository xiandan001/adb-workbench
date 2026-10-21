const test = require('node:test');
const assert = require('node:assert/strict');
const { SerialPortMock } = require('serialport');
const { createSerialService } = require('../electron/lib/serial-service.cjs');
const { DEFAULT_CONFIG } = require('../electron/lib/serial-policy.cjs');

test('official SerialPort mock exercises real stream open/write/drain/read/close at 921600', async t => {
  SerialPortMock.binding.reset();
  SerialPortMock.binding.createPort('COM_TEST_ONLY', { echo: true, record: true });
  let port;
  const service = createSerialService({ listPorts: () => SerialPortMock.list(),
    createPort: options => { port = new SerialPortMock(options); return port; } });
  t.after(async () => { await service.dispose(); SerialPortMock.binding.reset(); });
  assert.equal((await service.listPorts())[0].path, 'COM_TEST_ONLY');
  assert.equal(port, undefined, 'listing must not create a stream');
  await service.connect({ path: 'COM_TEST_ONLY', config: { ...DEFAULT_CONFIG, baudRate: 921600 } });
  await service.send({ sessionId: service.snapshot().sessionId, mode: 'hex', content: '00 FF 80 E4 BD A0', lineEnding: 'crlf' });
  const deadline = Date.now() + 1000;
  while (service.snapshot().rxBytes < 6 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(port.baudRate, 921600);
  assert.equal(port.port.recording.toString('hex'), '00ff80e4bda0');
  assert.equal(service.snapshot().txBytes, 6);
  assert.equal(service.snapshot().rxBytes, 6);
  assert.equal(service.snapshot().entries.filter(row => row.direction === 'RX').map(row => row.hex).join(''), '00ff80e4bda0');
  await service.disconnect();
  assert.equal(port.isOpen, false);
});
