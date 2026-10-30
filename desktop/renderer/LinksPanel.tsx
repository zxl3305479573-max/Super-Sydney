import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LinkEntry, LinkInput } from '../shared';
import { ConfirmButton, EmptyState, Icon, Modal, ModuleToolbar, TagEditor, readableError, relativeTime } from './ui';

const blank: Required<LinkInput> = { url: '', title: '', note: '', tags: [] };

/**
 * 成长 · 链接收藏：把看到的好文章、工具、教程地址随手存下来，打标签、写一句为什么存。
 * 只存地址和备注，不抓网页内容；打开交给系统浏览器。
 */
export default function LinksPanel({ notify }: { notify: (message: string) => void }) {
  const [links, setLinks] = useState<LinkEntry[]>([]);
  const [draft, setDraft] = useState<Required<LinkInput>>(blank);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [editing, setEditing] = useState<LinkEntry | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => setLinks(await window.sydney.listLinks()), []);
  useEffect(() => { void refresh(); }, [refresh]);

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const link of links) for (const item of link.tags) counts.set(item, (counts.get(item) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'));
  }, [links]);
  // 筛选用的标签被删光以后自动回到「全部」，不留一个空列表。
  useEffect(() => { if (tag && !tagCounts.some(([name]) => name === tag)) setTag(''); }, [tag, tagCounts]);

  const visible = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return links.filter(link => {
      if (tag && !link.tags.includes(tag)) return false;
      const haystack = `${link.title}\n${link.url}\n${link.note}\n${link.tags.join(' ')}`.toLowerCase();
      return words.every(word => haystack.includes(word));
    });
  }, [links, query, tag]);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await window.sydney.createLink(draft);
      setDraft(blank);
      await refresh();
      notify('链接已收藏');
    } catch (error) {
      notify(readableError(error));
    } finally {
      setSaving(false);
    }
  };

  const open = async (link: LinkEntry) => {
    try {
      const next = await window.sydney.openLink(link.id);
      setLinks(current => current.map(item => (item.id === next.id ? next : item)));
    } catch (error) {
      notify(readableError(error));
    }
  };

  const copy = async (link: LinkEntry) => {
    try {
      await navigator.clipboard.writeText(link.url);
      notify('链接已复制');
    } catch (error) {
      notify(`复制失败：${readableError(error)}`);
    }
  };

  const remove = async (link: LinkEntry) => {
    try {
      await window.sydney.deleteLink(link.id);
      await refresh();
      notify('链接已删除');
    } catch (error) {
      notify(readableError(error));
    }
  };

  return <div className="view links">
    <section className="panel">
      <ModuleToolbar className="panel-head" label="收藏链接">
        <div className="panel-title"><h2>收藏一个链接</h2><p>只存地址、标题和你写的备注，不抓网页内容。同一个地址只会收藏一次。</p></div>
      </ModuleToolbar>
      <form className="links-form" onSubmit={event => void add(event)}>
        <div className="links-form-row">
          <label className="field field-grow"><span>链接地址</span>
            <input className="input" value={draft.url} onChange={event => setDraft({ ...draft, url: event.target.value })} placeholder="https://…" autoFocus /></label>
          <label className="field links-title-field"><span>标题</span>
            <input className="input" value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} placeholder="留空按域名" /></label>
        </div>
        <div className="links-form-row">
          <div className="field links-tags-field"><span>标签</span>
            <TagEditor values={draft.tags} onChange={tags => setDraft({ ...draft, tags })} placeholder="回车添加，如 AI 工具、教程" /></div>
          <label className="field field-grow"><span>备注</span>
            <input className="input" value={draft.note} onChange={event => setDraft({ ...draft, note: event.target.value })} placeholder="为什么存它、打算拿来做什么" /></label>
          <button className="button button-primary links-submit" type="submit" disabled={saving || !draft.url.trim()}><Icon name="plus" />{saving ? '保存中…' : '收藏'}</button>
        </div>
      </form>
    </section>

    <section className="panel">
      <ModuleToolbar className="panel-head" label="收藏筛选">
        <div className="panel-title"><h2>我的收藏<span className="segmented-count">{links.length}</span></h2></div>
        <label className="search"><Icon name="search" />
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜标题、地址、备注或标签" aria-label="搜索收藏" />
          {query && <button type="button" aria-label="清空搜索" onClick={() => setQuery('')}><Icon name="x" size={12} /></button>}
        </label>
      </ModuleToolbar>
      {tagCounts.length > 0 && <div className="links-filter" role="group" aria-label="按标签筛选">
        <button type="button" className={`chip ${tag ? '' : 'chip-accent'}`} onClick={() => setTag('')}>全部 {links.length}</button>
        {tagCounts.map(([name, count]) => <button key={name} type="button" className={`chip ${tag === name ? 'chip-accent' : ''}`} onClick={() => setTag(tag === name ? '' : name)}>{name} {count}</button>)}
      </div>}
      {visible.length ? <ul className="links-list">
        {visible.map(link => <li key={link.id} className="links-item">
          <div className="links-main">
            <button type="button" className="links-title" title={link.url} onClick={() => void open(link)}>{link.title}</button>
            <span className="links-url">{link.url}</span>
            {link.note && <p className="links-note">{link.note}</p>}
            <div className="links-meta">
              {link.tags.map(item => <button key={item} type="button" className="chip chip-soft" onClick={() => setTag(item)}>{item}</button>)}
              <small>收藏于 {relativeTime(link.createdAt)} · {link.openedAt ? `上次打开 ${relativeTime(link.openedAt)}` : '还没打开过'}</small>
            </div>
          </div>
          <div className="links-actions">
            <button type="button" className="icon-button" title="在浏览器打开" aria-label="在浏览器打开" onClick={() => void open(link)}><Icon name="window" /></button>
            <button type="button" className="icon-button" title="复制链接" aria-label="复制链接" onClick={() => void copy(link)}><Icon name="link" /></button>
            <button type="button" className="icon-button" title="编辑" aria-label="编辑" onClick={() => setEditing(link)}><Icon name="pen" /></button>
            <ConfirmButton className="button button-danger-quiet button-small" armedLabel="确认删除" title="删除这条收藏" onConfirm={() => void remove(link)}><Icon name="trash" size={14} /></ConfirmButton>
          </div>
        </li>)}
      </ul> : links.length
        ? <EmptyState icon="search" title="没有匹配的收藏">换个关键词，或者点「全部」看所有收藏。</EmptyState>
        : <EmptyState icon="link" title="还没有收藏">把链接贴到上面，打几个标签，以后按标签或关键词就能找回来。</EmptyState>}
    </section>

    <LinkEditor link={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await refresh(); notify('收藏已更新'); }} />
  </div>;
}

