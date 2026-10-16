import test from 'node:test';
import assert from 'node:assert/strict';
import { chromeCandidates, findChrome, openInBrowser } from '../services/open-in-browser.ts';

const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };

test('Windows 上依次找 Program Files、Program Files (x86)、用户目录里的 Chrome', () => {
  assert.deepEqual(chromeCandidates(env, 'win32'), [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'
  ]);
});

test('SYDNEY_CHROME 指定的路径排在最前', () => {
  assert.equal(chromeCandidates({ ...env, SYDNEY_CHROME: 'D:\\chrome\\chrome.exe' }, 'win32')[0], 'D:\\chrome\\chrome.exe');
});

test('只装在用户目录时也能找到；都没有时返回 null', () => {
  const user = 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
  assert.equal(findChrome(env, 'win32', file => file === user), user);
  assert.equal(findChrome(env, 'win32', () => false), null);
});

test('非 http(s) 地址既不开 Chrome 也不交给系统', async () => {
  let called = false;
  await openInBrowser('file:///C:/Windows/system32/calc.exe', async () => { called = true; });
  assert.equal(called, false);
});
