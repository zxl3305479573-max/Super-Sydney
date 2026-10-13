import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 回归护栏：预览 iframe 不能用 sandbox=""。
 *
 * 当前 Electron/Chromium 下空 sandbox 会让 srcdoc 帧根本不加载——主进程其实已经渲染好 HTML，
 * 界面上却只剩一块空白，而且没有任何报错，排查成本很高。这里用源码断言把这个坑钉住。
 */
test('预览 iframe 不使用空 sandbox，且继续禁止脚本', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'renderer', 'native-content', 'steps.tsx'), 'utf8');
  const frames = source.split('\n').filter(line => line.includes('<iframe'));
  assert.ok(frames.length, '没有找到预览 iframe');
  for (const frame of frames) {
    assert.doesNotMatch(frame, /sandbox=""/, `预览 iframe 又用上了空 sandbox：${frame.trim()}`);
    assert.match(frame, /sandbox="allow-same-origin"/, `预览 iframe 需要 allow-same-origin 才能加载 srcdoc：${frame.trim()}`);
    assert.doesNotMatch(frame, /allow-scripts/, `预览内容不允许执行脚本：${frame.trim()}`);
  }
});
