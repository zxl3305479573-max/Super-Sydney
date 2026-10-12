import assert from 'node:assert/strict';
import test from 'node:test';
import { describeCaptureObservation } from '../services/capture-status.ts';

test('reports an allowed active window as sampled immediately', () => {
  const result = describeCaptureObservation({ appName: 'Codex', windowTitle: 'Sydney', allowed: true, blocked: false, sampledAt: '2026-10-08T03:00:00.000Z' });
  assert.equal(result.state, 'sampling');
  assert.equal(result.appName, 'Codex');
  assert.match(result.message, /Codex/);
});

test('reports blocked or disallowed windows without pretending they were sampled', () => {
  const blocked = describeCaptureObservation({ appName: '1Password', windowTitle: 'Vault', allowed: true, blocked: true, sampledAt: '2026-10-08T03:00:00.000Z' });
  const disallowed = describeCaptureObservation({ appName: 'Discord', windowTitle: 'Chat', allowed: false, blocked: false, sampledAt: '2026-10-08T03:00:00.000Z' });
  assert.equal(blocked.state, 'blocked');
  assert.equal(disallowed.state, 'blocked');
  assert.match(disallowed.message, /Discord · Chat/);
  assert.match(blocked.message, /1Password · Vault/);
});

test('reports an unallowed non-sensitive window as saved for manual review when enabled', () => {
  const result = describeCaptureObservation({ appName: 'Discord', windowTitle: 'Chat', allowed: false, blocked: false, saveUnallowed: true, sampledAt: '2026-10-08T03:00:00.000Z' });
  assert.equal(result.state, 'sampling');
  assert.match(result.message, /已保存待确认/);
});
