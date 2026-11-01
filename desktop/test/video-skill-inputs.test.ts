import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VideoProject } from '../shared.ts';
import { VIDEO_RENDER_DEFAULTS, emptyRenderAssets } from '../services/video-production.ts';
import { assertStableSkillInput, hasStableSkillInput, skillInputFingerprint } from '../services/video-skill-inputs.ts';

function project(patch: Partial<VideoProject> = {}): VideoProject {
  return {
    id: 1,
    platform: 'douyin',
    topic: '演示',
    title: '演示',
    audience: '',
    durationSeconds: 10,
    status: 'storyboard',
    topicsJson: '',
    script: '演示脚本',
    storyboardJson: '',
    coverPath: '',
    exportPath: '',
    createdAt: '',
    updatedAt: '',
    options: { ...VIDEO_RENDER_DEFAULTS, workflow: 'footage-edit' },
    assets: emptyRenderAssets(),
    ...patch
  };
}

test('external skill fingerprints change when the source file changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-skill-input-'));
  try {
    const source = path.join(root, 'source.mp4');
    fs.writeFileSync(source, 'video-a');
    const first = skillInputFingerprint(source);
    fs.writeFileSync(source, 'video-b');
    const second = skillInputFingerprint(source);
    assert.notEqual(first, second);
    const saved = project({ options: { ...VIDEO_RENDER_DEFAULTS, workflow: 'footage-edit', sourcePath: source, skillInputSignature: first } });
    assert.equal(hasStableSkillInput(saved), false);
    assert.throws(() => assertStableSkillInput(saved), /已变化/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('browser config fingerprints include screenshots referenced by the config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-browser-input-'));
  try {
    const shot = path.join(root, 'shot.png');
    const config = path.join(root, 'browser.json');
    fs.writeFileSync(shot, 'page-one');
    fs.writeFileSync(config, JSON.stringify({ duration: 2, shots: { top: 'shot.png' } }));
    const first = skillInputFingerprint(config);
    fs.writeFileSync(shot, 'page-two');
    const second = skillInputFingerprint(config);
    assert.notEqual(first, second);
    const saved = project({ options: { ...VIDEO_RENDER_DEFAULTS, workflow: 'browser-demo', sourcePath: config, skillInputSignature: second } });
    assert.equal(hasStableSkillInput(saved), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