function LinkEditor({ link, onClose, onSaved }: { link: LinkEntry | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState<Required<LinkInput>>(blank);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (link) setForm({ url: link.url, title: link.title, note: link.note, tags: link.tags });
    setError('');
  }, [link]);

  const save = async () => {
    if (!link) return;
    setSaving(true);
    try {
      await window.sydney.updateLink(link.id, form);
      await onSaved();
    } catch (problem) {
      setError(readableError(problem));
    } finally {
      setSaving(false);
    }
  };

  return <Modal open={Boolean(link)} onClose={onClose} eyebrow="链接收藏" title="编辑收藏" width={560}
    footer={<><button type="button" className="button button-secondary" onClick={onClose}>取消</button>
      <button type="button" className="button button-primary" disabled={saving || !form.url.trim()} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button></>}>
    <div className="form-stack">
      <label className="field"><span>链接地址</span><input className="input" value={form.url} onChange={event => setForm({ ...form, url: event.target.value })} /></label>
      <label className="field"><span>标题</span><input className="input" value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} placeholder="留空按域名" /></label>
      <div className="field"><span>标签</span><TagEditor values={form.tags} onChange={tags => setForm({ ...form, tags })} placeholder="回车添加" /></div>
      <label className="field"><span>备注</span><textarea className="input" rows={3} value={form.note} onChange={event => setForm({ ...form, note: event.target.value })} /></label>
      {error && <p className="site-error" role="alert"><Icon name="alert" size={14} /><span>{error}</span></p>}
    </div>
  </Modal>;
}
