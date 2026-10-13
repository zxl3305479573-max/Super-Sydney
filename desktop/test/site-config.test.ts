import test from 'node:test';
import assert from 'node:assert/strict';
import { clampSiteBounds, hostLabel, normalizeSiteUrl, normalizeStoredConfig, readSiteConfig, sanitizeSiteEntries, writeSiteConfig } from '../services/site-config.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('站点地址没写协议时按 https 补全', () => {
  assert.equal(normalizeSiteUrl('pay.example.com'), 'https://pay.example.com/');
});

test('主机:端口不被当成协议头', () => {
  assert.equal(normalizeSiteUrl('localhost:3000'), 'https://localhost:3000/');
  assert.equal(normalizeSiteUrl('pay.example.com:8080/shop'), 'https://pay.example.com:8080/shop');
});

test('已写协议的地址原样规范化，保留路径、端口与查询', () => {
  assert.equal(normalizeSiteUrl('  http://localhost:3000/shop/item?id=3#pay  '), 'http://localhost:3000/shop/item?id=3#pay');
  assert.equal(normalizeSiteUrl('HTTP://Pay.Example.COM'), 'http://pay.example.com/');
});

test('非 http/https 协议一律拒绝', () => {
  assert.throws(() => normalizeSiteUrl('javascript:alert(1)'), /只支持 http 与 https/);
  assert.throws(() => normalizeSiteUrl('data:text/html,<h1>x</h1>'), /只支持 http 与 https/);
  assert.throws(() => normalizeSiteUrl('file:///C:/Windows/win.ini'), /只支持 http 与 https/);
  assert.throws(() => normalizeSiteUrl('ftp://example.com'), /只支持 http 与 https/);
});

test('空值与填坏的网址给出可读提示', () => {
  assert.throws(() => normalizeSiteUrl(''), /请先填写站点地址/);
  assert.throws(() => normalizeSiteUrl('   '), /请先填写站点地址/);
  assert.throws(() => normalizeSiteUrl(null), /请先填写站点地址/);
  assert.throws(() => normalizeSiteUrl('https://'), /格式不正确/);
});

test('承载区域越出窗口时被夹回可视区', () => {
  const viewport = { width: 1200, height: 800 };
  assert.deepEqual(clampSiteBounds({ x: 100, y: 50, width: 900, height: 600 }, viewport), { x: 100, y: 50, width: 900, height: 600 });
  assert.deepEqual(clampSiteBounds({ x: 600, y: 700, width: 900, height: 600 }, viewport), { x: 600, y: 700, width: 600, height: 100 });
  assert.deepEqual(clampSiteBounds({ x: -120, y: -40, width: 900, height: 600 }, viewport), { x: 0, y: 0, width: 780, height: 560 });
});

test('看不出是块区域时不挂视图', () => {
  const viewport = { width: 1200, height: 800 };
  assert.equal(clampSiteBounds(null, viewport), null);
  assert.equal(clampSiteBounds({ x: 10, y: 10, width: 40, height: 600 }, viewport), null);
  assert.equal(clampSiteBounds({ x: '10', y: 10, width: 900, height: 600 }, viewport), null);
  assert.equal(clampSiteBounds({ x: 10, y: 900, width: 900, height: 600 }, viewport), null);
});

test('站点列表存在 userData 下的独立文件里，读坏值当作没配', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-site-'));
  const sites = [{ id: 'a', name: '主站', url: 'https://pay.example.com/' }, { id: 'b', name: '备站', url: 'https://backup.example.com/' }];
  try {
    assert.deepEqual(readSiteConfig(dir), { sites: [], activeId: '' });
    writeSiteConfig(dir, { sites, activeId: 'b' });
    assert.deepEqual(readSiteConfig(dir), { sites, activeId: 'b' });
    fs.writeFileSync(path.join(dir, 'site.json'), '{ 坏掉的 json');
    assert.deepEqual(readSiteConfig(dir), { sites: [], activeId: '' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('界面提交的站点列表要过校验：坏地址、缺 id、重复 id 都拦下', () => {
  assert.deepEqual(
    sanitizeSiteEntries([{ id: 'a', name: ' 主站 ', url: 'pay.example.com' }, { id: 'b', name: '', url: 'https://b.example.com' }]),
    [{ id: 'a', name: '主站', url: 'https://pay.example.com/' }, { id: 'b', name: 'b.example.com', url: 'https://b.example.com/' }]
  );
  assert.throws(() => sanitizeSiteEntries([{ id: 'a', url: 'javascript:alert(1)' }]), /第 1 个站点：站点地址只支持/);
  assert.throws(() => sanitizeSiteEntries([{ id: 'a', url: 'https://a.example.com' }, { id: 'a', url: 'https://b.example.com' }]), /标识重复/);
  assert.throws(() => sanitizeSiteEntries([{ name: 'x', url: 'https://a.example.com' }]), /缺少标识/);
  assert.throws(() => sanitizeSiteEntries('nope'), /格式不正确/);
  assert.throws(() => sanitizeSiteEntries(new Array(21).fill({ id: 'x', url: 'https://a.example.com' })), /最多 20 个/);
});

test('旧的单站点配置读成只有一个站点，坏条目直接丢掉', () => {
  const legacy = normalizeStoredConfig({ url: 'https://sydney.aileaderai.top/' });
  assert.deepEqual(legacy, { sites: [{ id: 'site-1', name: 'sydney.aileaderai.top', url: 'https://sydney.aileaderai.top/' }], activeId: 'site-1' });

  const mixed = normalizeStoredConfig({
    sites: [
      { id: 'a', name: '好的', url: 'https://ok.example.com' },
      { id: 'b', name: '坏的', url: 'file:///C:/Windows/win.ini' },
      { id: 'c', name: '也不好的', url: '' }
    ],
    activeId: 'b'
  });
  assert.deepEqual(mixed, { sites: [{ id: 'a', name: '好的', url: 'https://ok.example.com/' }], activeId: 'a' });

  assert.deepEqual(normalizeStoredConfig(null), { sites: [], activeId: '' });
  assert.deepEqual(normalizeStoredConfig('nope'), { sites: [], activeId: '' });
});

test('站点名缺省用域名兜底', () => {
  assert.equal(hostLabel('https://sydney.aileaderai.top/admin'), 'sydney.aileaderai.top');
  assert.equal(hostLabel('不是地址'), '未命名站点');
});
