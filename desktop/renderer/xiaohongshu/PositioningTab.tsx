import { useEffect, useRef, useState } from 'react';
import type { XhsAccount } from '../../shared';
import { xhsNoteTypeLabel } from '../../services/xhs-catalog';
import { readPositioning, readPositioningChat } from '../../services/xhs-pipeline';
import { Icon } from '../ui';
import { Section, useBusy, type XhsContext } from './common';
import { IpPicker, useIpLibrary } from '../IpLibrary';

/**
 * 账号定位：引导式咨询。教练每轮问 1-3 个问题，信息够了直接出定位档案
 * （赛道、定位句、人设三件套、内容支柱、前 20 篇选题、冷启动路径），前 20 篇可一键转成笔记任务。
 */
export function PositioningTab({ ctx, onAccount }: { ctx: XhsContext; onAccount: (account: XhsAccount) => void }) {
  const { account, notes, notify, goTo } = ctx;
  const chat = readPositioningChat(account);
  const profile = readPositioning(account);
  const [answer, setAnswer] = useState('');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const { busy, run, locked } = useBusy(notify);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [chat.length]);

  const existing = new Set(notes.map(note => note.topic.trim()));
  const step = (finish: boolean) => run(finish ? 'finish' : 'step', async () => {
    const next = await window.sydney.stepXhsPositioning(account.id, answer, finish);
    onAccount(next);
    setAnswer('');
    const generated = readPositioning(next);
    if (generated && generated.generatedAt !== profile?.generatedAt) notify('定位档案已生成');
  });
  const reset = () => run('reset', async () => {
    if (!window.confirm('清空问答记录重新开始？已生成的定位档案会保留，直到生成新的。')) return;
    onAccount(await window.sydney.resetXhsPositioning(account.id));
  });
  const adopt = () => run('adopt', async () => {
    const result = await window.sydney.adoptXhsPositioningTopics(account.id, [...picked]);
    setPicked(new Set());
    notify(`已转成 ${result.created} 篇笔记任务${result.skipped ? `，${result.skipped} 篇已存在跳过` : ''}`);
  });
  const { view: ipLibrary } = useIpLibrary();
  const selectIp = (ipId: string) => run('ip-select', async () => { onAccount(await window.sydney.updateXhsAccount(account.id, { ipId })); });
  const last = chat[chat.length - 1];
  const waiting = last?.role === 'coach' && Boolean(last.questions?.length);

  return <div className="xhs-grid xhs-grid-two">
    <Section title="定位咨询" hint="像和顾问聊天：回答越具体，定位越准。随时可以直接生成定位档案。"
      actions={chat.length > 0 && <button className="button button-quiet" disabled={locked} onClick={() => void reset()}><Icon name="refresh" />重新开始</button>}>
      <div className="xhs-chat">
        {!chat.length && <p className="xhs-chat-empty">点「开始定位」，教练会先问你几个问题：你热爱什么、擅长什么、想给谁看、能不能长期输出。</p>}
        {chat.map((turn, index) => <div key={index} className={`xhs-chat-turn is-${turn.role}`}>
          <span className="xhs-chat-who">{turn.role === 'coach' ? '教练' : '我'}</span>
          <div>
            {turn.text && <p>{turn.text}</p>}
            {turn.questions?.length ? <ol>{turn.questions.map(question => <li key={question}>{question}</li>)}</ol> : null}
          </div>
        </div>)}
        <div ref={endRef} />
      </div>
      {(waiting || !chat.length) && <textarea className="input xhs-textarea" rows={4} disabled={locked} value={answer} onChange={event => setAnswer(event.target.value)}
        placeholder={chat.length ? '一次回答上面的问题，可以按序号写' : '可选：先介绍一下自己，例如「做了 5 年平面设计，喜欢研究收纳，想分享给刚租房的年轻人」'} />}
      <div className="flow-inline-actions">
        {(!chat.length || waiting) && <button className="button button-primary" disabled={locked || (waiting && !answer.trim())} onClick={() => void step(false)}>
          {busy === 'step' ? '教练思考中…' : chat.length ? '回答并继续' : '开始定位'}
        </button>}
        <button className="button button-secondary" disabled={locked} onClick={() => void step(true)} title="按目前的信息直接出定位档案，信息不足的地方会写明假设">
          {busy === 'finish' ? '生成中…' : profile ? '重新生成定位档案' : '直接生成定位档案'}
        </button>
      </div>
    </Section>

    <Section title="定位档案" hint={profile ? `生成于 ${new Date(profile.generatedAt).toLocaleString('zh-CN')}` : '问答结束后出现在这里，后续写作、标题、封面都会参考它。'}>
      {profile ? <div className="xhs-profile">
        <dl className="xhs-facts">
          <div><dt>赛道</dt><dd><strong>{profile.track.name}</strong>{profile.track.reason && <p>{profile.track.reason}</p>}{profile.track.alternatives.length > 0 && <small>备选：{profile.track.alternatives.join('、')}</small>}</dd></div>
          <div><dt>定位句</dt><dd><strong>{profile.statement}</strong></dd></div>
          <div><dt>账号名</dt><dd>{profile.persona.name || '—'}</dd></div>
          <div><dt>简介</dt><dd>{profile.persona.bio || '—'}</dd></div>
          <div><dt>视觉</dt><dd>{profile.persona.visual || '—'}</dd></div>
          <div><dt>内容支柱</dt><dd><ul>{profile.pillars.map(item => <li key={item.name}><strong>{item.name}</strong>{item.description && `：${item.description}`}</li>)}</ul></dd></div>
          <div><dt>冷启动</dt><dd><ul>{profile.coldStart.map(item => <li key={item.phase}><strong>{item.phase}</strong>：{item.actions.join('；')}</li>)}</ul></dd></div>
        </dl>
        <div className="flow-sub-head"><h4>前 20 篇选题<small>勾选后转成笔记任务</small></h4>
          <div className="btn-group">
            <button className="button button-quiet" onClick={() => setPicked(new Set(profile.firstTopics.map((_, index) => index).filter(index => !existing.has(profile.firstTopics[index].title))))}>全选未转的</button>
            <button className="button button-primary" disabled={locked || !picked.size} onClick={() => void adopt()}>{busy === 'adopt' ? '转换中…' : `转成笔记任务（${picked.size}）`}</button>
          </div>
        </div>
        <ul className="xhs-topic-picks">{profile.firstTopics.map((topic, index) => {
          const done = existing.has(topic.title);
          return <li key={`${topic.title}-${index}`}>
            <label className={done ? 'is-done' : ''}>
              <input type="checkbox" disabled={done} checked={picked.has(index)} onChange={event => setPicked(current => { const next = new Set(current); if (event.target.checked) next.add(index); else next.delete(index); return next; })} />
              <span>{index + 1}. {topic.title}</span>
              <small>{topic.pillar} · {xhsNoteTypeLabel(topic.noteType)}{done ? ' · 已转' : ''}</small>
            </label>
          </li>;
        })}</ul>
        <button className="button button-quiet" onClick={() => goTo('notes')}>去笔记创作 →</button>
      </div> : <p className="flow-empty">还没有定位档案。</p>}
    </Section>

    <Section title="IP 形象" hint="这个账号用哪个 IP：选了之后，笔记封面可以用 IP 模板本地出图（品牌名、头像、配色、角色都取自这个 IP），不消耗图片接口额度。IP 在「设置 → IP 形象」里管理。">
      <IpPicker label="这个账号的 IP" value={account.ipId} ips={ipLibrary.ips} disabled={locked} onChange={value => void selectIp(value)} />
    </Section>
  </div>;
}
