import type { ContentDirectionInput, ContentProfileFields, ContentTaxonomy } from '../../shared';

export type SubRow = { key: string; id?: number; name: string; note: string; imagePrompt: string };
export type ProfileRow = Omit<ContentProfileFields, 'blacklistWords' | 'blacklistTopics'> & {
  key: string; id?: number; name: string; note: string; imagePrompt: string; subs: SubRow[];
  /** 禁忌词/话题在编辑时按多行文本保存，保存时再拆成列表，避免边打字边被去空行。 */
  wordsText: string; topicsText: string;
};
export type ModuleKey = 'basic' | 'audience' | 'template' | 'image' | 'subs' | 'compliance' | 'global';

export const MODULES: Array<{ key: ModuleKey; label: string }> = [
  { key: 'basic', label: '基本资料' },
  { key: 'audience', label: '读者定位' },
  { key: 'template', label: '模板设置' },
  { key: 'image', label: '配图模板' },
  { key: 'subs', label: '具体方向' },
  { key: 'compliance', label: '合规禁忌' },
  { key: 'global', label: '全局服务' }
];

let uid = 0;
export const nextKey = () => `row-${uid++}`;
const lines = (text: string) => text.split(/\r?\n/).map(item => item.trim()).filter(Boolean);

export function toRows(taxonomy: ContentTaxonomy): ProfileRow[] {
  return taxonomy.directions.map(({ subdirections, blacklistWords, blacklistTopics, ...profile }) => ({
    ...profile,
    key: nextKey(),
    wordsText: blacklistWords.join('\n'),
    topicsText: blacklistTopics.join('\n'),
    subs: subdirections.map(sub => ({ key: nextKey(), id: sub.id, name: sub.name, note: sub.note, imagePrompt: sub.imagePrompt }))
  }));
}

export function toPayload(rows: ProfileRow[]): ContentDirectionInput[] {
  return rows.map(({ key: _key, subs, wordsText, topicsText, id, ...profile }) => ({
    ...(id ? { id } : {}),
    ...profile,
    blacklistWords: lines(wordsText),
    blacklistTopics: lines(topicsText),
    subdirections: subs.map(sub => ({ ...(sub.id ? { id: sub.id } : {}), name: sub.name, note: sub.note, imagePrompt: sub.imagePrompt }))
  }));
}
