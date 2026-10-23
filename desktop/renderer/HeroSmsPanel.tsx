import { useCallback, useEffect, useRef, useState } from 'react';
import type { HeroSmsActivation, HeroSmsActivationStatus, HeroSmsOffer, HeroSmsOverview } from '../shared';
import { heroSmsServiceLabel, isHeroSmsOpenAiService, sortHeroSmsCountriesByOffer } from '../services/herosms';
import { ConfirmButton, EmptyState, Icon, readableError } from './ui';

type Props = { active: boolean; notify: (message: string) => void };
const SERVICE_KEY = 'sydney.hero-sms.service';
const COUNTRY_KEY = 'sydney.hero-sms.country';

function savedValue(key: string): string {
  try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
}

function persist(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* 只影响下次默认选项 */ }
}

function money(value: number | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const number = Number(value);
  const sign = currency === 'EUR' ? '€' : currency === 'CNY' ? '¥' : currency === 'RUB' ? '₽' : '$';
  return `${sign}${number.toFixed(Math.abs(number) > 0 && Math.abs(number) < 0.01 ? 3 : 2)}`;
}

function phaseText(value: HeroSmsActivation['phase']): string {
  return ({ waiting: '等待短信', code: '验证码已到', retry: '等待重发', canceled: '已取消', completed: '已完成', unknown: '状态未知' })[value];
}

function mergeStatus(activation: HeroSmsActivation, status: HeroSmsActivationStatus): HeroSmsActivation {
  return {
    ...activation,
    phase: status.phase,
    code: status.code || activation.code,
    text: status.text || activation.text,
    receivedAt: status.receivedAt || activation.receivedAt
  };
}

