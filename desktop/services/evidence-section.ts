import type { ContentTask } from '../shared.ts';
import { FEATURED_SOURCE_LIMIT, parseContentSources, pickFeaturedSources, type ContentSourceRecord } from './content-sources.ts';

/**
 * 正文末尾的「来源与证据」块。
 *
 * 预览、推送草稿箱、导出到知识库共用这一份渲染，三处看到的是同一段话；
 * 追加发生在渲染时而不是写进 draft——否则改一次来源就会让已通过的审稿失效。
 */

export type EvidenceClaim = { claim: string; evidenceNeeded: string; searchQueries: string[]; risk: string };

/** 容错读取证据计划：JSON 坏了就当作没有，不让预览与推送整体失败。 */
export function readEvidenceClaims(claimsJson: string): EvidenceClaim[] {
  if (!claimsJson.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(claimsJson); } catch { return []; }
  const list = (parsed as { claims?: unknown } | null)?.claims;
  if (!Array.isArray(list)) return [];
  return list.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const claim = typeof record.claim === 'string' ? record.claim.trim() : '';
    if (!claim) return [];
    return [{
      claim,
      evidenceNeeded: typeof record.evidence_needed === 'string' ? record.evidence_needed.trim() : '',
      searchQueries: Array.isArray(record.search_queries) ? record.search_queries.map(item => String(item).trim()).filter(Boolean) : [],
      risk: typeof record.risk === 'string' ? record.risk.trim() : ''
    }];
  });
}

const HEADING = '## 来源与证据';

/**
 * 生成追加到正文末尾的 Markdown 片段；没有内容时返回空串。
 * 只用 renderWeChatHtml 支持的那几种语法（标题、粗体、有序/无序列表、引用），保证三处渲染一致。
 *
 * withClaims 默认 false：正文发出去给人看的是「参考资料」；
 * 「待核实主张」是内部核对清单（带检索词与风险），只在导出到知识库的笔记里保留。
 * allSources 默认 false：读者只看精选的 FEATURED_SOURCE_LIMIT 条（见 pickFeaturedSources）；知识库笔记保留全部来源。
 */
export function renderEvidenceSection(task: Pick<ContentTask, 'sourcesJson' | 'claimsJson'>, options: { withClaims?: boolean; allSources?: boolean } = {}): string {
  // 来源记录理论上在保存时已校验；预览与推送不该因为一条脏数据整体打不开，所以这里容错。
  let sources: ContentSourceRecord[] = [];
  try { sources = parseContentSources(task.sourcesJson); } catch { sources = []; }
  if (!options.allSources) sources = pickFeaturedSources(sources, FEATURED_SOURCE_LIMIT);
  const claims = options.withClaims ? readEvidenceClaims(task.claimsJson) : [];
  if (!sources.length && !claims.length) return '';
  const blocks: string[] = [HEADING];
  if (sources.length) {
    blocks.push('**参考资料**', '');
    sources.forEach((source, index) => {
      const name = source.title.trim() || '用户提供的资料';
      blocks.push(`${index + 1}. ${name}${source.url.trim() ? ` —— ${source.url.trim()}` : ''}`);
      // 摘录单独一行引用，微信排版里会显示成引用块，不会被当成正文主张。
      // AI 推荐的来源只有模型概括的要点、不是原文，所以不能叫「摘录」。
      if (source.excerpt.trim()) blocks.push(`> ${source.status === 'ai_suggested' ? '要点' : '摘录'}：${source.excerpt.trim().replace(/\s*\n+\s*/g, ' ')}`);
    });
    blocks.push('', sources.some(source => source.status === 'ai_suggested')
      ? '> 以上资料由 AI 根据公开权威文献整理，未逐条联网核实，仅供延伸阅读，不能替代医生的诊疗建议。'
      : '> 来源为作者提供，未自动联网核实。');
  }
  if (claims.length) {
    blocks.push('', '**待核实主张**', '');
    claims.forEach(claim => {
      const details = [
        claim.evidenceNeeded ? `需要的证据：${claim.evidenceNeeded}` : '',
        claim.searchQueries.length ? `检索词：${claim.searchQueries.join('、')}` : '',
        claim.risk ? `风险：${claim.risk}` : ''
      ].filter(Boolean).join('；');
      blocks.push(`- ${claim.claim}${details ? `（${details}）` : ''}`);
    });
  }
  return blocks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 把来源与证据追加到正文末尾。
 * 正文里已经自己写了这一段（手写或模型写的）就不再追加，避免重复两遍。
 */
export function appendEvidenceSection(markdown: string, task: Pick<ContentTask, 'sourcesJson' | 'claimsJson'>, options: { withClaims?: boolean; allSources?: boolean } = {}): string {
  const section = renderEvidenceSection(task, options);
  if (!section) return markdown;
  if (new RegExp(`\\n\\s*${HEADING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n`).test(markdown)) return markdown;
  return `${markdown.trimEnd()}\n\n${section}\n`;
}
