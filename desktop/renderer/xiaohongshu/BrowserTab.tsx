import { useCallback, useEffect, useRef, useState } from 'react';
import type { XhsHotNote, XhsViewState } from '../../shared';
import { Icon, readableError, visibleStageBounds } from '../ui';
import type { AuditPrefill } from './AuditTab';
import { useBusy, type XhsContext } from './common';

/**
 * 应用内的小红书窗口：你自己登录、自己浏览，需要时点「读取当前页面」。
 * 搜索结果 / 发现页 → 交给「热点选题」；博主主页 → 交给「账号诊断」。
 * 只读页面上已经显示出来的内容：不自动滚动、不翻页、不调接口；遇到验证或登录墙会停下来交给你。
 */
export function BrowserTab({ ctx, overlay, onNotes, onProfile }: {
  ctx: XhsContext; overlay: boolean;
  onNotes: (accountId: number, notes: XhsHotNote[], url: string) => void;
  onProfile: (accountId: number, prefill: AuditPrefill) => void;
}) {
  const { notify } = ctx;
  const accountId = ctx.account.id;
  const stageRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<XhsViewState | null>(null);
  const [keyword, setKeyword] = useState('');
  const { busy, run, locked } = useBusy(notify);

  const readStage = useCallback(() => {
    return visibleStageBounds(stageRef.current);
  }, []);
  const applyState = useCallback((next: XhsViewState) => {
    // 主进程事件和 IPC 回包都可能晚于账号切换：只接受当前账号的窗口状态。
    if (next.accountId === accountId) setState(next);
  }, [accountId]);
  const refresh = useCallback(() => {
    void window.sydney.getXhsView(accountId).then(applyState).catch(() => undefined);
  }, [accountId, applyState]);
  useEffect(() => window.sydney.onXhsViewChanged(changed => {
    if (changed === accountId) refresh();
  }), [accountId, refresh]);

  useEffect(() => {
    let alive = true;
    if (overlay) { void window.sydney.closeXhsView(accountId); return; }
    void window.sydney.openXhsView(accountId).then(next => { if (alive) applyState(next); }).catch(error => { if (alive) notify(readableError(error)); });
    const report = () => { if (alive) void window.sydney.setXhsViewBounds(accountId, readStage()).catch(() => undefined); };
    report();
    const observer = new ResizeObserver(report);
    if (stageRef.current) observer.observe(stageRef.current);
    window.addEventListener('resize', report);
    window.addEventListener('scroll', report, true);
    return () => {
      alive = false;
      observer.disconnect();
      window.removeEventListener('resize', report);
      window.removeEventListener('scroll', report, true);
      void window.sydney.closeXhsView(accountId).catch(() => undefined);
    };
  }, [overlay, readStage, notify, accountId, applyState]);

  const onCreator = Boolean(state?.url && /^https:\/\/creator\.xiaohongshu\.com\//.test(state.url));
  const navigate = (kind: 'home' | 'search' | 'publish') => run('nav', async () => applyState(await window.sydney.navigateXhsView(accountId, { kind, value: keyword })));
  const go = (action: 'back' | 'reload') => run('nav', async () => applyState(await window.sydney.xhsViewGo(accountId, action)));
  const read = () => run('read', async () => {
    const page = await window.sydney.readXhsView(accountId);
    if (page.accountId !== accountId) return;
    if (page.profile) {
      onProfile(accountId, {
        name: page.profile.name, bio: page.profile.bio, fans: page.profile.fans, follows: page.profile.follows, likesAndCollects: page.profile.likesAndCollects,
        notesText: page.notes.map(note => `${note.title} | ${note.liked} | 0 | 0 |`).join('\n')
      });
      notify(page.notes.length
        ? `读到主页「${page.profile.name}」和 ${page.notes.length} 篇笔记，已填入账号诊断（收藏、评论、日期页面上没有，需要可以手动补）`
        : `读到主页「${page.profile.name}」，但笔记列表还没加载出来：等页面上出现笔记后再读一次`);
    } else {
      onNotes(accountId, page.notes, page.url);
      notify(`读到 ${page.notes.length} 篇笔记，已放到「热点选题」`);
    }
  });

  return <div className="xhs-browser">
    <div className="site-bar xhs-browser-bar">
      <button className="icon-button" title="后退" disabled={locked || !state?.canGoBack} onClick={() => void go('back')}><Icon name="undo" /></button>
      <button className="icon-button" title="刷新" disabled={locked} onClick={() => void go('reload')}><Icon name="refresh" /></button>
      <button className="button button-quiet" disabled={locked} onClick={() => void navigate('home')}>发现页</button>
      <button className="button button-quiet" disabled={locked} title="打开网页版创作者中心的图文发布页" onClick={() => void navigate('publish')}>发布页</button>
      <form className="xhs-search" onSubmit={event => { event.preventDefault(); void navigate('search'); }}>
        <input className="input" value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="在小红书里搜索（需要你在窗口里登录）" />
        <button className="button button-secondary" type="submit" disabled={locked || !keyword.trim()}><Icon name="search" />搜索</button>
      </form>
      <button className="button button-primary" disabled={locked || !state?.url} onClick={() => void read()}>{busy === 'read' ? '读取中…' : '读取当前页面'}</button>
    </div>
    <p className="xhs-hint">{state?.loading ? '页面加载中…' : state?.title || '小红书'} {state?.url && <code className="path">{state.url.slice(0, 90)}</code>}</p>
    {onCreator && <p className="xhs-hint">创作者中心：从「笔记创作 → 发布包」点「填入小红书草稿」，应用会按发布顺序上传图片并填写标题、正文和标签；请检查内容后由你自己点击发布，应用不会代点。</p>}
    {state?.error && <p className="xhs-hint xhs-hint-warn"><Icon name="alert" size={14} />{state.error}</p>}
    <div ref={stageRef} className="site-stage xhs-stage">
      <p className="site-stage-hint">{overlay ? '有弹窗打开时，小红书窗口先收起来。' : '正在打开小红书…'}</p>
    </div>
    <p className="ww-muted">登录在窗口里由你自己完成，每个账号各有一份独立的登录状态（当前：{ctx.account.name}），切换账号不用退出重登；应用不读取账号密码。「读取」只读当前已经显示的内容，不会自动滚动或翻页；频繁读取可能触发平台风控，请像正常浏览一样使用。</p>
  </div>;
}
