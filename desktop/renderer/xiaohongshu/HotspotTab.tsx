import { useEffect, useState } from 'react';
import type { LlmKeyStatus, XhsHotNote, XhsHotspotResult, XhsHotspotSource, XhsTopicIdea } from '../../shared';
import { xhsNoteTypeLabel } from '../../services/xhs-catalog';
import { Icon, readableError, shortTime } from '../ui';
import { HotNoteRow, Section, adoptedIds, openLink, useBusy, type XhsContext } from './common';

/**
 * 热点选题：红狐（有 key）→ 联网搜索（必应）按优先级降级；小红书窗口里读到的笔记也在这里展示。
 * 都拿不到真实热度时，可以让模型按定位档案出选题建议（明确标注未经数据验证）。
 */

const DAY_OPTIONS = [3, 7, 14, 30];
const SIZE_OPTIONS = [10, 20, 50];
const SOURCE_OPTIONS: Array<{ value: XhsHotspotSource; label: string }> = [
  { value: 'auto', label: '自动（红狐优先）' }, { value: 'redfox', label: '只用红狐' }, { value: 'web', label: '只用联网搜索' }
];

function daysAgo(days: number): string {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function HotspotTab({ ctx, viewNotes, onClearViewNotes }: { ctx: XhsContext; viewNotes: { notes: XhsHotNote[]; url: string } | null; onClearViewNotes: () => void }) {
  const { account, notes, notify, openNote, goTo } = ctx;
  const [keyStatus, setKeyStatus] = useState<LlmKeyStatus | null>(null);
  const [keyword, setKeyword] = useState('');
  const [days, setDays] = useState(7);
  const [pageSize, setPageSize] = useState(20);
  const [source, setSource] = useState<XhsHotspotSource>('auto');
  const [result, setResult] = useState<XhsHotspotResult | null>(null);
  const [ideas, setIdeas] = useState<XhsTopicIdea[]>([]);
  const { busy, run, locked } = useBusy(notify);
  useEffect(() => { void window.sydney.getRedfoxKeyStatus().then(setKeyStatus).catch(() => setKeyStatus(null)); }, []);

  const search = (word = keyword, refresh = false) => run('search', async () => {
    setKeyword(word);
    setResult(await window.sydney.searchXhsHotspot({ keyword: word, startDate: daysAgo(days), pageSize, refresh, source }));
  });
  const adopt = async (note: XhsHotNote) => {
    try { const created = await window.sydney.createXhsNote(account.id, note.title, note); notify('已转为选题'); return created; }
    catch (error) { notify(readableError(error)); return null; }
  };
  const suggest = () => run('suggest', async () => setIdeas(await window.sydney.suggestXhsTopics(account.id, keyword)));
  const adoptIdea = (idea: XhsTopicIdea) => run(`idea:${idea.title}`, async () => {
    const created = await window.sydney.createXhsNote(account.id, idea.title, null);
    await window.sydney.updateXhsNote(created.accountId, created.id, { noteType: idea.noteType, material: idea.angle ? `切入角度（模型建议，未经数据验证）：${idea.angle}` : '' });
    notify('已转为选题');
  });
  const adopted = adoptedIds(notes);
  const topics = new Set(notes.map(note => note.topic.trim()));
  const keyMissing = keyStatus !== null && !keyStatus.configured;

  return <div className="xhs-grid">
    <Section title="热点选题" hint="红狐：每天 7 点更新昨日数据，覆盖近 30 天，互动数按区间模糊显示。没有红狐 Key 或红狐失败时自动改用联网搜索（没有互动数据）。">
      {keyMissing && <p className="xhs-hint"><Icon name="key" size={14} />还没有保存红狐 API Key（「隐私与设置 → 数据服务」），现在只能用联网搜索。</p>}
      <form className="xhs-search" onSubmit={event => { event.preventDefault(); void search(); }}>
        <input className="input" placeholder="关键词，例如：通勤穿搭、减脂餐；红狐可留空查全站热门" value={keyword} onChange={event => setKeyword(event.target.value)} />
        <select className="input" aria-label="数据源" value={source} onChange={event => setSource(event.target.value as XhsHotspotSource)}>{SOURCE_OPTIONS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
        <select className="input" aria-label="时间范围" value={days} onChange={event => setDays(Number(event.target.value))}>{DAY_OPTIONS.map(value => <option key={value} value={value}>近 {value} 天</option>)}</select>
        <select className="input" aria-label="条数" value={pageSize} onChange={event => setPageSize(Number(event.target.value))}>{SIZE_OPTIONS.map(value => <option key={value} value={value}>{value} 条</option>)}</select>
        <button className="button button-primary" type="submit" disabled={locked}><Icon name="search" />{busy === 'search' ? '查询中…' : '搜索'}</button>
      </form>

      {result && <div className="xhs-result">
        {result.notice && <p className="xhs-hint xhs-hint-warn"><Icon name="alert" size={14} />{result.notice}</p>}
        <p className="xhs-result-meta">
          <span className={`chip ${result.source === 'redfox' ? 'chip-accent' : ''}`}>{result.source === 'redfox' ? '红狐' : '联网搜索'}</span>
          「{result.keyword || '全站热门'}」共 {result.total} 条，显示 {result.notes.length} 条 · {result.cached ? `缓存于 ${shortTime(result.fetchedAt)}` : `查询于 ${shortTime(result.fetchedAt)}`}
          {result.cached && <button className="button button-quiet" disabled={locked} onClick={() => void search(result.keyword, true)}><Icon name="refresh" />重新查询</button>}
        </p>
        {result.tips && <p className="xhs-hint">{result.tips}</p>}
        {result.relatedSearches.length > 0 && <div className="xhs-chip-row"><span className="xhs-chip-label">相关搜索</span>{result.relatedSearches.slice(0, 10).map(item => <button key={item.keyword} className="chip" onClick={() => void search(item.keyword)}>{item.keyword}<small>{item.count}</small></button>)}</div>}
        {result.hotTopics.length > 0 && <div className="xhs-chip-row"><span className="xhs-chip-label">热门话题</span>{result.hotTopics.slice(0, 8).map(item => <span key={item.topic} className="chip chip-soft">#{item.topic}</span>)}</div>}
        {result.notes.length
          ? <ul className="xhs-hot-list">{result.notes.map(note => <HotNoteRow key={note.id} note={note} adopted={adopted.has(note.id)} onAdopt={() => void adopt(note)} onOpen={() => openLink(note.link, notify)} />)}</ul>
          : <p className="empty-state"><strong>没有查到热门笔记</strong>换个关键词，或把时间范围放宽一些。</p>}
        {result.latest.length > 0 && result.notes.length < 5 && <>
          <h3 className="xhs-sub">近期热门参考</h3>
          <ul className="xhs-hot-list">{result.latest.slice(0, 10).map(note => <HotNoteRow key={note.id} note={note} adopted={adopted.has(note.id)} onAdopt={() => void adopt(note)} onOpen={() => openLink(note.link, notify)} />)}</ul>
        </>}
      </div>}
    </Section>

    {viewNotes && <Section title="小红书窗口里读到的笔记" hint={`来自 ${viewNotes.url}。只读了页面上已经显示的内容，点赞数是页面上显示的值。`}
      actions={<button className="button button-quiet" onClick={onClearViewNotes}>清除</button>}>
      <ul className="xhs-hot-list">{viewNotes.notes.map(note => <HotNoteRow key={note.id} note={note} adopted={adopted.has(note.id)} onAdopt={() => void adopt(note)} onOpen={() => openLink(note.link, notify)} />)}</ul>
    </Section>}

    <Section title="按定位出选题建议" hint="没有热度数据，或者想补充常青选题时用：模型按定位档案的内容支柱出 10 个选题。这是推断，未经互动数据验证。"
      actions={<button className="button button-secondary" disabled={locked} onClick={() => void suggest()}><Icon name="spark" />{busy === 'suggest' ? '生成中…' : ideas.length ? '换一批' : '出 10 个选题'}</button>}>
      {ideas.length ? <ul className="xhs-idea-list">{ideas.map(idea => {
        const done = topics.has(idea.title);
        return <li key={idea.title}>
          <div><strong>{idea.title}</strong><small>{[idea.pillar, xhsNoteTypeLabel(idea.noteType)].filter(Boolean).join(' · ')}</small>{idea.angle && <p>{idea.angle}</p>}{idea.why && <p className="ww-muted">{idea.why}</p>}</div>
          <button className="button button-secondary" disabled={done || locked} onClick={() => void adoptIdea(idea)}>{done ? '已转选题' : <><Icon name="plus" />转为选题</>}</button>
        </li>;
      })}</ul> : <p className="flow-empty">{account.positioningJson ? '点右上角出选题。' : '还没有定位档案，建议先做账号定位，选题会更贴合。'}</p>}
    </Section>

    {notes.length > 0 && <div className="flow-inline-actions"><button className="button button-quiet" onClick={() => goTo('notes')}>已有 {notes.length} 篇笔记任务，去创作 →</button>{notes[0] && <button className="button button-quiet" onClick={() => openNote(notes[0].id)}>继续最近的「{notes[0].topic.slice(0, 16)}」</button>}</div>}
  </div>;
}
