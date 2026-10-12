import test from 'node:test';
import assert from 'node:assert/strict';
import { ARTICLE_THEMES, DEFAULT_AIGC_FOOTER, escapeHtml, getArticleTheme, makeDigest, normalizeTitle, renderWeChatHtml, toPlainText } from '../services/article-html.ts';
import { WeChatClient, WeChatError, contentTypeFor } from '../services/wechat-publisher.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('escapeHtml neutralizes markdown-embedded markup', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('a & b "c" \'d\''), 'a &amp; b &quot;c&quot; &#39;d&#39;');
});

test('rendered HTML escapes raw HTML from the model', () => {
  const html = renderWeChatHtml('# 标题\n\n<img src=x onerror="alert(1)">正常段落');
  // 关键性质：不存在可执行的标签，原始标记只作为转义后的惰性文本存在
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  // 正文仍可读（没被整体丢弃）
  assert.match(html, /正常段落/);
});

test('renders headings, lists, quotes and bold with inline styles only', () => {
  const html = renderWeChatHtml([
    '# 一级标题', '', '**加粗** 与普通文字', '',
    '- 第一项', '- 第二项', '',
    '> 引用一句', '',
    '1. 有序一', '2. 有序二'
  ].join('\n'));
  assert.match(html, /<h1 style="[^"]*font-size:26px/);
  assert.match(html, /<strong style="[^"]*color:#0f6b52/);
  assert.match(html, /<ul style="[^"]*">/);
  assert.match(html, /<ol style="[^"]*">/);
  assert.match(html, /<blockquote style="[^"]*border-left:5px solid #0f6b52/);
  // 微信会剥离 <style> 标签，因此不能出现
  assert.doesNotMatch(html, /<style/);
  assert.doesNotMatch(html, /class=/);
});

test('AIGC footer is optional and escaped', () => {
  assert.match(renderWeChatHtml('正文', { aigcFooter: DEFAULT_AIGC_FOOTER }), /不能替代医生的诊断和处方/);
  assert.doesNotMatch(renderWeChatHtml('正文'), /不能替代医生/);
  assert.match(renderWeChatHtml('正文', { aigcFooter: '<b>声明</b>' }), /&lt;b&gt;声明&lt;\/b&gt;/);
});

test('toPlainText strips markdown markers', () => {
  const plain = toPlainText('# 标题\n\n**重点**内容 `代码` [链接](https://x.test)\n\n- 列表项\n> 引用');
  assert.doesNotMatch(plain, /[#*`>\[\]]/);
  assert.match(plain, /标题/);
  assert.match(plain, /重点内容/);
  assert.match(plain, /链接/);
  assert.match(plain, /列表项/);
});

test('makeDigest respects the UTF-8 byte limit without splitting characters', () => {
  // 中文每字 3 字节 → 120 字节最多 40 字
  const digest = makeDigest('中'.repeat(100));
  assert.equal(digest.length, 40);
  assert.ok(Buffer.byteLength(digest, 'utf8') <= 120);
  // 4 字节字符不能被截断成半个
  const emoji = makeDigest('😀'.repeat(50));
  assert.ok(Buffer.byteLength(emoji, 'utf8') <= 120);
  assert.doesNotMatch(emoji, /[\uD800-\uDBFF]$/);
  assert.equal(makeDigest('很短'), '很短');
});

test('normalizeTitle collapses whitespace and truncates by character', () => {
  assert.equal(normalizeTitle('  多   空格  标题 '), '多 空格 标题');
  assert.equal(normalizeTitle('标'.repeat(80)).length, 64);
  assert.equal(normalizeTitle('正常标题'), '正常标题');
});

test('contentTypeFor maps common cover formats', () => {
  assert.equal(contentTypeFor('a.PNG'), 'image/png');
  assert.equal(contentTypeFor('a.jpeg'), 'image/jpeg');
  assert.equal(contentTypeFor('a.webp'), 'image/webp');
  assert.equal(contentTypeFor('a.txt'), 'application/octet-stream');
});

test('markdown images render as inline-styled tags and can be resolved', () => {
  const html = renderWeChatHtml('正文\n\n![柚子的挑选](<C:/a b/cover.png>)\n\n继续', { resolveImage: source => `data:image/png;base64,${source.length}` });
  assert.match(html, /<img src="data:image\/png;base64,\d+" alt="柚子的挑选"/);
  assert.match(html, /max-width:100%/);
  assert.match(html, /<p style="[^"]*text-align:center[^"]*">柚子的挑选<\/p>/);
  // 未解析时保留原地址，而不是丢掉图片
  assert.match(renderWeChatHtml('![](<local.png>)'), /src="local\.png"/);
});

test('paragraph text that merely contains bangs is not treated as an image', () => {
  const html = renderWeChatHtml('注意！[重要](<这里>) 是文字不是图片');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /注意/);
});

test('themes swap styles and fall back to the elder-friendly default', () => {
  const clean = renderWeChatHtml('## 小标题', { theme: 'clean' });
  assert.match(clean, /<h2 style="[^"]*#1f6feb/);
  const classic = renderWeChatHtml('# 标题', { theme: 'classic' });
  assert.match(classic, /font-family:Georgia/);
  const unknown = renderWeChatHtml('# 标题', { theme: '不存在的主题' });
  assert.match(unknown, /font-size:26px/);
  assert.equal(getArticleTheme('magazine').name, 'magazine');
  assert.equal(getArticleTheme(undefined).name, 'elder-clear');
  assert.ok(ARTICLE_THEMES.length >= 5);
});

function stubFetch(handlers: Array<(url: string, init?: RequestInit) => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let index = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const handler = handlers[Math.min(index, handlers.length - 1)];
    index += 1;
    return handler(url, init);
  }) as typeof fetch;
  return { impl, calls };
}

