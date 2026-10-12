import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldCaptureScreen } from '../services/screen-capture-policy.ts';

test('allows an approved application with a non-sensitive window', () => {
  assert.deepEqual(shouldCaptureScreen({
    appName: 'Visual Studio Code',
    windowTitle: 'main.ts',
    allowedApps: ['Code'],
    blockedApps: ['微信']
  }), { allowed: true, reason: 'allowed' });
});

test('skips missing, blocked, disallowed, and sensitive windows', () => {
  assert.equal(shouldCaptureScreen({ appName: '', windowTitle: '', allowedApps: [], blockedApps: [] }).reason, 'missing-app');
  assert.equal(shouldCaptureScreen({ appName: '微信', windowTitle: '聊天', allowedApps: [], blockedApps: ['微信'] }).reason, 'blocked-app');
  assert.equal(shouldCaptureScreen({ appName: 'Notepad', windowTitle: 'notes', allowedApps: ['Code'], blockedApps: [] }).reason, 'not-allowed-app');
  assert.equal(shouldCaptureScreen({ appName: 'Chrome', windowTitle: 'Sign in to account', allowedApps: [], blockedApps: [] }).reason, 'sensitive-window');
});

test('applies configured blocked app names to the title as well as the app name', () => {
  const decision = shouldCaptureScreen({
    appName: 'Chrome',
    windowTitle: 'Private messages',
    allowedApps: ['Chrome'],
    blockedApps: ['private']
  });
  assert.deepEqual(decision, { allowed: false, reason: 'blocked-app' });
});
