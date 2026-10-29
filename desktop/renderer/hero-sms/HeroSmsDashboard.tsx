import { heroSmsServiceLabel } from '../../services/herosms';
import { ConfirmButton, EmptyState, Icon } from '../ui';
import { money, phaseText } from './heroSmsFormat';
import type { useHeroSmsWorkspace } from './useHeroSmsWorkspace';
type Model = ReturnType<typeof useHeroSmsWorkspace>;

export function HeroSmsDashboard({ model }: { model: Model }) {
  const m = model;
  const o = m.overview!;
  const selected = m.selected;
  return (
    <>
      <div className="hero-sms-metrics">
        <div>
          <span>账户余额</span>
          <strong>{money(o.balance, o.currency)}</strong>
          <small>{o.currency}</small>
        </div>
        <div>
          <span>活跃号码</span>
          <strong>{o.activations.length}</strong>
          <small>最多显示 100 条</small>
        </div>
        <div>
          <span>可选服务</span>
          <strong>{o.services.length}</strong>
          <small>国家和价格实时查询</small>
        </div>
        <div>
          <span>最近刷新</span>
          <strong>{new Date(o.refreshedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</strong>
          <small>短信每 5 秒自动轮询</small>
        </div>
      </div>
      <div className="hero-sms-workbench">
        <Purchase model={m} />
        <Current model={m} />
      </div>
      <ActivationList model={m} />
    </>
  );
}
function Purchase({ model: m }: { model: Model }) {
  const o = m.overview!;
  return (
    <section className="panel hero-sms-buy-card">
      <header className="panel-head">
        <div className="panel-title">
          <h2>
            <Icon name="phone" size={17} />
            购买临时号码
          </h2>
          <p>
            先选服务和号码国家，再查库存与报价。HeroSMS 不单列 Codex，Codex / ChatGPT 的验证统一选「OpenAI /
            ChatGPT（Codex）」。
          </p>
        </div>
      </header>
      <div className="hero-sms-selectors">
        <div className="hero-sms-filter">
          <label className="field">
            <span>搜索服务</span>
            <input
              className="input"
              value={m.serviceSearch}
              onChange={(e) => m.setServiceSearch(e.target.value)}
              placeholder="例如 Codex、OpenAI、Telegram、微信"
            />
          </label>
          <label className="field">
            <span>服务</span>
            <select className="input" value={m.serviceCode} onChange={(e) => m.setServiceCode(e.target.value)}>
              <option value="">选择服务</option>
              {m.services.map((i) => (
                <option key={i.code} value={i.code}>
                  {heroSmsServiceLabel(i)} · {i.code}
                </option>
              ))}
            </select>
          </label>
          {m.openAiService && (
            <button
              type="button"
              className="chip chip-accent hero-sms-quick-pick"
              onClick={() => {
                m.setServiceSearch('');
                m.setServiceCode(m.openAiService!.code);
              }}
            >
              Codex / OpenAI
            </button>
          )}
        </div>
        <div className="hero-sms-filter">
          <label className="field">
            <span>搜索国家 / 地区</span>
            <input
              className="input"
              value={m.countrySearch}
              onChange={(e) => m.setCountrySearch(e.target.value)}
              placeholder="中文、英文或国家 ID"
            />
          </label>
          <label className="field">
            <span>号码国家 / 地区 · 价格从低到高</span>
            <select
              className="input"
              value={m.countryId}
              onChange={(e) => m.setCountryId(e.target.value ? Number(e.target.value) : '')}
            >
              <option value="">{m.offersBusy ? '正在查询各国价格…' : '选择国家 / 地区'}</option>
              {m.countries.map((i) => {
                const p = m.countryOffers[i.id];
                const d = !m.serviceCode
                  ? '先选服务'
                  : p
                    ? `${money(p.cost, o.currency)} · ${p.count > 0 ? `${p.count} 个` : '无号'}`
                    : m.offersBusy
                      ? '价格查询中…'
                      : '暂无报价';
                return (
                  <option key={i.id} value={i.id}>
                    {i.name}
                    {i.englishName !== i.name ? ` · ${i.englishName}` : ''} · {d}
                  </option>
                );
              })}
            </select>
          </label>
        </div>
      </div>
      <div className="hero-sms-quote">
        <div>
          <span>当前报价</span>
          <strong>{m.offersBusy ? '查询中…' : m.offer ? money(m.offer.cost, o.currency) : '—'}</strong>
          <small>
            {m.offer
              ? `可用号码 ${m.offer.count} 个`
              : m.serviceCode && m.countryId !== ''
                ? '这个国家当前没有报价'
                : '选好服务和地区后显示'}
          </small>
        </div>
        <ConfirmButton
          className="button button-primary"
          disabled={m.offersBusy || !m.offer || m.offer.count < 1 || m.offer.cost === null}
          armedLabel={
            m.offer?.cost !== null && m.offer?.cost !== undefined
              ? `确认花费 ${money(m.offer.cost, o.currency)} 购号？`
              : '确认购买号码？'
          }
          onConfirm={() => void m.buy()}
        >
          <Icon name="plus" />
          {m.busy === 'buy' ? '购买中…' : '购买号码'}
        </ConfirmButton>
      </div>
      <p className="site-privacy">
        价格与库存由 HeroSMS
        实时返回。购买会占用真实余额；最近购号明细只存本机，用途是在远端把号码打码时仍能补全。是否退款以 HeroSMS
        结果为准。
      </p>
    </section>
  );
}
function Current({ model: m }: { model: Model }) {
  const o = m.overview!;
  const s = m.selected;
  return (
    <section className="panel hero-sms-current">
      <header className="panel-head">
        <div className="panel-title">
          <h2>
            <Icon name="inbox" size={17} />
            当前号码
          </h2>
          <p>收到验证码后先复制使用，再手动「标记已完成」。取消号码会调用官方释放接口。</p>
        </div>
        {s && (
          <button
            className="button button-quiet button-small"
            disabled={Boolean(m.busy)}
            onClick={() => void m.refreshActivation()}
          >
            <Icon name="refresh" size={14} />
            {m.busy === 'refresh' ? '刷新中…' : '刷新短信'}
          </button>
        )}
      </header>
      {s ? (
        <div className="hero-sms-current-body">
          <div className="hero-sms-phone">
            <div>
              <span>手机号</span>
              <strong>{s.phone}</strong>
            </div>
            <button className="button button-secondary button-small" onClick={() => void m.copy(s.phone, '号码')}>
              <Icon name="link" size={14} />
              复制号码
            </button>
          </div>
          <div className={`hero-sms-phase hero-sms-phase-${s.phase}`}>
            <span>{phaseText(s.phase)}</span>
            {s.phase === 'waiting' && <small>保持此页打开，每 5 秒自动检查一次</small>}
          </div>
          {s.code ? (
            <div className="hero-sms-code">
              <div>
                <span>验证码</span>
                <strong>{s.code}</strong>
              </div>
              <button className="button button-primary button-small" onClick={() => void m.copy(s.code, '验证码')}>
                <Icon name="link" size={14} />
                复制验证码
              </button>
            </div>
          ) : (
            <p className="hero-sms-waiting">
              <Icon name="clock" size={15} />
              短信到达后会在这里显示验证码。
            </p>
          )}
          {s.text && <p className="hero-sms-sms-text">{s.text}</p>}
          <dl className="hero-sms-detail">
            <div>
              <dt>激活 ID</dt>
              <dd>{s.id}</dd>
            </div>
            <div>
              <dt>服务</dt>
              <dd>
                {heroSmsServiceLabel(
                  o.services.find((i) => i.code === s.serviceCode) ?? { code: s.serviceCode, name: s.serviceCode },
                ) ||
                  s.serviceCode ||
                  '—'}
              </dd>
            </div>
            <div>
              <dt>号码地区</dt>
              <dd>{o.countries.find((i) => i.id === s.countryId)?.name || s.countryId || '—'}</dd>
            </div>
            <div>
              <dt>花费</dt>
              <dd>{money(s.cost, s.currency)}</dd>
            </div>
            <div>
              <dt>到期时间</dt>
              <dd>{s.endsAt ? new Date(s.endsAt).toLocaleString('zh-CN') : '—'}</dd>
            </div>
            <div>
              <dt>运营商</dt>
              <dd>{s.operator || '—'}</dd>
            </div>
          </dl>
          <div className="hero-sms-actions">
            <ConfirmButton
              className="button button-secondary button-small"
              armedLabel="确认重新发短信？"
              onConfirm={() => void m.resend()}
              disabled={Boolean(m.busy)}
            >
              重新发短信
            </ConfirmButton>
            <ConfirmButton
              className="button button-primary button-small"
              armedLabel="确认已完成？"
              onConfirm={() => void m.finish()}
              disabled={Boolean(m.busy) || !s.code}
            >
              标记已完成
            </ConfirmButton>
            <ConfirmButton
              className="button button-danger-quiet button-small"
              armedLabel="确认取消并释放号码？"
              onConfirm={() => void m.cancel()}
              disabled={Boolean(m.busy)}
            >
              取消号码
            </ConfirmButton>
          </div>
        </div>
      ) : (
        <EmptyState icon="phone" title="还没有活跃号码">
          在上方选服务和地区，购买后号码与验证码会显示在这里。
        </EmptyState>
      )}
    </section>
  );
}
function ActivationList({ model: m }: { model: Model }) {
  const o = m.overview!;
  return (
    <section className="panel hero-sms-active-list">
      <header className="panel-head">
        <div className="panel-title">
          <h2>活跃号码</h2>
          <p>来自 HeroSMS 的活跃激活列表；点一条可切到上方查看和操作。</p>
        </div>
        <button
          className="button button-secondary button-small"
          disabled={m.loading}
          onClick={() => void m.loadOverview()}
        >
          <Icon name="refresh" size={14} />
          {m.loading ? '刷新中…' : '刷新全部'}
        </button>
      </header>
      {o.activations.length ? (
        <div className="hero-sms-rows">
          {o.activations.map((i) => (
            <button
              key={i.id}
              className={`hero-sms-row ${i.id === m.selectedId ? 'is-active' : ''}`}
              onClick={() => m.setSelectedId(i.id)}
            >
              <span>
                <strong>{i.phone}</strong>
                <small>
                  {o.services.find((x) => x.code === i.serviceCode)
                    ? heroSmsServiceLabel(o.services.find((x) => x.code === i.serviceCode)!)
                    : i.serviceCode || i.id}
                </small>
              </span>
              <span>
                <em className={`hero-sms-phase hero-sms-phase-${i.phase}`}>{phaseText(i.phase)}</em>
                <small>
                  {i.code ? `验证码 ${i.code}` : i.createdAt ? new Date(i.createdAt).toLocaleString('zh-CN') : i.id}
                </small>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <EmptyState icon="clock" title="暂无活跃号码">
          这里只显示 HeroSMS 当前仍在等待、收到短信或可操作的号码。
        </EmptyState>
      )}
    </section>
  );
}
