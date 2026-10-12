import { useEffect, useState, type ReactNode } from 'react';
import type { AppState, LlmKeyStatus, Settings } from '../shared';
import { Icon, LinesEditor, Switch, TagEditor, type IconName } from './ui';

type Patch = Partial<Settings>;

const SECTIONS: Array<{ id: string; label: string; icon: IconName }> = [
  { id: 'vault', label: '知识库', icon: 'book' },
  { id: 'activity', label: '活动记录', icon: 'window' },
  { id: 'ai', label: 'AI 对话采集', icon: 'bot' },
  { id: 'files', label: '文件与屏幕', icon: 'folder' },
  { id: 'llm', label: 'AI 服务', icon: 'key' }
];

function statusBadge(status: { state: string; error: string }) {
  const map: Record<string, [string, string]> = { disabled: ['未开启', 'off'], stopped: ['开始记录后生效', 'idle'], listening: ['监听中', 'on'], capturing: ['采样中', 'on'], error: ['出错', 'error'] };
  const [text, tone] = map[status.state] ?? map.disabled;
  return <span className={`badge badge-${tone}`} title={status.error || text}>{status.state === 'error' ? `出错：${status.error}` : text}</span>;
}

function Row({ title, description, control, children, badge }: { title: string; description?: ReactNode; control?: ReactNode; children?: ReactNode; badge?: ReactNode }) {
  return <div className="set-row">
    <div className="set-row-text"><strong>{title}{badge}</strong>{description && <p>{description}</p>}</div>
    {control && <div className="set-row-control">{control}</div>}
    {children && <div className="set-row-wide">{children}</div>}
  </div>;
}

function NumberInput({ value, min, onCommit, suffix }: { value: number; min: number; onCommit: (value: number) => void; suffix: string }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => { const next = Math.max(min, Math.round(Number(draft) || min)); setDraft(String(next)); if (next !== value) onCommit(next); };
  return <label className="number-input"><input className="input" type="number" min={min} value={draft} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') commit(); }} /><span>{suffix}</span></label>;
}