const CREDS = { appid: 'wx_test', secret: 'secret_test' };

test('access token is cached across operations', async () => {
  const { impl, calls } = stubFetch([
    () => json({ access_token: 'tok_1', expires_in: 7200 }),
    () => json({ media_id: 'thumb_1' }),
    () => json({ media_id: 'draft_1' })
  ]);
  const client = new WeChatClient(impl, () => 1_000_000);
  const thumb = await client.uploadThumb(CREDS, { bytes: Buffer.from('x'), filename: 'c.png', contentType: 'image/png' });
  const draft = await client.createDraft(CREDS, { title: 't', author: 'a', digest: 'd', html: '<p>h</p>', thumbMediaId: thumb });
  assert.equal(thumb, 'thumb_1');
  assert.equal(draft, 'draft_1');
  // token 只取一次
  assert.equal(calls.filter(call => call.url.includes('/cgi-bin/token')).length, 1);
  assert.equal(calls.filter(call => call.url.includes('type=image')).length, 1);
  assert.equal(calls.filter(call => call.url.includes('/cgi-bin/draft/add')).length, 1);
});

test('an expired cached token is refreshed', async () => {
  let clock = 1_000_000;
  const { impl, calls } = stubFetch([
    () => json({ access_token: 'tok_1', expires_in: 7200 }),
    () => json({ media_id: 'thumb_1' }),
    () => json({ access_token: 'tok_2', expires_in: 7200 }),
    () => json({ media_id: 'thumb_2' })
  ]);
  const client = new WeChatClient(impl, () => clock);
  await client.uploadThumb(CREDS, { bytes: Buffer.from('x'), filename: 'c.png', contentType: 'image/png' });
  clock += 7200 * 1000;
  await client.uploadThumb(CREDS, { bytes: Buffer.from('x'), filename: 'c.png', contentType: 'image/png' });
  assert.equal(calls.filter(call => call.url.includes('/cgi-bin/token')).length, 2);
  assert.equal(calls.filter(call => call.url.includes('tok_1')).length, 1);
  assert.equal(calls.filter(call => call.url.includes('tok_2')).length, 1);
});

test('WeChat error codes surface even though HTTP status is 200', async () => {
  const { impl } = stubFetch([() => json({ errcode: 40164, errmsg: 'invalid ip' })]);
  const client = new WeChatClient(impl, () => 0);
  await assert.rejects(() => client.uploadThumb(CREDS, { bytes: Buffer.from('x'), filename: 'c.png', contentType: 'image/png' }), (error: unknown) => {
    assert.ok(error instanceof WeChatError);
    assert.equal(error.errcode, 40164);
    assert.match(error.message, /invalid ip/);
    return true;
  });
});

