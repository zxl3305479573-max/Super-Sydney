import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReleaseNotes, extractChangelogSection } from '../services/release-notes.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('从 CHANGELOG.md 精确提取对应版本的中文更新说明', () => {
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const v017 = extractChangelogSection(changelog, '0.1.7');
  assert.ok(v017.length > 80);
  assert.match(v017, /应用内更新体验修复/);
  assert.match(v017, /视频工作台 2\.0/);
  assert.doesNotMatch(v017, /^## \[0\.1\.6\]/m);

  const v016 = extractChangelogSection(changelog, 'v0.1.6');
  assert.ok(v016.length > 50);
  assert.match(v016, /多平台差异化分发与运营中控/);
});

test('CHANGELOG 缺失对应版本时回退到附注标签或非发版提交列表', () => {
  const fromTag = buildReleaseNotes({
    version: '0.2.0',
    changelog: '## [0.1.7]\n- 旧版本',
    tagMessage: 'Sydney v0.2.0\n\n- 新增语音克隆\n- 修复深色主题对比度'
  });
  assert.equal(fromTag, '- 新增语音克隆\n- 修复深色主题对比度');

  const fromCommits = buildReleaseNotes({
    version: '0.2.1',
    changelog: '',
    tagMessage: 'Sydney v0.2.1',
    commitSubjects: [
      'chore(desktop): bump version to 0.2.1',
      '新增视频关键帧导出',
      '修复封面比例裁剪边缘'
    ]
  });
  assert.equal(fromCommits, '### Sydney v0.2.1 更新内容\n\n- 新增视频关键帧导出\n- 修复封面比例裁剪边缘');
});