export default function HeroSmsPanel({ active, notify }: Props) {
  const [keyStatus, setKeyStatus] = useState({ configured: false, masked: '', encryptionAvailable: true });
  const [keyDraft, setKeyDraft] = useState('');
  const [overview, setOverview] = useState<HeroSmsOverview | null>(null);
  const [serviceCode, setServiceCode] = useState(() => savedValue(SERVICE_KEY));
  const [countryId, setCountryId] = useState<number | ''>(() => {
    const raw = savedValue(COUNTRY_KEY);
    const saved = Number(raw);
    return raw.trim() && Number.isFinite(saved) && saved >= 0 ? saved : '';
  });
  const [serviceSearch, setServiceSearch] = useState('');
  const [countrySearch, setCountrySearch] = useState('');
  const [offer, setOffer] = useState<HeroSmsOffer | null>(null);
  const [countryOffers, setCountryOffers] = useState<Record<number, HeroSmsOffer>>({});
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const [offersBusy, setOffersBusy] = useState(false);
  const [error, setError] = useState('');
  const notifiedCode = useRef('');

  const loadOverview = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError('');
    try {
      const next = await window.sydney.getHeroSmsOverview();
      setOverview(next);
      setServiceCode(current => current && next.services.some(item => item.code === current)
        ? current
        : next.services.find(item => item.code === 'tg')?.code ?? next.services[0]?.code ?? '');
      setCountryId(current => current !== '' && next.countries.some(item => item.id === Number(current))
        ? Number(current)
        : '');
      setSelectedId(current => current && next.activations.some(item => item.id === current)
        ? current
        : next.activations[0]?.id ?? '');
    } catch (issue) {
      setError(readableError(issue));
      if (!quiet) notify(readableError(issue));
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    let alive = true;
    void window.sydney.getHeroSmsKeyStatus().then(status => {
      if (!alive) return;
      setKeyStatus(status);
      if (status.configured) void loadOverview(true);
    }).catch(issue => { if (alive) setError(readableError(issue)); });
    return () => { alive = false; };
  }, [loadOverview]);

  useEffect(() => {
    if (serviceCode) persist(SERVICE_KEY, serviceCode);
  }, [serviceCode]);

  useEffect(() => {
    if (countryId !== '') persist(COUNTRY_KEY, String(countryId));
  }, [countryId]);

  useEffect(() => {
    setCountryOffers({});
    setOffer(null);
    if (!keyStatus.configured || !overview || !serviceCode) return;
    let cancelled = false;
    setOffersBusy(true);
    void window.sydney.getHeroSmsCountryOffers(serviceCode).then(rows => {
      if (!cancelled) {
        setCountryOffers(Object.fromEntries(rows.map(item => [item.countryId, { cost: item.cost, count: item.count }])));
      }
    }).catch(issue => {
      if (!cancelled) setError(readableError(issue));
    }).finally(() => {
      if (!cancelled) setOffersBusy(false);
    });
    return () => { cancelled = true; };
  }, [keyStatus.configured, Boolean(overview), serviceCode]);

  useEffect(() => {
    if (countryId === '') {
      setOffer(null);
      return;
    }
    setOffer(countryOffers[countryId] ?? null);
  }, [countryId, countryOffers]);

  const selected = overview?.activations.find(item => item.id === selectedId) ?? null;
  const selectedService = overview?.services.find(item => item.code === serviceCode) ?? null;
  const selectedCountry = overview?.countries.find(item => item.id === countryId) ?? null;

  const refreshActivation = useCallback(async (quiet = false) => {
    if (!selectedId) return;
    if (!quiet) setBusy('refresh');
    try {
      const next = await window.sydney.getHeroSmsActivation(selectedId);
      setOverview(current => current ? {
        ...current,
        activations: current.activations.map(item => item.id === selectedId ? mergeStatus(item, next) : item)
      } : current);
      if (next.code && next.code !== notifiedCode.current) {
        notifiedCode.current = next.code;
        notify(`收到验证码：${next.code}`);
      }
    } catch (issue) {
      if (!quiet) notify(readableError(issue));
      else setError(readableError(issue));
    } finally {
      if (!quiet) setBusy('');
    }
  }, [selectedId, notify]);

  useEffect(() => {
    notifiedCode.current = '';
    setError('');
  }, [selectedId]);

  useEffect(() => {
    if (!active || !selectedId || !selected) return;
    if (selected.phase === 'code' || selected.phase === 'canceled' || selected.phase === 'completed') return;
    void refreshActivation(true);
    const timer = window.setInterval(() => void refreshActivation(true), 5_000);
    return () => window.clearInterval(timer);
  }, [active, selectedId, selected?.phase, refreshActivation]);

  const saveKey = async () => {
    if (!keyDraft.trim()) return;
    setBusy('save-key');
    setError('');
    try {
      const next = await window.sydney.saveHeroSmsKey(keyDraft);
      setKeyStatus(next);
      setKeyDraft('');
      notify('HeroSMS API Key 已安全保存');
      await loadOverview(true);
    } catch (issue) {
      notify(readableError(issue));
    } finally {
      setBusy('');
    }
  };

  const testKey = async () => {
    setBusy('test-key');
    try {
      const result = await window.sydney.testHeroSmsKey();
      notify(`HeroSMS 连接正常，余额 ${money(result.balance, result.currency)}`);
    } catch (issue) {
      notify(readableError(issue));
    } finally {
      setBusy('');
    }
  };

  const buy = async () => {
    if (!serviceCode || countryId === '') return;
    setBusy('buy');
    setError('');
    try {
      const activation = await window.sydney.buyHeroSmsNumber(serviceCode, Number(countryId), offer?.cost ?? undefined);
      setOverview(current => current ? {
        ...current,
        balance: Math.max(0, current.balance - (activation.cost ?? offer?.cost ?? 0)),
        activations: [activation, ...current.activations]
      } : current);
      setSelectedId(activation.id);
      notifiedCode.current = '';
      setCountryOffers(current => {
        const currentOffer = current[Number(countryId)];
        return currentOffer ? { ...current, [countryId]: { ...currentOffer, count: Math.max(0, currentOffer.count - 1) } } : current;
      });
      notify(`已购号 ${activation.phone}，正在等短信`);
    } catch (issue) {
      notify(readableError(issue));
    } finally {
      setBusy('');
    }
  };

  const resend = async () => {
    if (!selectedId) return;
    setBusy('resend');
    try {
      const next = await window.sydney.resendHeroSmsCode(selectedId);
      setOverview(current => current ? {
        ...current,
        activations: current.activations.map(item => item.id === selectedId
          ? { ...mergeStatus(item, next), code: next.code, text: next.text, receivedAt: next.receivedAt }
          : item)
      } : current);
      notifiedCode.current = '';
      notify('已请求 HeroSMS 重新发送短信');
    } catch (issue) {
      notify(readableError(issue));
    } finally {
      setBusy('');
    }
  };

  const finish = async () => {
    if (!selectedId) return;
    setBusy('finish');
    try {
      await window.sydney.finishHeroSmsActivation(selectedId);
      notify('这单号码已标记完成');
      await loadOverview(true);
    } catch (issue) {
      notify(readableError(issue));
    } finally {
      setBusy('');
    }
  };

  const cancel = async () => {
    if (!selectedId) return;
    setBusy('cancel');
    try {
      await window.sydney.cancelHeroSmsActivation(selectedId);
      notify('已取消这单号码；能否退款以 HeroSMS 返回为准');
      await loadOverview(true);
    } catch (issue) {
      notify(readableError(issue));
    } finally {
      setBusy('');
    }
  };

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify(`已复制${label}`);
    } catch {
      notify('复制失败，请手动选择文本');
    }
  };

  const services = (overview?.services ?? []).filter(item => {
    const query = serviceSearch.trim().toLocaleLowerCase();
    const aliases = isHeroSmsOpenAiService(item) ? ' codex openai chatgpt' : '';
    return !query || `${item.name} ${item.code}${aliases}`.toLocaleLowerCase().includes(query);
  }).slice(0, 220);
  if (selectedService && !services.some(item => item.code === selectedService.code)) services.unshift(selectedService);
  const filteredCountries = (overview?.countries ?? []).filter(item => {
    const query = countrySearch.trim().toLocaleLowerCase();
    return !query || item.name.toLocaleLowerCase().includes(query) || item.englishName.toLocaleLowerCase().includes(query) || String(item.id).includes(query);
  }).slice(0, 220);
  const countries = serviceCode
    ? sortHeroSmsCountriesByOffer(filteredCountries, countryOffers)
    : filteredCountries;
  if (selectedCountry && !countries.some(item => item.id === selectedCountry.id)) countries.unshift(selectedCountry);
  const openAiService = overview?.services.find(isHeroSmsOpenAiService) ?? null;

  return <div className="hero-sms">
    <section className="panel hero-sms-key-card">
      <header className="panel-head">
        <div className="panel-title">
          <h2><Icon name="key" size={17} />HeroSMS 开放 API</h2>
          <p>号码、余额、价格和短信状态都直接请求官方接口。Key 使用系统安全存储加密，不进入页面会话或普通配置文件。</p>
        </div>
        <span className={`badge ${keyStatus.configured ? 'badge-on' : 'badge-off'}`}>{keyStatus.configured ? `已配置 ${keyStatus.masked}` : '未配置 Key'}</span>
      </header>
      {!keyStatus.configured ? <div className="hero-sms-key-setup">
        <label className="field"><span>HeroSMS API Key</span>
          <input className="input" type="password" autoComplete="off" value={keyDraft} onChange={event => setKeyDraft(event.target.value)}
            placeholder="在 HeroSMS 用户中心生成 API Key" onKeyDown={event => { if (event.key === 'Enter') void saveKey(); }} />
        </label>
        <button className="button button-primary" disabled={busy === 'save-key' || !keyDraft.trim()} onClick={() => void saveKey()}>
          <Icon name="shield" />{busy === 'save-key' ? '保存中…' : '安全保存'}
        </button>
        <button className="button button-secondary" onClick={() => void window.sydney.openEmbeddedInBrowser('heroSms')}><Icon name="window" />打开 HeroSMS</button>
      </div> : <div className="hero-sms-key-actions">
        <span><Icon name="shield" size={14} />Key 只由主进程读取，每次请求按官方协议发送给 HeroSMS。</span>
        <button className="button button-secondary button-small" disabled={Boolean(busy)} onClick={() => void testKey()}>{busy === 'test-key' ? '测试中…' : '测试连接'}</button>
        <button className="button button-quiet button-small" onClick={() => void window.sydney.openEmbeddedInBrowser('heroSms')}><Icon name="window" size={14} />官网充值</button>
        <ConfirmButton className="button button-danger-quiet button-small" armedLabel="确认删除本机 Key？" onConfirm={() => void window.sydney.deleteHeroSmsKey().then(next => {
          setKeyStatus(next);
          if (next.configured) void loadOverview(true); else setOverview(null);
          notify(next.configured ? '已删除本机保存的 Key，当前仍在使用环境变量' : '已删除本机保存的 HeroSMS Key');
        }).catch(issue => notify(readableError(issue)))}>删除本机 Key</ConfirmButton>
        <details className="hero-sms-key-replace">
          <summary>更换 Key</summary>
          <div>
            <input className="input" type="password" autoComplete="off" value={keyDraft} onChange={event => setKeyDraft(event.target.value)} placeholder="输入新的 API Key" />
            <button className="button button-primary button-small" disabled={!keyDraft.trim() || busy === 'save-key'} onClick={() => void saveKey()}>保存</button>
          </div>
        </details>
      </div>}
    </section>

    {error && <p className="site-error" role="alert"><Icon name="alert" size={14} /><span>{error}</span></p>}
    {keyStatus.configured && (loading && !overview ? <section className="panel hero-sms-loading"><Icon name="refresh" />正在从 HeroSMS 读取余额、服务和活跃号码…</section> : overview && <>
      <div className="hero-sms-metrics">
        <div><span>账户余额</span><strong>{money(overview.balance, overview.currency)}</strong><small>{overview.currency}</small></div>
        <div><span>活跃号码</span><strong>{overview.activations.length}</strong><small>最多显示 100 条</small></div>
        <div><span>可选服务</span><strong>{overview.services.length}</strong><small>国家和价格实时查询</small></div>
        <div><span>最近刷新</span><strong>{new Date(overview.refreshedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</strong><small>短信每 5 秒自动轮询</small></div>
      </div>

      <div className="hero-sms-workbench">
        <section className="panel hero-sms-buy-card">
          <header className="panel-head">
            <div className="panel-title"><h2><Icon name="phone" size={17} />购买临时号码</h2><p>先选服务和号码国家，再查库存与报价。HeroSMS 不单列 Codex，Codex / ChatGPT 的验证统一选「OpenAI / ChatGPT（Codex）」。</p></div>
          </header>
          <div className="hero-sms-selectors">
            <div className="hero-sms-filter">
              <label className="field"><span>搜索服务</span><input className="input" value={serviceSearch} onChange={event => setServiceSearch(event.target.value)} placeholder="例如 Codex、OpenAI、Telegram、微信" /></label>
              <label className="field"><span>服务</span>
                <select className="input" value={serviceCode} onChange={event => setServiceCode(event.target.value)}>
                  <option value="">选择服务</option>
                  {services.map(item => <option key={item.code} value={item.code}>{heroSmsServiceLabel(item)} · {item.code}</option>)}
                </select>
              </label>
              {openAiService && <button type="button" className="chip chip-accent hero-sms-quick-pick" onClick={() => { setServiceSearch(''); setServiceCode(openAiService.code); }}>
                Codex / OpenAI
              </button>}
            </div>
            <div className="hero-sms-filter">
              <label className="field"><span>搜索国家 / 地区</span><input className="input" value={countrySearch} onChange={event => setCountrySearch(event.target.value)} placeholder="中文、英文或国家 ID" /></label>
              <label className="field"><span>号码国家 / 地区 · 价格从低到高</span>
                <select className="input" value={countryId} onChange={event => setCountryId(event.target.value ? Number(event.target.value) : '')}>
                  <option value="">{offersBusy ? '正在查询各国价格…' : '选择国家 / 地区'}</option>
                  {countries.map(item => {
                    const price = countryOffers[item.id];
                    const detail = !serviceCode
                      ? '先选服务'
                      : price
                      ? `${money(price.cost, overview.currency)} · ${price.count > 0 ? `${price.count} 个` : '无号'}`
                      : offersBusy ? '价格查询中…' : '暂无报价';
                    return <option key={item.id} value={item.id}>{item.name}{item.englishName !== item.name ? ` · ${item.englishName}` : ''} · {detail}</option>;
                  })}
                </select>
              </label>
            </div>
          </div>
          <div className="hero-sms-quote">
            <div>
              <span>当前报价</span>
              <strong>{offersBusy ? '查询中…' : offer ? money(offer.cost, overview.currency) : '—'}</strong>
              <small>{offer ? `可用号码 ${offer.count} 个` : serviceCode && countryId !== '' ? '这个国家当前没有报价' : '选好服务和地区后显示'}</small>
            </div>
            <ConfirmButton className="button button-primary" disabled={offersBusy || !offer || offer.count < 1 || offer.cost === null}
              armedLabel={offer?.cost !== null && offer?.cost !== undefined ? `确认花费 ${money(offer.cost, overview.currency)} 购号？` : '确认购买号码？'}
              onConfirm={() => void buy()}>
              <Icon name="plus" />{busy === 'buy' ? '购买中…' : '购买号码'}
            </ConfirmButton>
          </div>
          <p className="site-privacy">价格与库存由 HeroSMS 实时返回。购买会占用真实余额；最近购号明细只存本机，用途是在远端把号码打码时仍能补全。是否退款以 HeroSMS 结果为准。</p>
        </section>

        <section className="panel hero-sms-current">
          <header className="panel-head">
            <div className="panel-title"><h2><Icon name="inbox" size={17} />当前号码</h2><p>收到验证码后先复制使用，再手动「标记已完成」。取消号码会调用官方释放接口。</p></div>
            {selected && <button className="button button-quiet button-small" disabled={Boolean(busy)} onClick={() => void refreshActivation()}><Icon name="refresh" size={14} />{busy === 'refresh' ? '刷新中…' : '刷新短信'}</button>}
          </header>
          {selected ? <div className="hero-sms-current-body">
            <div className="hero-sms-phone">
              <div><span>手机号</span><strong>{selected.phone}</strong></div>
              <button className="button button-secondary button-small" onClick={() => void copy(selected.phone, '号码')}><Icon name="link" size={14} />复制号码</button>
            </div>
            <div className={`hero-sms-phase hero-sms-phase-${selected.phase}`}><span>{phaseText(selected.phase)}</span>{selected.phase === 'waiting' && <small>保持此页打开，每 5 秒自动检查一次</small>}</div>
            {selected.code ? <div className="hero-sms-code">
              <div><span>验证码</span><strong>{selected.code}</strong></div>
              <button className="button button-primary button-small" onClick={() => void copy(selected.code, '验证码')}><Icon name="link" size={14} />复制验证码</button>
            </div> : <p className="hero-sms-waiting"><Icon name="clock" size={15} />短信到达后会在这里显示验证码。</p>}
            {selected.text && <p className="hero-sms-sms-text">{selected.text}</p>}
            <dl className="hero-sms-detail">
              <div><dt>激活 ID</dt><dd>{selected.id}</dd></div>
              <div><dt>服务</dt><dd>{heroSmsServiceLabel(overview.services.find(item => item.code === selected.serviceCode) ?? { code: selected.serviceCode, name: selected.serviceCode }) || selected.serviceCode || '—'}</dd></div>
              <div><dt>号码地区</dt><dd>{overview.countries.find(item => item.id === selected.countryId)?.name || selected.countryId || '—'}</dd></div>
              <div><dt>花费</dt><dd>{money(selected.cost, selected.currency)}</dd></div>
              <div><dt>到期时间</dt><dd>{selected.endsAt ? new Date(selected.endsAt).toLocaleString('zh-CN') : '—'}</dd></div>
              <div><dt>运营商</dt><dd>{selected.operator || '—'}</dd></div>
            </dl>
            <div className="hero-sms-actions">
              <ConfirmButton className="button button-secondary button-small" armedLabel="确认重新发短信？" onConfirm={() => void resend()} disabled={Boolean(busy)}>重新发短信</ConfirmButton>
              <ConfirmButton className="button button-primary button-small" armedLabel="确认已完成？" onConfirm={() => void finish()} disabled={Boolean(busy) || !selected.code}>标记已完成</ConfirmButton>
              <ConfirmButton className="button button-danger-quiet button-small" armedLabel="确认取消并释放号码？" onConfirm={() => void cancel()} disabled={Boolean(busy)}>取消号码</ConfirmButton>
            </div>
          </div> : <EmptyState icon="phone" title="还没有活跃号码">在上方选服务和地区，购买后号码与验证码会显示在这里。</EmptyState>}
        </section>
      </div>

      <section className="panel hero-sms-active-list">
        <header className="panel-head">
          <div className="panel-title"><h2>活跃号码</h2><p>来自 HeroSMS 的活跃激活列表；点一条可切到上方查看和操作。</p></div>
          <button className="button button-secondary button-small" disabled={loading} onClick={() => void loadOverview()}><Icon name="refresh" size={14} />{loading ? '刷新中…' : '刷新全部'}</button>
        </header>
        {overview.activations.length ? <div className="hero-sms-rows">
          {overview.activations.map(item => <button key={item.id} className={`hero-sms-row ${item.id === selectedId ? 'is-active' : ''}`} onClick={() => setSelectedId(item.id)}>
            <span><strong>{item.phone}</strong><small>{overview.services.find(service => service.code === item.serviceCode) ? heroSmsServiceLabel(overview.services.find(service => service.code === item.serviceCode)!) : item.serviceCode || item.id}</small></span>
            <span><em className={`hero-sms-phase hero-sms-phase-${item.phase}`}>{phaseText(item.phase)}</em><small>{item.code ? `验证码 ${item.code}` : item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : item.id}</small></span>
          </button>)}
        </div> : <EmptyState icon="clock" title="暂无活跃号码">这里只显示 HeroSMS 当前仍在等待、收到短信或可操作的号码。</EmptyState>}
      </section>
    </>)}
  </div>;
}
