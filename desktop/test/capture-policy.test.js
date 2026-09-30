const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../capture-policy');

test('blocked apps never enter the capture pipeline', () => {
  assert.equal(policy.shouldCapture({ appName: '1Password', title: 'Vault' }, { allowedApps: [], blockedApps: ['1Password'] }), false);
});

test('password and private windows are redacted before persistence', () => {
  const result = policy.sanitizeWindow({ appName: 'Chrome', title: 'Sign in password payment' });
  assert.equal(result.capture, false);
  assert.equal(result.windowTitle, '[敏感窗口已跳过]');
});

test('capture retention returns a deterministic cutoff', () => {
  const now = new Date('2026-09-30T12:00:00.000Z');
  assert.equal(policy.retentionCutoff(now, 48).toISOString(), '2026-09-28T12:00:00.000Z');
});
