const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file));
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');

function png(file) {
  const data = Buffer.isBuffer(file) ? file : read(file);
  assert.deepEqual(data.subarray(0, 8), pngSignature);
  assert.equal(data.subarray(12, 16).toString(), 'IHDR');
  return { data, width: data.readUInt32BE(16), height: data.readUInt32BE(20), depth: data[24], type: data[25] };
}

function rgba(image) {
  const chunks = [];
  for (let offset = 8; offset < image.data.length;) {
    const length = image.data.readUInt32BE(offset);
    if (image.data.subarray(offset + 4, offset + 8).toString() === 'IDAT') chunks.push(image.data.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const stride = image.width * 4;
  assert.equal(raw.length, image.height * (stride + 1));
  const pixels = Buffer.alloc(image.height * stride);
  for (let y = 0; y < image.height; y++) {
    const filter = raw[y * (stride + 1)];
    assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const offset = y * stride + x;
      const left = x >= 4 ? pixels[offset - 4] : 0;
      const up = y ? pixels[offset - stride] : 0;
      const corner = x >= 4 && y ? pixels[offset - stride - 4] : 0;
      const predictor = left + up - corner;
      const distances = [Math.abs(predictor - left), Math.abs(predictor - up), Math.abs(predictor - corner)];
      const paeth = distances[0] <= distances[1] && distances[0] <= distances[2] ? left : distances[1] <= distances[2] ? up : corner;
      const correction = [0, left, up, Math.floor((left + up) / 2), paeth][filter];
      pixels[offset] = (raw[y * (stride + 1) + x + 1] + correction) & 255;
    }
  }
  return pixels;
}

test('approved master remains byte-identical to the selected black and emerald artwork', () => {
  assert.equal(createHash('sha256').update(read('assets/brand/veylo-black-emerald-master.png')).digest('hex'),
    '3556df9e86984967f2a227cec8598903a5225755aee3be85099c0385263c366b');
});

test('brand export contains nine exact size-matched 32-bit ICO frames', () => {
  const data = read('icon.ico');
  assert.equal(data.readUInt16LE(0), 0);
  assert.equal(data.readUInt16LE(2), 1);
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  assert.equal(data.readUInt16LE(4), sizes.length);
  let expectedOffset = 6 + 16 * sizes.length;
  sizes.forEach((size, index) => {
    const record = 6 + index * 16;
    assert.equal(data[record] || 256, size);
    assert.equal(data[record + 1] || 256, size);
    assert.equal(data.readUInt16LE(record + 6), 32);
    assert.equal(data.readUInt32LE(record + 12), expectedOffset);
    const frame = data.subarray(expectedOffset, expectedOffset + data.readUInt32LE(record + 8));
    assert.deepEqual(frame, read(`assets/brand/icon-${size}.png`));
    assert.equal(png(frame).width, size);
    assert.equal(png(frame).height, size);
    expectedOffset += frame.length;
  });
  assert.equal(expectedOffset, data.length);
});

test('production raster and favicon use the approved master exports with alpha', () => {
  assert.deepEqual(read('icon.png'), read('assets/brand/icon-512.png'));
  for (const file of ['icon.png', 'assets/brand/icon-16.png']) {
    const image = png(file);
    assert.equal(image.type, 6, 'RGBA pixels retain transparent outer corners');
    assert.equal(image.depth, 8);
    const pixels = rgba(image);
    assert.equal(pixels[3], 0, 'outer corners are transparent');
    const topCenter = Math.floor(image.width / 2) * 4;
    assert.ok(pixels[topCenter] < 8 && pixels[topCenter + 1] < 8 && pixels[topCenter + 2] < 8, 'tile background stays black');
    assert.ok(pixels[topCenter + 3] >= 250, 'only subpixel edge antialiasing is translucent');
    let emeraldPixels = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset + 1] > 120 && pixels[offset + 1] > pixels[offset] * 2 && pixels[offset + 2] > 60) emeraldPixels++;
    }
    assert.ok(emeraldPixels > image.width * image.height * .15, 'mark remains emerald and legible at small sizes');
  }
  for (const [file, size] of [['icon.svg', 512], ['public/favicon.svg', 64]]) {
    const svg = read(file).toString('utf8');
    const embedded = Buffer.from(svg.match(/data:image\/png;base64,([^"\s]+)/)[1], 'base64');
    assert.deepEqual(embedded, read(`assets/brand/icon-${size}.png`));
    assert.doesNotMatch(svg, /script|https?:\/\/(?!www\.w3\.org)/);
  }
});

test('brand header and startup use Veylo artwork while device icons stay unchanged', () => {
  const app = read('src/App.jsx').toString('utf8');
  assert.match(app, /import brandIcon from '\.\.\/assets\/brand\/icon-128\.png'/);
  assert.match(app, /<img src=\{brandIcon\}[^>]*aria-hidden="true"/);
  assert.match(app, /<Smartphone size=\{20\}/);
  const html = read('index.html').toString('utf8');
  assert.match(html, /src="\/favicon\.svg"[^>]*width="72"/);
  assert.doesNotMatch(html, /<rect x="20" y="10"/);
  const particles = read('electron/startup/particles.js').toString('utf8');
  assert.doesNotMatch(particles, /roundRect\(201, 24, 58, 96/);
  assert.match(particles, /durationMs = 4400/);
});
