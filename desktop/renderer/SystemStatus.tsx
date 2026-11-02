import { useCallback, useEffect, useState } from 'react';
import { Icon, readableError, relativeTime } from './ui';

type CheckState = 'ok' | 'warn' | 'error' | 'checking';
type Check = { key: string; label: string; state: CheckState; detail: string; fix?: { label: string; section?: string } };

const PENDING: Check[] = [
  { key: 'writer', label: '内容模型', state: 'checking', detail: '检查中…' },
  { key: 'image', label: '图片模型', state: 'checking', detail: '检查中…' },
  { key: 'wechat', label: '公众号凭证', state: 'checking', detail: '检查中…' },
  { key: 'ffmpeg', label: 'ffmpeg', state: 'checking', detail: '检查中…' },
  { key: 'vault', label: '知识库目录', state: 'checking', detail: '检查中…' }
];

const STATE_TEXT: Record<CheckState, string> = { ok: '就绪', warn: '待配置', error: '不可用', checking: '检查中' };

/**
 * 内容生产依赖的几样东西是否就绪：模型、微信凭证、ffmpeg、知识库目录。
 * 只读检查，不发模型请求；进入设置页时查一次，也可以手动重查。
 */
export function SystemStatusCard({ vaultPath, onJump }: { vaultPath: string; onJump: (section: string) => void }) {
  const [checks, setChecks] = useState<Check[]>(PENDING);
  const [checkedAt, setCheckedAt] = useState('');
  const [busy, setBusy] = useState(false);

  const inspect = useCallback(async () => {
    setBusy(true);
    setChecks(current => current.map(item => ({ ...item, state: 'checking', detail: '检查中…' })));
    const [models, environment, ffmpeg] = await Promise.allSettled([window.sydney.getModelConfig(), window.sydney.getWeWriteEnvironment(), window.sydney.getFfmpegStatus()]);
    const failed = (result: PromiseRejectedResult) => readableError(result.reason);
    const next: Check[] = [];
    if (models.status === 'fulfilled') {
      const { enabled, writer, image } = models.value;
      next.push(!enabled
        ? { key: 'writer', label: '内容模型', state: 'warn', detail: '还没开启 AI，写作、审稿、分镜都不可用', fix: { label: '去开启', section: 'models' } }
        : !writer.key.configured || !writer.model
          ? { key: 'writer', label: '内容模型', state: 'error', detail: writer.model ? '缺少 API Key' : '还没填模型名', fix: { label: '去配置', section: 'models' } }
          : { key: 'writer', label: '内容模型', state: 'ok', detail: `${writer.model} · Key ${writer.key.masked}` });
      next.push(image.apiKeyMasked && image.model
        ? { key: 'image', label: '图片模型', state: 'ok', detail: `${image.provider} · ${image.model}` }
        : { key: 'image', label: '图片模型', state: 'warn', detail: '未配置，封面和配图只能用本地图片', fix: { label: '去配置', section: 'models' } });
    } else {
      next.push({ key: 'writer', label: '内容模型', state: 'error', detail: failed(models) }, { key: 'image', label: '图片模型', state: 'error', detail: failed(models) });
    }
    next.push(environment.status === 'fulfilled'
      ? environment.value.wechatConfigured
        ? { key: 'wechat', label: '公众号凭证', state: 'ok', detail: 'AppID / AppSecret 已填写，可推送草稿箱' }
        : { key: 'wechat', label: '公众号凭证', state: 'warn', detail: '未填写，推送草稿箱前需在「公众号 → 环境与配置」补上' }
      : { key: 'wechat', label: '公众号凭证', state: 'error', detail: failed(environment) });
    next.push(ffmpeg.status === 'fulfilled'
      ? { key: 'ffmpeg', label: 'ffmpeg', state: ffmpeg.value.ok ? 'ok' : 'error', detail: ffmpeg.value.ok ? '视频合成、配音时长与成片检查可用' : ffmpeg.value.detail }
      : { key: 'ffmpeg', label: 'ffmpeg', state: 'error', detail: failed(ffmpeg) });
    next.push(vaultPath
      ? { key: 'vault', label: '知识库目录', state: 'ok', detail: vaultPath }
      : { key: 'vault', label: '知识库目录', state: 'warn', detail: '未设置，日报、导出和发布包无处可写', fix: { label: '去设置', section: 'vault' } });
    setChecks(next);
    setCheckedAt(new Date().toISOString());
    setBusy(false);
  }, [vaultPath]);

  useEffect(() => { void inspect(); }, [inspect]);

  const ready = checks.filter(item => item.state === 'ok').length;
  const worst: CheckState = checks.some(item => item.state === 'checking') ? 'checking' : checks.some(item => item.state === 'error') ? 'error' : checks.some(item => item.state === 'warn') ? 'warn' : 'ok';
  return <section id="set-status" className="set-card system-status">
    <header>
      <Icon name="pulse" size={18} />
      <div><h2>系统状态</h2><p>内容生产依赖的模型、凭证与本机工具是否就绪；只做本地检查，不会发出模型请求。</p></div>
      <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => void inspect()}><Icon name="refresh" size={14} />{busy ? '检查中…' : '重新检查'}</button>
    </header>
    <div className={`status-summary is-${worst}`}>
      <span className="status-dot" aria-hidden="true" />
      <strong>{worst === 'checking' ? '正在检查…' : worst === 'ok' ? '全部就绪' : `${ready} / ${checks.length} 项就绪`}</strong>
      <small>{checkedAt ? `上次检查 ${relativeTime(checkedAt)}` : ''}</small>
    </div>
    <ul className="status-list">{checks.map(item => <li key={item.key} className={`is-${item.state}`}>
      <span className="status-dot" aria-hidden="true" />
      <strong>{item.label}</strong>
      <span className="status-detail" title={item.detail}>{item.detail}</span>
      <em>{STATE_TEXT[item.state]}</em>
      {item.fix?.section && <button type="button" className="button button-quiet button-small" onClick={() => onJump(item.fix!.section!)}>{item.fix.label}</button>}
    </li>)}</ul>
  </section>;
}
