import { ConfirmButton, Icon, ModuleToolbar } from '../ui';

export function HeroSmsKeyPanel({
  configured,
  masked,
  keyDraft,
  busy,
  onDraft,
  onSave,
  onTest,
  onOpen,
  onDelete,
}: {
  configured: boolean;
  masked: string;
  keyDraft: string;
  busy: string;
  onDraft: (value: string) => void;
  onSave: () => void;
  onTest: () => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <section className="panel hero-sms-key-card">
      <ModuleToolbar className="panel-head" label="HeroSMS API Key">
        <div className="panel-title">
          <h2>
            <Icon name="key" size={17} />
            HeroSMS 开放 API
          </h2>
          <p>号码、余额、价格和短信状态都直接请求官方接口。Key 使用系统安全存储加密，不进入页面会话或普通配置文件。</p>
        </div>
        <span className={`badge ${configured ? 'badge-on' : 'badge-off'}`}>
          {configured ? `已配置 ${masked}` : '未配置 Key'}
        </span>
      </ModuleToolbar>
      {!configured ? (
        <div className="hero-sms-key-setup">
          <label className="field">
            <span>HeroSMS API Key</span>
            <input
              className="input"
              type="password"
              autoComplete="off"
              value={keyDraft}
              onChange={(event) => onDraft(event.target.value)}
              placeholder="在 HeroSMS 用户中心生成 API Key"
              onKeyDown={(event) => {
                if (event.key === 'Enter') onSave();
              }}
            />
          </label>
          <button className="button button-primary" disabled={busy === 'save-key' || !keyDraft.trim()} onClick={onSave}>
            <Icon name="shield" />
            {busy === 'save-key' ? '保存中…' : '安全保存'}
          </button>
          <button className="button button-secondary" onClick={onOpen}>
            <Icon name="window" />
            打开 HeroSMS
          </button>
        </div>
      ) : (
        <div className="hero-sms-key-actions">
          <span>
            <Icon name="shield" size={14} />
            Key 只由主进程读取，每次请求按官方协议发送给 HeroSMS。
          </span>
          <button className="button button-secondary button-small" disabled={Boolean(busy)} onClick={onTest}>
            {busy === 'test-key' ? '测试中…' : '测试连接'}
          </button>
          <button className="button button-quiet button-small" onClick={onOpen}>
            <Icon name="window" size={14} />
            官网充值
          </button>
          <ConfirmButton
            className="button button-danger-quiet button-small"
            armedLabel="确认删除本机 Key？"
            onConfirm={onDelete}
          >
            删除本机 Key
          </ConfirmButton>
          <details className="hero-sms-key-replace">
            <summary>更换 Key</summary>
            <div>
              <input
                className="input"
                type="password"
                autoComplete="off"
                value={keyDraft}
                onChange={(event) => onDraft(event.target.value)}
                placeholder="输入新的 API Key"
              />
              <button
                className="button button-primary button-small"
                disabled={!keyDraft.trim() || busy === 'save-key'}
                onClick={onSave}
              >
                保存
              </button>
            </div>
          </details>
        </div>
      )}
    </section>
  );
}
