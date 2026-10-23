import { useEffect, useState, type ReactNode } from 'react';
import type { AppState, CloudSyncStatus, LlmKeyStatus, ModelConfigDraft, ModelConfigView, ModelPresetKind, ModelPresetView, Settings } from '../shared';
import ModelPresetBar from './ModelPresetBar';
import { Icon, LinesEditor, Switch, TagEditor, readableError, type IconName } from './ui';
import { IpLibraryCard } from './IpLibrary';

type Patch = Partial<Settings>;

const SECTIONS: Array<{ id: string; label: string; icon: IconName }> = [
  { id: 'vault', label: '知识库', icon: 'book' },
  { id: 'activity', label: '活动记录', icon: 'window' },
  { id: 'ai', label: 'AI 对话采集', icon: 'bot' },
  { id: 'files', label: '文件与屏幕', icon: 'folder' },
  { id: 'cloud', label: '云同步', icon: 'cloud' },
  { id: 'models', label: '模型', icon: 'key' },
  { id: 'ip', label: 'IP 形象', icon: 'user' },
  { id: 'data', label: '选题数据', icon: 'chart' }
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

const keyBadge = (status: LlmKeyStatus) => <span className={`badge ${status.configured ? 'badge-on' : 'badge-off'}`}>{status.configured ? `已保存 ${status.masked}` : '未保存'}</span>;

const IMAGE_PROVIDERS = ['openai', 'doubao', 'dashscope', 'jimeng', 'minimax', 'gemini', 'openrouter', 'replicate', 'azure_openai', 'sub2api'];

const draftFromView = (view: ModelConfigView): ModelConfigDraft => ({
  writer: { baseUrl: view.writer.baseUrl, model: view.writer.model, apiKey: '' },
  image: { provider: view.image.provider, model: view.image.model, baseUrl: view.image.baseUrl, apiKey: '', estimatedCost: view.image.estimatedCost }
});

/**
 * 统一模型配置：全应用一个内容模型、一个图片模型，公众号、视频、小红书、AI 整理与经验卡片都用它。
 * 每种模型可以存多套预设，下拉切换；表单改完点「保存」才生效，key 留空表示保留现有的。
 */
function ModelsCard({ enabled, onToggle, notify }: { enabled: boolean; onToggle: (value: boolean) => void; notify: (message: string) => void }) {
  const [view, setView] = useState<ModelConfigView | null>(null);
  const [draft, setDraft] = useState<ModelConfigDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const load = (next: ModelConfigView) => { setView(next); setDraft(draftFromView(next)); };
  useEffect(() => { void window.sydney.getModelConfig().then(load).catch(error => notify(readableError(error))); }, [notify]);
  if (!view || !draft) return null;

  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFromView(view));
  const run = async (action: () => Promise<ModelConfigView>, message: string) => {
    setBusy(true);
    try { load(await action()); notify(message); } catch (error) { notify(readableError(error)); } finally { setBusy(false); }
  };
  const patchWriter = (patch: Partial<ModelConfigDraft['writer']>) => setDraft({ ...draft, writer: { ...draft.writer, ...patch } });
  const patchImage = (patch: Partial<ModelConfigDraft['image']>) => setDraft({ ...draft, image: { ...draft.image, ...patch } });
  const applyPreset = (preset: ModelPresetView) => {
    if (dirty && !window.confirm('表单里有未保存的修改，切换预设会丢掉这些修改。继续？')) return;
    void run(() => window.sydney.applyModelPreset(preset.id), `已切换到「${preset.name}」，所有模块之后都用这套模型`);
  };
  const savePreset = (kind: ModelPresetKind, name: string) => {
    const values = kind === 'writer' ? { ...draft.writer } : { ...draft.image };
    void run(() => window.sydney.saveModelPreset({ kind, name, ...values }), `已存为预设「${name || values.model}」`);
  };
  const deletePreset = (preset: ModelPresetView) => {
    if (!window.confirm(`删除预设「${preset.name}」？当前在用的配置不受影响。`)) return;
    void run(() => window.sydney.deleteModelPreset(preset.id), `已删除预设「${preset.name}」`);
  };
  const presetBar = (kind: ModelPresetKind) => <ModelPresetBar kind={kind} presets={view.presets.filter(item => item.kind === kind)}
    activeId={view.activePresets[kind]} defaultName={kind === 'writer' ? draft.writer.model : draft.image.model} busy={busy}
    onApply={applyPreset} onSave={name => savePreset(kind, name)} onDelete={deletePreset} />;
  const test = async () => {
    setTesting(true);
    try { const result = await window.sydney.testContentModel(); notify(`内容模型连接正常（${result.model}）`); }
    catch (error) { notify(`连接失败：${readableError(error)}`); }
    finally { setTesting(false); }
  };

  return <section id="set-models" className="set-card">
    <header><Icon name="key" size={18} /><div><h2>模型</h2><p>全应用统一的内容模型与图片模型：公众号、视频、小红书、AI 整理与经验卡片都用这里的配置，各模块不再单独设置。</p></div></header>
    <Row title="允许调用内容模型" description="关闭后所有模块的 AI 写作、整理、检测按钮都不可用。只在你点击时发送对应内容。"
      control={<Switch label="允许调用内容模型" checked={enabled} onChange={onToggle} />} />

    <Row title="内容模型" badge={keyBadge(view.writer.key)} description="OpenAI 兼容的 chat/completions 接口；key 使用系统安全存储加密，未保存时回退到环境变量。">
      {presetBar('writer')}
      <div className="ww-grid">
        <label className="ww-input"><span>接口地址</span><input value={draft.writer.baseUrl} onChange={event => patchWriter({ baseUrl: event.target.value })} placeholder="https://api.deepseek.com/v1" /></label>
        <label className="ww-input"><span>模型</span><input value={draft.writer.model} onChange={event => patchWriter({ model: event.target.value })} placeholder="deepseek-chat" /></label>
        <label className="ww-input ww-wide"><span>API Key</span><input type="password" autoComplete="off" value={draft.writer.apiKey} onChange={event => patchWriter({ apiKey: event.target.value })} placeholder={view.writer.key.configured ? `已配置 ${view.writer.key.masked}，留空保留` : 'sk-...'} /></label>
      </div>
      <button className="button button-quiet" disabled={testing || dirty} title={dirty ? '先保存再测试' : '用当前在用的内容模型发一条最小请求'} onClick={() => void test()}>{testing ? '测试中…' : '测试连接'}</button>
    </Row>

    <Row title="图片模型" badge={<span className={`badge ${view.image.apiKeyMasked ? 'badge-on' : 'badge-off'}`}>{view.image.apiKeyMasked ? `已保存 ${view.image.apiKeyMasked}` : '未保存'}</span>}
      description="OpenAI 兼容的 images/generations 接口，用于封面、配图与信息图（按张计费）。">
      {presetBar('image')}
      <div className="ww-grid ww-grid-three">
        <label className="ww-input"><span>Provider</span>
          <select value={draft.image.provider} onChange={event => patchImage({ provider: event.target.value })}>
            <option value="">未选择</option>
            {IMAGE_PROVIDERS.map(item => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label className="ww-input"><span>模型</span><input value={draft.image.model} onChange={event => patchImage({ model: event.target.value })} placeholder="gpt-image-2" /></label>
        <label className="ww-input"><span>预估单价</span><input value={draft.image.estimatedCost} onChange={event => patchImage({ estimatedCost: event.target.value })} placeholder="0.04" /></label>
        <label className="ww-input ww-wide"><span>接口地址</span><input value={draft.image.baseUrl} onChange={event => patchImage({ baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" /></label>
        <label className="ww-input ww-wide"><span>API Key</span><input type="password" autoComplete="off" value={draft.image.apiKey} onChange={event => patchImage({ apiKey: event.target.value })} placeholder={view.image.apiKeyMasked ? `已配置 ${view.image.apiKeyMasked}，留空保留` : '输入图片服务 API Key'} /></label>
      </div>
    </Row>

    <div className="set-model-actions">
      <span>{dirty ? '有未保存的修改' : '配置写入本机 ~/.wewrite/config.yaml，内容模型 key 在系统安全存储'}</span>
      <button className="button button-secondary" disabled={busy || !dirty} onClick={() => setDraft(draftFromView(view))}>放弃修改</button>
      <button className="button button-primary" disabled={busy || !dirty} onClick={() => void run(() => window.sydney.saveModelConfig(draft), '模型配置已保存，所有模块立即生效')}>{busy ? '保存中…' : '保存'}</button>
    </div>
  </section>;
}

function NumberInput({ value, min, onCommit, suffix }: { value: number; min: number; onCommit: (value: number) => void; suffix: string }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => { const next = Math.max(min, Math.round(Number(draft) || min)); setDraft(String(next)); if (next !== value) onCommit(next); };
  return <label className="number-input"><input className="input" type="number" min={min} value={draft} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') commit(); }} /><span>{suffix}</span></label>;
}

/** 同步时间显示：从未同步过时给友好提示。 */
function syncTime(value: string): string {
  if (!value) return '尚未同步';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '尚未同步' : date.toLocaleString('zh-CN', { hour12: false });
}

/**
 * 云同步：把已确认事件批量上传到自建同步 API。
 * 密码只在主进程的系统安全存储里，渲染进程只拿到掩码状态；地址 / 用户名失焦保存，隐私开关即时生效。
 */
function CloudSyncCard({ settings, onSetting, notify }: { settings: Settings; onSetting: (patch: Patch) => Promise<void>; notify: (message: string) => void }) {
  const [status, setStatus] = useState<CloudSyncStatus | null>(null);
  const [keyStatus, setKeyStatus] = useState<LlmKeyStatus>({ configured: false, masked: '', encryptionAvailable: true });
  const [password, setPassword] = useState('');
  const [url, setUrl] = useState(settings.cloudSyncUrl);
  const [username, setUsername] = useState(settings.cloudSyncUsername);
  const [running, setRunning] = useState(false);
  const reload = () => { void window.sydney.getCloudSyncStatus().then(setStatus); };
  useEffect(() => { reload(); void window.sydney.getCloudSyncKeyStatus().then(setKeyStatus); }, []);
  useEffect(() => { setUrl(settings.cloudSyncUrl); setUsername(settings.cloudSyncUsername); }, [settings.cloudSyncUrl, settings.cloudSyncUsername]);

  const toggle = async (value: boolean) => { await onSetting({ cloudSyncEnabled: value }); reload(); };
  const saveKey = async () => { setKeyStatus(await window.sydney.saveCloudSyncKey(password.trim())); setPassword(''); notify('云同步密码已安全保存'); };
  const deleteKey = async () => { setKeyStatus(await window.sydney.deleteCloudSyncKey()); notify('已删除本机保存的云同步密码'); };
  const sync = async () => {
    setRunning(true);
    try {
      const next = await window.sydney.runCloudSync();
      setStatus(next);
      notify(next.error || (next.pending ? `已同步，仍有 ${next.pending} 条待上传` : '已同步，队列已清空'));
    } catch (error) { notify(readableError(error)); }
    finally { setRunning(false); }
  };
  const commitUrl = () => { const value = url.trim(); if (value && value !== settings.cloudSyncUrl) void onSetting({ cloudSyncUrl: value }); else setUrl(settings.cloudSyncUrl); };
  const commitUsername = () => { const value = username.trim(); if (value !== settings.cloudSyncUsername) void onSetting({ cloudSyncUsername: value }); else setUsername(settings.cloudSyncUsername); };

  const enabled = settings.cloudSyncEnabled;
  const pending = status?.pending ?? 0;
  return <section id="set-cloud" className="set-card">
    <header><Icon name="cloud" size={18} /><div><h2>云同步</h2><p>把已确认的事件按隐私规则上传到你自己的同步服务，用于跨设备汇总。密码用系统安全存储加密，只留在本机主进程。</p></div></header>
    <Row title="开启云同步" badge={enabled ? <span className="badge badge-on">已开启</span> : <span className="badge badge-off">未开启</span>}
      description="关闭后不再上传；已在队列里的记录会保留，重新开启后继续同步。"
      control={<Switch label="开启云同步" checked={enabled} onChange={value => void toggle(value)} />} />

    {enabled && <>
      <Row title="同步地址" description="你的同步 API 根地址，应用会请求其下的 /sync。" control={<input className="input" value={url} onChange={event => setUrl(event.target.value)} onBlur={commitUrl} onKeyDown={event => { if (event.key === 'Enter') commitUrl(); }} placeholder="https://zxlup.xin/sync-api/" />} />
      <Row title="用户名" description="HTTP Basic Auth 的用户名。" control={<input className="input" value={username} onChange={event => setUsername(event.target.value)} onBlur={commitUsername} onKeyDown={event => { if (event.key === 'Enter') commitUsername(); }} />} />
      <Row title="密码" badge={keyBadge(keyStatus)}
        description={keyStatus.encryptionAvailable ? '使用系统安全存储加密，不写入项目、数据库或知识库；留空表示使用空密码。' : '当前系统安全存储不可用，无法保存密码。'}>
        <div className="key-row">
          <input className="input" type="password" autoComplete="off" placeholder={keyStatus.configured ? '输入新密码以替换' : '留空表示空密码'} value={password} onChange={event => setPassword(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && password.trim()) void saveKey(); }} />
          <button className="button button-primary" disabled={!password.trim() || !keyStatus.encryptionAvailable} onClick={() => void saveKey()}>保存</button>
          {keyStatus.configured && <button className="button button-quiet" onClick={() => void deleteKey()}>删除</button>}
        </div>
      </Row>
      <Row title="隐私" description="默认只上传摘要、分类、时长、时间；截图路径永不上传。以下两项默认关闭，需要时才打开。" />
      <Row title="上传窗口标题" description="窗口标题可能包含正在处理的文件名或聊天对象，默认关闭。"
        control={<Switch label="上传窗口标题" checked={settings.cloudSyncIncludeWindowTitle} onChange={value => void onSetting({ cloudSyncIncludeWindowTitle: value })} />} />
      <Row title="上传文件路径" description="文件路径会暴露本机目录结构，默认关闭。"
        control={<Switch label="上传文件路径" checked={settings.cloudSyncIncludeFilePath} onChange={value => void onSetting({ cloudSyncIncludeFilePath: value })} />} />
      <Row title="同步状态" description={status?.error || `上次同步：${syncTime(status?.lastSyncAt ?? '')} · 待上传 ${pending} 条`}
        control={<button className="button button-secondary" disabled={running} onClick={() => void sync()}>{running ? '同步中…' : '立即同步'}</button>} />
    </>}
  </section>;
}

export function SettingsView({ state, onSetting, onChooseFiles, notify }: { state: AppState; onSetting: (patch: Patch) => Promise<void>; onChooseFiles: () => Promise<void>; notify: (message: string) => void }) {
  const settings = state.settings;
  const [active, setActive] = useState('vault');
  const [redfoxKey, setRedfoxKey] = useState('');
  const [redfoxStatus, setRedfoxStatus] = useState<LlmKeyStatus>({ configured: false, masked: '', encryptionAvailable: true });
  const [redfoxTesting, setRedfoxTesting] = useState(false);
  /** 没保存 key、靠环境变量 REDFOX_API_KEY 时主进程会在 masked 里注明来源，这时没有可删除的东西。 */
  const redfoxFromEnv = redfoxStatus.configured && redfoxStatus.masked.includes('环境变量');
  useEffect(() => { void window.sydney.getRedfoxKeyStatus().then(setRedfoxStatus); }, []);
  const saveRedfoxKey = async () => { setRedfoxStatus(await window.sydney.saveRedfoxKey(redfoxKey.trim())); setRedfoxKey(''); notify('红狐 API Key 已安全保存'); };
  const removeRedfoxKey = async () => { setRedfoxStatus(await window.sydney.deleteRedfoxKey()); notify('已删除程序内保存的红狐 Key'); };
  const testRedfoxKey = async () => {
    setRedfoxTesting(true);
    try { const result = await window.sydney.testRedfoxKey(); notify(`红狐连接正常，近 7 天全站热门共 ${result.total} 条`); }
    catch (error) { notify(`红狐连接失败：${readableError(error)}`); }
    finally { setRedfoxTesting(false); }
  };
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

      <CloudSyncCard settings={settings} onSetting={onSetting} notify={notify} />

      <ModelsCard enabled={settings.llmEnabled} onToggle={value => void onSetting({ llmEnabled: value })} notify={notify} />

      <IpLibraryCard notify={notify} />

      <section id="set-data" className="set-card">
        <header><Icon name="chart" size={18} /><div><h2>内容选题 · 热点数据（红狐）</h2><p>公众号、小红书和视频模块共用这一个红狐 Key。只在你点搜索或生成选题时把关键词发给红狐；同样的查询 24 小时内走本地缓存。</p></div></header>
        <Row title="红狐 API Key" badge={<span className={`badge ${redfoxStatus.configured ? 'badge-on' : 'badge-off'}`}>{redfoxFromEnv ? '使用环境变量' : redfoxStatus.configured ? `已保存 ${redfoxStatus.masked}` : '未保存'}</span>}
          description={redfoxStatus.encryptionAvailable ? '使用系统安全存储加密，不写入项目、数据库或知识库；未保存时回退到环境变量 REDFOX_API_KEY。获取地址：redfox.hk/settings/api-keys' : '当前系统安全存储不可用，无法保存密钥。'}>
          <div className="key-row">
            <input className="input" type="password" autoComplete="off" placeholder={redfoxStatus.configured ? '输入新 Key 以替换' : 'ak_...'} value={redfoxKey} onChange={event => setRedfoxKey(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && redfoxKey.trim()) void saveRedfoxKey(); }} />
            <button className="button button-primary" disabled={!redfoxKey.trim() || !redfoxStatus.encryptionAvailable} onClick={() => void saveRedfoxKey()}>保存</button>
            <button className="button button-secondary" disabled={redfoxTesting} onClick={() => void testRedfoxKey()}>{redfoxTesting ? '测试中…' : '测试连接'}</button>
            {redfoxStatus.configured && !redfoxFromEnv && <button className="button button-quiet" onClick={() => void removeRedfoxKey()}>删除</button>}
          </div>
        </Row>
      </section>
    </div>
  </div>;
}
