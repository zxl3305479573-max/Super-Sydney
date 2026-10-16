import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LastPages, isRememberable, readPages } from '../services/last-pages.ts';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-last-pages-'));

test('记下的页面落盘后，新实例能读回', () => {
  const dir = tempDir();
  const pages = new LastPages(dir);
  pages.set('embed:xianyu', 'https://www.goofish.com/item?id=1');
  pages.flush();
  assert.equal(new LastPages(dir).get('embed:xianyu'), 'https://www.goofish.com/item?id=1');
});

test('forget 之后不再回到那一页', () => {
  const dir = tempDir();
  const pages = new LastPages(dir);
  pages.set('xhs:1', 'https://www.xiaohongshu.com/explore/abc');
  pages.forget('xhs:1');
  pages.flush();
  assert.equal(new LastPages(dir).get('xhs:1'), '');
});

test('只记 http(s) 地址', () => {
  assert.equal(isRememberable('https://a.com/'), true);
  assert.equal(isRememberable('http://localhost:3000/'), true);
  assert.equal(isRememberable('about:blank'), false);
  assert.equal(isRememberable('javascript:alert(1)'), false);
  assert.equal(isRememberable(''), false);
  assert.equal(isRememberable(`https://a.com/${'x'.repeat(3000)}`), false);
});

test('损坏或混入非法值的文件按空 / 过滤处理', () => {
  const dir = tempDir();
  const file = path.join(dir, 'last-pages.json');
  fs.writeFileSync(file, '{oops');
  assert.deepEqual(readPages(file), {});
  fs.writeFileSync(file, JSON.stringify({ a: 'https://a.com/', b: 3, c: 'file:///etc/passwd' }));
  assert.deepEqual(readPages(file), { a: 'https://a.com/' });
});