export function SettingsView({ state, onSetting, onChooseFiles, notify }: { state: AppState; onSetting: (patch: Patch) => Promise<void>; onChooseFiles: () => Promise<void>; notify: (message: string) => void }) {
  const settings = state.settings;
  const [key, setKey] = useState('');
  const [keyStatus, setKeyStatus] = useState<LlmKeyStatus>({ configured: false, masked: '', encryptionAvailable: true });
  const [active, setActive] = useState('vault');
  useEffect(() => { void window.sydney.getLlmKeyStatus().then(setKeyStatus); }, []);
  const saveKey = async () => { setKeyStatus(await window.sydney.saveLlmKey(key.trim())); setKey(''); notify('DeepSeek 密钥已安全保存'); };
  const removeKey = async () => { setKeyStatus(await window.sydney.deleteLlmKey()); notify('已删除程序内保存的密钥'); };
  const chooseVault = async () => { const next = await window.sydney.chooseVault(); if (next) notify(`知识库已切换到 ${next}`); };
  const jump = (id: string) => { setActive(id); document.getElementById(`set-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

  return <div className="settings-layout">
    <nav className="settings-nav" aria-label="设置分区">
      {SECTIONS.map(section => <button key={section.id} className={active === section.id ? 'is-active' : ''} onClick={() => jump(section.id)}><Icon name={section.icon} size={15} />{section.label}</button>)}
      <p className="settings-nav-note"><Icon name="shield" size={14} />所有数据默认只保存在本机；修改即时生效。</p>
    </nav>

    <div className="settings-body">
      <section id="set-vault" className="set-card">
        <header><Icon name="book" size={18} /><div><h2>知识库</h2><p>确认后的事件、日报、周报和进化记录写入这个 Obsidian 目录。</p></div></header>
        <Row title="Obsidian 知识库目录" description={<code className="path">{settings.vaultPath || '未设置'}</code>}
          control={<div className="btn-group"><button className="button button-secondary" onClick={() => void chooseVault()}><Icon name="folder" />更换目录</button><button className="button button-quiet" onClick={() => void window.sydney.openVault()}>打开</button></div>} />
      </section>

      <section id="set-activity" className="set-card">
        <header><Icon name="window" size={18} /><div><h2>活动记录</h2><p>只记录应用名称、窗口标题和使用时长，不记录键盘输入。</p></div></header>
        <Row title="先全部保存，再人工确认" description="不在允许名单里的非敏感窗口也会进入待确认列表，由你决定保留或删除。密码、支付与私人聊天始终跳过。"
          control={<Switch label="先全部保存" checked={settings.captureAllPending} onChange={value => void onSetting({ captureAllPending: value })} />} />
        <Row title="采样间隔" description="下次开始记录时生效，最短 10 秒。" control={<NumberInput value={settings.captureIntervalSeconds} min={10} suffix="秒" onCommit={value => void onSetting({ captureIntervalSeconds: value })} />} />
        <Row title="允许采集的应用" description="按应用名包含匹配；回车或逗号添加。">
          <TagEditor values={settings.allowedApps} placeholder="例如 Code、Obsidian" onChange={values => void onSetting({ allowedApps: values })} />
        </Row>
        <Row title="禁止采集的应用 / 关键词" description="应用名或窗口标题包含这些词时直接跳过。">
          <TagEditor tone="danger" values={settings.blockedApps} placeholder="例如 1Password、微信" onChange={values => void onSetting({ blockedApps: values })} />
        </Row>
      </section>

      <section id="set-ai" className="set-card">
        <header><Icon name="bot" size={18} /><div><h2>AI 对话采集</h2><p>只采集你输入的提示词和每轮最终答复；工具只记名称与改动的文件路径，不保存工具输出、思考过程和历史会话。</p></div></header>
        <Row title="Codex 对话" badge={statusBadge(state.codexCapture)} description="监听 ~/.codex/sessions 中新增的会话。"
          control={<Switch label="Codex 对话" checked={settings.codexCaptureEnabled} onChange={value => void onSetting({ codexCaptureEnabled: value })} />} />
        <Row title="包含 Codex CLI 与 IDE 插件" description="默认只采集 Codex 桌面端；开启后也采集终端 codex 与 VS Code 插件。"
          control={<Switch label="包含 Codex CLI" disabled={!settings.codexCaptureEnabled} checked={settings.codexIncludeCli} onChange={value => void onSetting({ codexIncludeCli: value })} />} />
        <Row title="Claude Code 对话" badge={statusBadge(state.claudeCapture)} description="监听 ~/.claude/projects（含斜杠命令）；跳过工具结果、子代理和 ! 终端命令。"
          control={<Switch label="Claude Code 对话" checked={settings.claudeCaptureEnabled} onChange={value => void onSetting({ claudeCaptureEnabled: value })} />} />
        {settings.claudeCaptureEnabled && <Row title="额外的 Claude 会话目录" description="每行一个目录，例如另一个 CLAUDE_CONFIG_DIR 下的 projects；失焦后保存。">
          <LinesEditor values={settings.claudeExtraRoots} placeholder="D:\\other-claude\\projects" onChange={values => void onSetting({ claudeExtraRoots: values })} />
        </Row>}
      </section>

      <section id="set-files" className="set-card">
        <header><Icon name="folder" size={18} /><div><h2>文件与屏幕</h2><p>文件只记录路径和变化类型；屏幕帧本地加密，不上传、不做 OCR。</p></div></header>
        <Row title="监听文件变化" description={settings.inputWatchPaths.length ? '监听下方关联的文件 / 目录。' : '未关联文件时监听知识库的 01-输入 目录。'}
          control={<Switch label="监听文件变化" checked={settings.inputWatchEnabled} onChange={value => void onSetting({ inputWatchEnabled: value })} />}>
          <div className="file-list">
            {settings.inputWatchPaths.map(item => <span key={item} className="file-chip"><Icon name="file" size={13} /><code>{item}</code><button aria-label="移除" onClick={() => void onSetting({ inputWatchPaths: settings.inputWatchPaths.filter(value => value !== item) })}><Icon name="x" size={12} /></button></span>)}
            <button className="button button-secondary button-small" onClick={() => void onChooseFiles()}><Icon name="plus" />关联文件</button>
          </div>
        </Row>
        <Row title="屏幕后台采样" badge={settings.screenCaptureEnabled ? <span className="badge badge-idle">已保存 {state.screenCapture.saved} 帧</span> : undefined}
          description={state.screenCapture.state === 'error' ? state.screenCapture.error : '只在允许的应用前台时截图，AES-GCM 加密保存。'}
          control={<Switch label="屏幕后台采样" checked={settings.screenCaptureEnabled} onChange={value => void onSetting({ screenCaptureEnabled: value })} />} />
        {settings.screenCaptureEnabled && <>
          <Row title="截图间隔" control={<NumberInput value={settings.screenCaptureIntervalSeconds} min={15} suffix="秒" onCommit={value => void onSetting({ screenCaptureIntervalSeconds: value })} />} />
          <Row title="保留时间" description="超过时间的帧自动删除。" control={<NumberInput value={settings.screenRetentionHours} min={1} suffix="小时" onCommit={value => void onSetting({ screenRetentionHours: value })} />} />
        </>}
      </section>

      <section id="set-llm" className="set-card">
        <header><Icon name="key" size={18} /><div><h2>AI 服务（DeepSeek）</h2><p>用于单条 AI 整理、规则生成和经验卡片；只在你点击时发送对应内容。</p></div></header>
        <Row title="允许发送到 DeepSeek" description="关闭后所有 AI 按钮不可用。" control={<Switch label="允许发送到 DeepSeek" checked={settings.llmEnabled} onChange={value => void onSetting({ llmEnabled: value })} />} />
        <Row title="API Key" badge={<span className={`badge ${keyStatus.configured ? 'badge-on' : 'badge-off'}`}>{keyStatus.configured ? `已保存 ${keyStatus.masked}` : '未保存'}</span>}
          description={keyStatus.encryptionAvailable ? '使用系统安全存储加密，不写入项目、数据库或知识库；未保存时回退到环境变量。' : '当前系统安全存储不可用，无法保存密钥。'}>
          <div className="key-row">
            <input className="input" type="password" autoComplete="off" placeholder={keyStatus.configured ? '输入新密钥以替换' : 'sk-...'} value={key} onChange={event => setKey(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && key.trim()) void saveKey(); }} />
            <button className="button button-primary" disabled={!key.trim() || !keyStatus.encryptionAvailable} onClick={() => void saveKey()}>保存</button>
            {keyStatus.configured && <button className="button button-quiet" onClick={() => void removeKey()}>删除</button>}
          </div>
        </Row>
      </section>
    </div>
  </div>;
}
