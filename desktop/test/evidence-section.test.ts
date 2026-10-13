import test from 'node:test';
import assert from 'node:assert/strict';
import { appendEvidenceSection, readEvidenceClaims, renderEvidenceSection } from '../services/evidence-section.ts';
import { renderWeChatHtml } from '../services/article-html.ts';

const sources = JSON.stringify({ sources: [
  { title: '中国居民膳食指南（2022）', url: 'https://example.org/guide', excerpt: '每天的蔬菜摄入建议。', status: 'user_provided' },
  { title: '只有标题的来源', url: '', excerpt: '', status: 'user_provided' }
] });
const claims = JSON.stringify({ claims: [
  { claim: '柚子会影响部分药物代谢', evidence_needed: '药代动力学研究', search_queries: ['柚子 CYP3A4'], tier: 'unverified', risk: '可能被读成停药建议' }
] });

test('来源与证据块：来源与摘录默认都在，待核实主张只在导出时带上', () => {
  const section = renderEvidenceSection({ sourcesJson: sources, claimsJson: claims });
  assert.match(section, /^## 来源与证据/);
  assert.match(section, /1\. 中国居民膳食指南（2022） —— https:\/\/example\.org\/guide/);
  assert.match(section, /> 摘录：每天的蔬菜摄入建议。/);
  assert.match(section, /2\. 只有标题的来源/);
  assert.match(section, /未自动联网核实/);
  // 发给读者的正文不带内部核对清单
  assert.doesNotMatch(section, /待核实主张/);
  assert.doesNotMatch(section, /检索词/);

  const internal = renderEvidenceSection({ sourcesJson: sources, claimsJson: claims }, { withClaims: true });
  assert.match(internal, /\*\*待核实主张\*\*/);
  assert.match(internal, /- 柚子会影响部分药物代谢（需要的证据：药代动力学研究；检索词：柚子 CYP3A4；风险：可能被读成停药建议）/);
});

test('追加到正文末尾：正文不动，只在末尾补一段；重复调用不会追加两遍', () => {
  const article = '# 柚子怎么吃\n\n正文内容。';
  const once = appendEvidenceSection(article, { sourcesJson: sources, claimsJson: claims });
  assert.ok(once.startsWith(article));
  assert.equal(once.split('## 来源与证据').length - 1, 1);
  assert.equal(appendEvidenceSection(once, { sourcesJson: sources, claimsJson: claims }), once);
});

test('没有来源也没有主张时不动正文', () => {
  assert.equal(renderEvidenceSection({ sourcesJson: '', claimsJson: '' }), '');
  assert.equal(appendEvidenceSection('正文', { sourcesJson: '', claimsJson: '' }), '正文');
  assert.equal(appendEvidenceSection('正文', { sourcesJson: '{"sources":[]}', claimsJson: '{"claims":[]}' }), '正文');
});

test('脏数据不炸：来源或证据的 JSON 坏掉都按空处理', () => {
  assert.deepEqual(readEvidenceClaims('不是 JSON'), []);
  assert.deepEqual(readEvidenceClaims('{"claims":[{}]}'), []);
  assert.equal(appendEvidenceSection('正文', { sourcesJson: '不是 JSON', claimsJson: '也不是' }), '正文');
});

test('公众号渲染里能看到这一段，且外链不会变成 a 标签', () => {
  const html = renderWeChatHtml(appendEvidenceSection('# 标题\n\n正文。', { sourcesJson: sources, claimsJson: claims }), { theme: 'professional-clean' });
  assert.match(html, /来源与证据/);
  assert.match(html, /中国居民膳食指南/);
  assert.doesNotMatch(html, /待核实主张/);
  assert.doesNotMatch(html, /<a /);
});

const many = (marks: boolean[], urls = marks.map(() => true)) => JSON.stringify({ sources: marks.map((featured, i) => ({ title: `来源${i + 1}`, url: urls[i] ? `https://example.org/${i + 1}` : '', excerpt: '', featured })) });

test('正文末尾只列3条：优先用户勾选的，不足时按有链接优先补齐，导出保留全部', () => {
  // 勾了第2、5条：再补第1条（有链接、录入最早），按录入顺序编号
  const picked = renderEvidenceSection({ sourcesJson: many([false, true, false, false, true]), claimsJson: '' });
  assert.deepEqual(picked.match(/来源\d/g), ['来源1', '来源2', '来源5']);
  // 一条没勾：前三条里第1条没链接，跳过它补第4条
  const auto = renderEvidenceSection({ sourcesJson: many([false, false, false, false], [false, true, true, true]), claimsJson: '' });
  assert.deepEqual(auto.match(/来源\d/g), ['来源2', '来源3', '来源4']);
  // 勾选超过3条（手改数据）也只取前3条
  const over = renderEvidenceSection({ sourcesJson: many([true, true, true, true]), claimsJson: '' });
  assert.deepEqual(over.match(/来源\d/g), ['来源1', '来源2', '来源3']);
  const all = renderEvidenceSection({ sourcesJson: many([false, true, false, false, true]), claimsJson: '' }, { allSources: true });
  assert.equal(all.match(/来源\d/g)?.length, 5);
});

test('AI 推荐的来源在文末写「要点」并注明未联网核实', () => {
  const section = renderEvidenceSection({ sourcesJson: JSON.stringify({ sources: [{ title: '中国营养学会《膳食指南》', url: '', excerpt: '蔬菜摄入建议', status: 'ai_suggested' }] }), claimsJson: '' });
  assert.match(section, /> 要点：蔬菜摄入建议/);
  assert.match(section, /AI 根据公开权威文献整理，未逐条联网核实/);
  assert.doesNotMatch(section, /摘录/);
});
