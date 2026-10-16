import { useCallback, useEffect, useRef, useState } from 'react';
import type { XhsHotNote, XhsViewState } from '../../shared';
import { XHS_PUBLISH_URL } from '../../services/xhs-catalog';
import { Icon, readableError, visibleStageBounds } from '../ui';
import type { AuditPrefill } from './AuditTab';
import { useBusy, type XhsContext } from './common';

/**
 * 应用内的小红书窗口：你自己登录、自己浏览，需要时点「读取当前页面」。
 * 搜索结果 / 发现页 → 交给「热点选题」；博主主页 → 交给「账号诊断」。
 * 只读页面上已经显示出来的内容：不自动滚动、不翻页、不调接口；遇到验证或登录墙会停下来交给你。
 */
export function BrowserTab({ ctx, overlay, publishNonce = 0, onNotes, onProfile }: {
  ctx: XhsContext; overlay: boolean;
  /** 从「发布包」点过来时变化一次：打开窗口后直接跳到发布页。 */
  publishNonce?: number;
  onNotes: (notes: XhsHotNote[], url: string) => void;
  onProfile: (prefill: AuditPrefill) => void;
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
  const refresh = useCallback(() => void window.sydney.getXhsView().then(setState).catch(() => undefined), []);
  useEffect(() => window.sydney.onXhsViewChanged(refresh), [refresh]);

  useEffect(() => {
    if (overlay) { void window.sydney.closeXhsView(); return; }
    void window.sydney.openXhsView(accountId).then(setState).catch(error => notify(readableError(error)));
    const report = () => void window.sydney.setXhsViewBounds(readStage());
    report();
    const observer = new ResizeObserver(report);
    if (stageRef.current) observer.observe(stageRef.current);
    window.addEventListener('resize', report);
    window.addEventListener('scroll', report, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
      window.removeEventListener('scroll', report, true);
      void window.sydney.closeXhsView();
    };
  }, [overlay, readStage, notify, accountId]);

  // 放在挂载视图的 effect 之后：IPC 按顺序处理，视图先挂上再跳转。
  useEffect(() => {
    if (!publishNonce) return;
    void window.sydney.navigateXhsView({ kind: 'publish' }).then(setState).catch(error => notify(readableError(error)));
  }, [publishNonce, notify]);

  const onCreator = Boolean(state?.url && /^https:\/\/creator\.xiaohongshu\.com\//.test(state.url));
  const navigate = (kind: 'home' | 'search' | 'publish') => run('nav', async () => setState(await window.sydney.navigateXhsView({ kind, value: keyword })));
  const go = (action: 'back' | 'reload') => run('nav', async () => setState(await window.sydney.xhsViewGo(action)));
  const read = () => run('read', async () => {
    const page = await window.sydney.readXhsView();
    if (page.profile) {
      onProfile({
        name: page.profile.name, bio: page.profile.bio, fans: page.profile.fans, follows: page.profile.follows, likesAndCollects: page.profile.likesAndCollects,
        notesText: page.notes.map(note => `${note.title} | ${note.liked} | 0 | 0 |`).join('\n')
      });
      notify(page.notes.length
        ? `读到主页「${page.profile.name}」和 ${page.notes.length} 篇笔记，已填入账号诊断（收藏、评论、日期页面上没有，需要可以手动补）`
        : `读到主页「${page.profile.name}」，但笔记列表还没加载出来：等页面上出现笔记后再读一次`);
    } else {
      onNotes(page.notes, page.url);
      notify(`读到 ${page.notes.length} 篇笔记，已放到「热点选题」`);
    }
  });

  return <div className="xhs-browser">
    <div className="site-bar xhs-browser-bar">
      <button className="icon-button" title="后退" disabled={locked || !state?.canGoBack} onClick={() => void go('back')}><Icon name="undo" /></button>
      <button className="icon-button" title="刷新" disabled={locked} onClick={() => void go('reload')}><Icon name="refresh" /></button>
      <button className="button button-quiet" disabled={locked} onClick={() => void navigate('home')}>发现页</button>
      <button className="button button-quiet" disabled={locked} title="打开网页版创作者中心的图文发布页" onClick={() => void navigate('publish')}>发布页</button>
      <button className="button button-quiet" title="用系统浏览器打开创作者中心发布页：窗口里登录不上或被要求验证时用这个" onClick={() => void window.sydney.openXhsLink(XHS_PUBLISH_URL).catch(error => notify(readableError(error)))}><Icon name="window" size={14} />在浏览器打开发布页</button>
      <form className="xhs-search" onSubmit={event => { event.preventDefault(); void navigate('search'); }}>
        <input className="input" value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="在小红书里搜索（需要你在窗口里登录）" />
        <button className="button button-secondary" type="submit" disabled={locked || !keyword.trim()}><Icon name="search" />搜索</button>
      </form>
      <button className="button button-primary" disabled={locked || !state?.url} onClick={() => void read()}>{busy === 'read' ? '读取中…' : '读取当前页面'}</button>
    </div>
    <p className="xhs-hint">{state?.loading ? '页面加载中…' : state?.title || '小红书'} {state?.url && <code className="path">{state.url.slice(0, 90)}</code>}</p>
    {onCreator && <p className="xhs-hint">创作者中心：把发布包目录里的 01、02… 按顺序拖进上传区（或点上传区选文件），标题和正文在「笔记创作 → 发布包」里一键复制。填好后由你自己确认并点发布，应用不会代填或代点。</p>}
    {state?.error && <p className="xhs-hint xhs-hint-warn"><Icon name="alert" size={14} />{state.error}</p>}
    <div ref={stageRef} className="site-stage xhs-stage">
      <p className="site-stage-hint">{overlay ? '有弹窗打开时，小红书窗口先收起来。' : '正在打开小红书…'}</p>
    </div>
    <p className="ww-muted">登录在窗口里由你自己完成，每个账号各有一份独立的登录状态（当前：{ctx.account.name}），切换账号不用退出重登；应用不读取账号密码。「读取」只读当前已经显示的内容，不会自动滚动或翻页；频繁读取可能触发平台风控，请像正常浏览一样使用。</p>
  </div>;
}
