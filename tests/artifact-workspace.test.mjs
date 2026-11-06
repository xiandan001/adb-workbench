import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, sortArtifacts, resolveArtifactPreviewRequest } from '../src/shared/artifactWorkspace.js';

test('artifact size formatting distinguishes zero and unknown capacity', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(null), '容量未知');
  assert.equal(formatBytes(1024), '1.00 KB');
  assert.equal(formatBytes(10485760), '10.0 MB');
});

test('incoming artifact preview waits for idle, resolves only an indexed ID and consumes each request once', () => {
  const item = { id: 'task:indexed', taskId: 'task-original' };
  const request = { id: item.id, requestId: 7 };
  assert.equal(resolveArtifactPreviewRequest([item], request, '', true), null);
  const resolved = resolveArtifactPreviewRequest([item], request, '', false);
  assert.equal(resolved.item, item);
  assert.equal(resolveArtifactPreviewRequest([item], request, resolved.key, false), null);
  assert.equal(resolveArtifactPreviewRequest([item], { ...request, requestId: 8 }, resolved.key, false).item, item);
  assert.equal(resolveArtifactPreviewRequest([item], { id: '../unindexed', requestId: 9 }, '', false).item, null);
});

test('artifact sort includes older items and places unknown size last', () => {
  const items = [{ id: 'old', updatedAt: '2020-01-01', sizeBytes: 500 }, { id: 'new', updatedAt: '2026-01-01', sizeBytes: 20 }, { id: 'unknown', updatedAt: '2025-01-01', sizeBytes: null }];
  assert.deepEqual(sortArtifacts(items, 'size').map(item => item.id), ['old', 'new', 'unknown']);
  assert.deepEqual(sortArtifacts(items, 'newest').map(item => item.id), ['new', 'unknown', 'old']);
  assert.deepEqual(sortArtifacts(items, 'oldest').map(item => item.id), ['old', 'unknown', 'new']);
  assert.equal(items[0].id, 'old');
});
