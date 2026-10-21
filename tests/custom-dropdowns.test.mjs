import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradientOptions, CARD_BACKGROUNDS, TERMINAL_BACKGROUNDS } from '../src/data/deviceControlOptions.js';

test('renderer contains no native dropdown or datalist fallbacks', () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const inspect = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) inspect(file);
      else if (/\.jsx$/.test(entry.name)) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /<(?:select|datalist)\b/, file);
    }
  };
  inspect(root);
});

test('custom theme choices retain previously configured gradient values and have unique option IDs', () => {
  const current = 'from-emerald-500';
  assert.equal(gradientOptions('from', current)[0].value, current);
  for (const options of [gradientOptions('from', current), gradientOptions('to', 'to-emerald-600'), CARD_BACKGROUNDS, TERMINAL_BACKGROUNDS]) {
    assert.equal(new Set(options.map(option => option.value)).size, options.length);
    assert.ok(options.every(option => option.label));
  }
});