test('an invalid token triggers one refresh and retry', async () => {
  const { impl, calls } = stubFetch([
    () => json({ access_token: 'tok_stale', expires_in: 7200 }),
    () => json({ errcode: 40001, errmsg: 'invalid credential' }),
    () => json({ access_token: 'tok_fresh', expires_in: 7200 }),
    () => json({ media_id: 'draft_ok' })
  ]);
  const client = new WeChatClient(impl, () => 0);
  const mediaId = await client.createDraft(CREDS, { title: 't', author: 'a', digest: 'd', html: '<p>h</p>', thumbMediaId: 'thumb' });
  assert.equal(mediaId, 'draft_ok');
  assert.equal(calls.filter(call => call.url.includes('/cgi-bin/token')).length, 2);
  assert.equal(calls.filter(call => call.url.includes('/cgi-bin/draft/add')).length, 2);
});

test('a missing media_id is treated as a failure', async () => {
  const { impl } = stubFetch([() => json({ access_token: 'tok', expires_in: 7200 }), () => json({ ok: true })]);
  const client = new WeChatClient(impl, () => 0);
  await assert.rejects(() => client.createDraft(CREDS, { title: 't', author: 'a', digest: 'd', html: '<p>h</p>', thumbMediaId: 'thumb' }), /media_id/);
});

test('draft body keeps Chinese characters unescaped', async () => {
  const { impl, calls } = stubFetch([
    () => json({ access_token: 'tok', expires_in: 7200 }),
    () => json({ media_id: 'draft_1' })
  ]);
  const client = new WeChatClient(impl, () => 0);
  await client.createDraft(CREDS, { title: '柚子与降压药', author: '李医生', digest: '先给结论', html: '<p>正文中文</p>', thumbMediaId: 'thumb' });
  const draftCall = calls.find(call => call.url.includes('/cgi-bin/draft/add'));
  const body = String(draftCall?.init?.body ?? '');
  assert.match(body, /柚子与降压药/);
  assert.match(body, /正文中文/);
  assert.match(body, /thumb_media_id/);
  // 一旦被转成 \\uXXXX，微信会把转义序列当正文存储
  assert.doesNotMatch(body, /\\u6709/);
});

test('uploadThumb sends a multipart media field', async () => {
  const { impl, calls } = stubFetch([() => json({ access_token: 'tok', expires_in: 7200 }), () => json({ media_id: 'thumb_1' })]);
  const client = new WeChatClient(impl, () => 0);
  await client.uploadThumb(CREDS, { bytes: Buffer.from('png-bytes'), filename: 'cover.png', contentType: 'image/png' });
  const upload = calls.find(call => call.url.includes('type=image'));
  assert.ok(upload?.init?.body instanceof FormData);
  const form = upload.init.body as FormData;
  assert.ok(form.get('media'));
  assert.equal((upload.init.headers as Record<string, string> | undefined)?.Authorization, undefined);
});

test('uploadArticleImage posts to uploadimg and returns the hosted url', async () => {
  const { impl, calls } = stubFetch([() => json({ access_token: 'tok', expires_in: 7200 }), () => json({ url: 'https://mmbiz.qpic.cn/inline.png' })]);
  const client = new WeChatClient(impl, () => 0);
  const url = await client.uploadArticleImage(CREDS, { bytes: Buffer.from('png-bytes'), filename: 'inline.png', contentType: 'image/png' });
  assert.equal(url, 'https://mmbiz.qpic.cn/inline.png');
  const upload = calls.find(call => call.url.includes('/cgi-bin/media/uploadimg'));
  assert.ok(upload);
  assert.ok(upload.init?.body instanceof FormData);
  assert.ok((upload.init.body as FormData).get('media'));
});

test('a missing uploadimg url is treated as a failure', async () => {
  const { impl } = stubFetch([() => json({ access_token: 'tok', expires_in: 7200 }), () => json({})]);
  const client = new WeChatClient(impl, () => 0);
  await assert.rejects(() => client.uploadArticleImage(CREDS, { bytes: Buffer.from('x'), filename: 'a.png', contentType: 'image/png' }), /正文图片地址/);
});

test('missing credentials fail before any network call', async () => {
  const { impl, calls } = stubFetch([() => json({})]);
  const client = new WeChatClient(impl, () => 0);
  await assert.rejects(() => client.accessToken({ appid: '', secret: 'x' }), /AppID/);
  await assert.rejects(() => client.accessToken({ appid: 'x', secret: '' }), /AppSecret/);
  assert.equal(calls.length, 0);
});
