import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseProductAccent, compactProductResearch, normalizeBrandColors, normalizeWebsiteUrl
} from '../services/video-product-research.ts';

test('product website URLs accept normal user input and reject unsafe schemes', () => {
  assert.equal(normalizeWebsiteUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeWebsiteUrl(' https://Example.com/docs#intro '), 'https://example.com/docs');
  assert.throws(() => normalizeWebsiteUrl(''), /填写/);
  assert.throws(() => normalizeWebsiteUrl('file:///C:/secret.txt'), /HTTP/);
  assert.throws(() => normalizeWebsiteUrl('https://user:pass@example.com'), /账号或密码/);
});

test('brand colors are normalized before entering the frame HTML', () => {
  assert.deepEqual(normalizeBrandColors(['#12AB34', '#12ab34', 'rgb(10 20 30)', 'rgb(20, 30, 40)', 'red', 'url(javascript:x)']), ['#12ab34', 'rgb(10 20 30)', 'rgb(20 30 40)']);
  assert.equal(chooseProductAccent(['#FFFFFF', '#888888', '#1463D8']), '#1463d8');
  assert.equal(chooseProductAccent(['white', 'black'], '#B4472C'), '#B4472C');
});

test('website research is compacted and strips control characters without exceeding the storage budget', () => {
  const research = compactProductResearch({
    url: 'example.com',
    title: '  Example   Product ',
    description: 'A\u0000 useful product',
    headings: ['Features', '', 'Pricing'],
    bodyText: 'hello\n\nworld',
    colors: []
  });
  assert.match(research, /https:\/\/example.com\//);
  assert.match(research, /Example Product/);
  assert.match(research, /A useful product/);
  assert.match(research, /- Features/);
  assert.match(research, /hello world/);
  assert.ok(research.length <= 12_000);
});
