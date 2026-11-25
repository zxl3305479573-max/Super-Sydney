import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReleaseNotes,
  categorizeCommits,
  extractChangelogSection,
  injectReleaseNotesIntoLatestYml,
  markdownNotesToPlainText
} from '../services/release-notes.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('从 CHANGELOG.md 精确提取对应版本的中文更新说明，按三大类组织且无尖括号', () => {
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

  const v019 = extractChangelogSection(changelog, '0.1.9');
  assert.ok(v019.length > 100);
  assert.match(v019, /### 新增功能/);
  assert.match(v019, /### 优化内容/);
  assert.match(v019, /### 修复 Bug/);
  assert.match(v019, /小红书/);
  assert.doesNotMatch(v019, /[<>]/);
  assert.doesNotMatch(v019, /^## \[0\.1\.8\]/m);

  const v018 = extractChangelogSection(changelog, '0.1.8');
  assert.ok(v018.length > 100);
  assert.match(v018, /### 新增功能/);
  assert.match(v018, /### 优化内容/);
  assert.match(v018, /### 修复 Bug/);
  assert.match(v018, /运营中控/);
  assert.doesNotMatch(v018, /[<>]/);
  assert.doesNotMatch(v018, /^## \[0\.1\.7\]/m);

  const v017 = extractChangelogSection(changelog, '0.1.7');
  assert.ok(v017.length > 50);
  assert.match(v017, /### 新增功能/);
  assert.match(v017, /### 优化内容/);
  assert.match(v017, /### 修复 Bug/);
  assert.match(v017, /CHANGELOG 版本说明自动提取脚本/);
  assert.doesNotMatch(v017, /[<>]/);
  assert.doesNotMatch(v017, /^## \[0\.1\.6\]/m);

  const v016 = extractChangelogSection(changelog, 'v0.1.6');
  assert.ok(v016.length > 50);
  assert.match(v016, /### 新增功能/);
  assert.doesNotMatch(v016, /[<>]/);
});

test('CHANGELOG 缺失对应版本时回退到附注标签或分类提交列表', () => {
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
      '优化分镜渲染速度',
      '修复封面比例裁剪边缘'
    ]
  });
  assert.match(fromCommits, /### 新增功能\n- 新增视频关键帧导出/);
  assert.match(fromCommits, /### 优化内容\n- 优化分镜渲染速度/);
  assert.match(fromCommits, /### 修复 Bug\n- 修复封面比例裁剪边缘/);
});

test('markdownNotesToPlainText 输出无尖括号的方括号分类标题与纯文本列表', () => {
  const md = `### 新增功能\n- 新增 <code>sydney-video://</code> 本地流媒体协议\n\n### 优化内容\n- 字幕 <14 字换行\n\n### 修复 Bug\n- 修复 100% 混音问题`;
  const plain = markdownNotesToPlainText(md);
  assert.doesNotMatch(plain, /[<>]/);
  assert.match(plain, /【新增功能】\n• 新增 sydney-video:\/\/ 本地流媒体协议/);
  assert.match(plain, /【优化内容】\n• 字幕 14 字换行/);
  assert.match(plain, /【修复 Bug】\n• 修复 100% 混音问题/);
});

test('injectReleaseNotesIntoLatestYml 正确将纯文本更新说明注入 latest.yml', () => {
  const rawYml = `version: 0.1.8
files:
  - url: Sydney-Setup-0.1.8.exe
    sha512: abcdef123456
path: Sydney-Setup-0.1.8.exe
sha512: abcdef123456
releaseDate: '2026-11-18T12:00:00.000Z'
`;
  const plainNotes = `【新增功能】\n• 新增本地大字封面\n\n【修复 Bug】\n• 修复混音问题`;
  const injected = injectReleaseNotesIntoLatestYml(rawYml, plainNotes);

  assert.match(injected, /releaseNotes: \|-\n  【新增功能】\n  • 新增本地大字封面\n\n  【修复 Bug】\n  • 修复混音问题/);
  assert.doesNotMatch(injected, /[<>]/);

  // 再次注入应幂等替换已有 releaseNotes
  const reInjected = injectReleaseNotesIntoLatestYml(injected, '【优化内容】\n• 再次更新');
  assert.match(reInjected, /releaseNotes: \|-\n  【优化内容】\n  • 再次更新/);
  assert.doesNotMatch(reInjected, /新增本地大字封面/);
});
