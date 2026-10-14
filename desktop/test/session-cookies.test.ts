import test from 'node:test';
import assert from 'node:assert/strict';
import type { Cookie } from 'electron';
import { cookieBelongsTo, KEEP_LOGIN_DAYS, persistentCopy, shouldPersist } from '../services/session-cookies.ts';

function cookie(overrides: Partial<Cookie> = {}): Cookie {
  return {
    name: 'slave_sid', value: 'abc', domain: '.mp.weixin.qq.com', hostOnly: false, path: '/',
    secure: true, httpOnly: true, session: true, sameSite: 'no_restriction', ...overrides
  } as Cookie;
}

test('a login session cookie becomes the same cookie with an expiry', () => {
  const now = Date.UTC(2026, 9, 14);
  const copy = persistentCopy(cookie(), now);
  assert.deepEqual(copy, {
    url: 'https://mp.weixin.qq.com/', name: 'slave_sid', value: 'abc', path: '/', secure: true, httpOnly: true,
    sameSite: 'no_restriction', domain: '.mp.weixin.qq.com', expirationDate: now / 1000 + KEEP_LOGIN_DAYS * 86_400
  });
});

test('a host-only cookie stays host-only', () => {
  const copy = persistentCopy(cookie({ domain: 'mp.weixin.qq.com', hostOnly: true, path: '/cgi-bin' }), 0);
  assert.equal(copy.url, 'https://mp.weixin.qq.com/cgi-bin');
  assert.equal('domain' in copy, false);
});

test('only new session cookies of the site itself are persisted', () => {
  const weixin = ['weixin.qq.com'];
  assert.equal(shouldPersist(cookie(), false, weixin), true);
  assert.equal(shouldPersist(cookie(), true, weixin), false, 'logout removals are left alone');
  assert.equal(shouldPersist(cookie({ session: false }), false, weixin), false, 'already persistent');
  assert.equal(shouldPersist(cookie({ domain: '.tracker.example' }), false, weixin), false, 'third-party cookie');
});

test('cookies of the site, its subdomains and its parent domain belong to it', () => {
  const xianyu = ['goofish.com', 'taobao.com'];
  assert.equal(cookieBelongsTo('www.goofish.com', xianyu), true, 'subdomain');
  assert.equal(cookieBelongsTo('goofish.com', xianyu), true, 'same host');
  assert.equal(cookieBelongsTo('qq.com', ['mp.weixin.qq.com']), true, 'login cookie on the parent domain');
  assert.equal(cookieBelongsTo('com', xianyu), false, 'never a top-level domain');
  assert.equal(cookieBelongsTo('notgoofish.com', xianyu), false, 'suffix without a dot is another site');
  assert.equal(cookieBelongsTo('www.goofish.com', []), false, 'no configured site');
});
