import { useEffect, useState } from 'react';
import type { WeWriteEnvironment } from '../shared';
import WeWriteOverviewPanel from './WeWriteOverview';
import NativeContentPanel from './NativeContentPanel';

export default function WeWritePanel({ notify }: { notify: (message: string) => void }) {
  const [environment, setEnvironment] = useState<WeWriteEnvironment | null>(null);
  const [tab, setTab] = useState<'native' | 'config'>('native');

  useEffect(() => {
    let alive = true;
    const loadEnvironment = () => window.sydney.getWeWriteEnvironment().then(next => {
      if (alive) setEnvironment(next);
    }).catch(() => undefined);
    void loadEnvironment();
    const off = window.sydney.onWeWriteChanged(() => { void loadEnvironment(); });
    return () => { alive = false; off(); };
  }, []);

  return <section className="wewrite">
    <header className="ww-page-header">
      <div>
        <p className="eyebrow">内容工作区</p>
        <h1>公众号</h1>
        <p>选题 → 任务书 → 来源与证据 → 初稿 → AI 审稿 → 封面 → 导出与发布，每一步状态都在界面上可见。</p>
      </div>
      <div className="ww-page-header-note"><strong>中老年健康科普</strong><span>{environment?.theme || '—'} · {environment?.persona || '未设置'}</span></div>
    </header>
    <div className="ww-tabs">
      <button className={`ww-tab ${tab === 'native' ? 'is-active' : ''}`} onClick={() => setTab('native')}>创作流水线</button>
      <button className={`ww-tab ${tab === 'config' ? 'is-active' : ''}`} onClick={() => setTab('config')}>环境与配置</button>
    </div>
    {tab === 'native' ? <NativeContentPanel notify={notify} /> : <WeWriteOverviewPanel notify={notify} />}
  </section>;
}
