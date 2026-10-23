import type {
  HeroSmsActivation,
  HeroSmsActivationStatus,
  HeroSmsCountry,
  HeroSmsCountryOffer,
  HeroSmsOffer,
  HeroSmsPhase,
  HeroSmsService
} from '../shared.ts';

/**
 * HeroSMS 官方开放 API 客户端。
 *
 * HeroSMS 兼容 SMS-Activate 的 handler_api 协议，所有动作都通过 GET 查询参数调用。
 * 这个模块不碰登录 cookie、不驱动网页；key 只由主进程从系统安全存储读出后放入 URL。
 */
export const HERO_SMS_API_URL = 'https://hero-sms.com/stubs/handler_api.php';

export type HeroSmsFetch = (
  url: string,
  init: { method: 'GET'; signal: AbortSignal }
) => Promise<{ status: number; text(): Promise<string> }>;

type HeroSmsClientOptions = {
  apiKey: string;
  fetch: HeroSmsFetch;
  timeoutMs?: number;
};

type JsonRecord = Record<string, unknown>;

class HeroSmsRequestError extends Error {}

const ERROR_MESSAGES: Record<string, string> = {
  BAD_KEY: 'HeroSMS API Key 无效，请在接码模块里重新填写',
  BAD_ACTION: 'HeroSMS 不支持这个 API 动作',
  BAD_SERVICE: '这个服务不受支持，请重新选择',
  BAD_COUNTRY: '这个国家或地区不受支持，请重新选择',
  NO_BALANCE: 'HeroSMS 余额不足，请先在官网充值',
  NO_NUMBERS: '当前服务和国家暂时没有可用号码',
  NO_ACTIVATION: '这个激活记录不存在或已经失效',
  BAD_STATUS: '激活状态不允许这个操作',
  EARLY_CANCEL_DENIED: '号码购买后暂时不能取消，请稍后再试'
};

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function valuesOf(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  const object = record(value);
  if (!object) return [];
  for (const key of keys) {
    const nested = object[key];
    if (Array.isArray(nested)) return nested;
    const nestedObject = record(nested);
    if (nestedObject) return Object.values(nestedObject);
  }
  return Object.values(object);
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value).trim();
}

function numberValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

export function heroSmsCurrency(value: unknown): string {
  const number = Number(value);
  if (number === 643) return 'RUB';
  if (number === 840 || !Number.isFinite(number)) return 'USD';
  if (number === 978) return 'EUR';
  if (number === 156) return 'CNY';
  return String(value || 'USD').trim().toUpperCase();
}

export function heroSmsErrorText(text: string, status = 0): string {
  const clean = text.trim();
  if (status === 401 || status === 403 || clean === 'BAD_KEY') return ERROR_MESSAGES.BAD_KEY;
  if (status === 402) return ERROR_MESSAGES.NO_BALANCE;

  const parsed = record(parseJson(clean));
  const info = record(parsed?.info);
  const detail = parsed
    ? [parsed.title, parsed.message, parsed.details, parsed.error, info?.message, info?.code].map(textValue).filter(Boolean).join('：')
    : '';
  const body = detail || clean;
  const token = Object.keys(ERROR_MESSAGES).find(item => body.includes(item));
  if (token) return ERROR_MESSAGES[token];
  if (status >= 400) return `HeroSMS 请求失败（HTTP ${status}）${body ? `：${body.slice(0, 240)}` : ''}`;
  return body ? `HeroSMS 返回异常：${body.slice(0, 240)}` : 'HeroSMS 返回了空响应';
}

export function parseHeroSmsCountries(value: unknown): HeroSmsCountry[] {
  return valuesOf(value, ['data', 'countries'])
    .map(item => record(item))
    .filter((item): item is JsonRecord => Boolean(item))
    .map(item => ({
      id: Number(item.id ?? item.countryId ?? item.country),
      name: textValue(item.chn ?? item.name ?? item.countryName ?? item.title ?? item.eng),
      englishName: textValue(item.eng ?? item.englishName ?? item.name)
    }))
    .filter(item => Number.isFinite(item.id) && item.name)
    .map(item => ({ ...item, englishName: item.englishName || item.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

export function parseHeroSmsServices(value: unknown): HeroSmsService[] {
  return valuesOf(value, ['services', 'data'])
    .map(item => {
      const row = record(item);
      if (row) return { code: textValue(row.code ?? row.serviceCode ?? row.id), name: textValue(row.name ?? row.serviceName ?? row.title ?? row.code) };
      const code = textValue(item);
      return code ? { code, name: code } : null;
    })
    .filter((item): item is HeroSmsService => Boolean(item?.code))
    .map(item => ({ ...item, name: item.name || item.code }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

/** HeroSMS 不单列 Codex；Codex / ChatGPT / OpenAI 的登录验证共用 OpenAI 这一项（常见代码为 dr）。 */
export function isHeroSmsOpenAiService(service: HeroSmsService): boolean {
  const value = `${service.code} ${service.name}`.toLowerCase();
  return service.code.toLowerCase() === 'dr' || /openai|chatgpt/.test(value);
}

export function heroSmsServiceLabel(service: HeroSmsService): string {
  return isHeroSmsOpenAiService(service) ? 'OpenAI / ChatGPT（Codex）' : service.name;
}

/** 国家选择列表按实时报价排序：有货低价优先，其次无货，最后暂无报价。 */
export function sortHeroSmsCountriesByOffer(
  countries: HeroSmsCountry[],
  offers: Readonly<Record<number, HeroSmsOffer>>
): HeroSmsCountry[] {
  const rank = (item: HeroSmsCountry): number => {
    const offer = offers[item.id];
    if (offer && offer.cost !== null && offer.count > 0) return 0;
    if (offer && offer.cost !== null) return 1;
    return 2;
  };
  return [...countries].sort((a, b) => {
    const rankDiff = rank(a) - rank(b);
    if (rankDiff) return rankDiff;
    const aOffer = offers[a.id];
    const bOffer = offers[b.id];
    const priceDiff = (aOffer?.cost ?? Number.POSITIVE_INFINITY) - (bOffer?.cost ?? Number.POSITIVE_INFINITY);
    if (priceDiff) return priceDiff;
    const countDiff = (bOffer?.count ?? 0) - (aOffer?.count ?? 0);
    return countDiff || a.name.localeCompare(b.name, 'zh-CN');
  });
}

export function parseHeroSmsOffer(value: unknown): HeroSmsOffer {
  let found: { cost: number | null; count: number } | null = null;
  const walk = (candidate: unknown, depth: number) => {
    if (depth > 5 || found) return;
    const row = record(candidate);
    if (!row) return;
    if ('count' in row || 'physicalCount' in row || 'cost' in row || 'retail_price' in row || 'price' in row) {
      const cost = numberValue(row.cost ?? row.retail_price ?? row.price);
      const count = numberValue(row.count ?? row.physicalCount ?? row.quantity);
      if (cost !== null || count !== null) {
        found = { cost, count: Math.max(0, Math.round(count ?? 0)) };
        return;
      }
    }
    for (const item of Object.values(row)) walk(item, depth + 1);
  };
  walk(value, 0);
  return found ?? { cost: null, count: 0 };
}

export function parseHeroSmsCountryOffers(value: unknown): HeroSmsCountryOffer[] {
  const root = Array.isArray(value)
    ? value.flatMap(item => {
        const row = record(item);
        return row ? Object.entries(row) : [];
      })
    : Object.entries(record(value) ?? {});
  const result: HeroSmsCountryOffer[] = [];

  const add = (country: unknown, offerValue: unknown) => {
    const countryId = Number(country);
    if (!Number.isInteger(countryId) || countryId < 0) return;
    const offer = parseHeroSmsOffer(offerValue);
    if (offer.cost === null && offer.count === 0) return;
    result.push({ countryId, cost: offer.cost, count: offer.count });
  };

  for (const [key, item] of root) {
    if (key === 'data' || key === 'prices') {
      const nested = record(item);
      for (const [country, offer] of Object.entries(nested ?? {})) add(country, offer);
      continue;
    }
    add(key, item);
  }

  return [...new Map(result.map(item => [item.countryId, item])).values()]
    .sort((a, b) => a.countryId - b.countryId);
}

function phaseFrom(value: string, hasCode: boolean): HeroSmsPhase {
  if (hasCode || value.includes('STATUS_OK')) return 'code';
  if (!value) return 'waiting';
  if (value.includes('CANCEL') || value.includes('CANCELED') || value.includes('CANCELLED')) return 'canceled';
  if (value.includes('RETRY') || value.includes('RESEND')) return 'retry';
  if (value.includes('WAIT') || value === '1') return 'waiting';
  if (value.includes('ACTIVATION') || value === '6' || value === '4') return 'completed';
  return 'unknown';
}

export function parseHeroSmsActivation(value: unknown): HeroSmsActivation | null {
  const row = record(value);
  if (!row) return null;
  const id = textValue(row.activationId ?? row.activation_id ?? row.id);
  const phone = textValue(row.phoneNumber ?? row.phone_number ?? row.phone ?? row.number);
  if (!id || !phone) return null;
  const code = textValue(row.smsCode ?? row.sms_code ?? row.code);
  const rawStatus = textValue(row.activationStatus ?? row.status ?? row.phase);
  return {
    id,
    phone,
    serviceCode: textValue(row.serviceCode ?? row.service ?? row.service_code),
    countryId: Number(row.countryCode ?? row.countryId ?? row.country ?? 0) || 0,
    cost: numberValue(row.activationCost ?? row.cost ?? row.price),
    currency: heroSmsCurrency(row.currency),
    createdAt: textValue(row.activationTime ?? row.createdAt ?? row.created_at ?? row.date),
    endsAt: textValue(row.activationEndTime ?? row.endsAt ?? row.ends_at),
    canGetAnotherSms: booleanValue(row.canGetAnotherSms ?? row.can_get_another_sms),
    operator: textValue(row.activationOperator ?? row.operator),
    phase: phaseFrom(rawStatus, Boolean(code)),
    code,
    text: textValue(row.smsText ?? row.sms_text ?? row.text),
    receivedAt: textValue(row.receivedAt ?? row.received_at ?? row.dateTime)
  };
}

function activeRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const row = record(value);
  if (!row) return [];
  for (const key of ['data', 'activations', 'items', 'results']) {
    const items = row[key];
    if (Array.isArray(items)) return items;
  }
  return [];
}

export class HeroSmsClient {
  private readonly apiKey: string;
  private readonly fetchImpl: HeroSmsFetch;
  private readonly timeoutMs: number;

  constructor(options: HeroSmsClientOptions) {
    this.apiKey = options.apiKey.trim();
    this.fetchImpl = options.fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private async request(action: string, params: Record<string, unknown> = {}): Promise<string> {
    if (!this.apiKey) throw new Error('还没有配置 HeroSMS API Key，请先在接码模块里填写');
    const url = new URL(HERO_SMS_API_URL);
    url.searchParams.set('action', action);
    url.searchParams.set('api_key', this.apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && String(value).trim() !== '') url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url.toString(), { method: 'GET', signal: controller.signal });
      const text = (await response.text()).trim();
      if (response.status >= 400) throw new HeroSmsRequestError(heroSmsErrorText(text, response.status));
      return text;
    } catch (error) {
      if (error instanceof Error && controller.signal.aborted) throw new Error('HeroSMS 请求超时，请检查网络后重试');
      if (error instanceof HeroSmsRequestError) throw error;
      if (error instanceof Error) {
        const detail = error.message
          .replaceAll(this.apiKey, '••••')
          .replace(/api_key=[^&\s]+/gi, 'api_key=••••')
          .trim()
          .slice(0, 240);
        throw new Error(detail ? `HeroSMS 网络请求失败：${detail}` : 'HeroSMS 网络请求失败，请检查网络后重试');
      }
      throw new Error('HeroSMS 网络请求失败，请检查网络后重试');
    } finally {
      clearTimeout(timer);
    }
  }

  async getBalance(): Promise<{ balance: number; currency: string }> {
    const text = await this.request('getBalance');
    if (text.startsWith('ACCESS_BALANCE:')) {
      const balance = Number(text.slice('ACCESS_BALANCE:'.length));
      if (Number.isFinite(balance)) return { balance, currency: 'USD' };
    }
    const parsed = record(parseJson(text));
    const data = record(parsed?.data);
    const balance = numberValue(data?.balance ?? parsed?.balance);
    if (balance !== null) return { balance, currency: heroSmsCurrency(data?.currency ?? parsed?.currency) };
    throw new Error(heroSmsErrorText(text));
  }

  async getCountries(): Promise<HeroSmsCountry[]> {
    const text = await this.request('getCountries');
    const countries = parseHeroSmsCountries(parseJson(text));
    if (!countries.length) throw new Error(heroSmsErrorText(text));
    return countries;
  }

  async getServices(): Promise<HeroSmsService[]> {
    const text = await this.request('getServicesList', { lang: 'cn' });
    const services = parseHeroSmsServices(parseJson(text));
    if (!services.length) throw new Error(heroSmsErrorText(text));
    return services;
  }

  async getActiveActivations(): Promise<HeroSmsActivation[]> {
    const text = await this.request('getActiveActivations', { limit: 100 });
    const parsed = parseJson(text);
    const activations = activeRows(parsed)
      .map(parseHeroSmsActivation)
      .filter((item): item is HeroSmsActivation => Boolean(item));
    if (!activations.length && Object.keys(ERROR_MESSAGES).some(token => text.includes(token))) throw new Error(heroSmsErrorText(text));
    return activations;
  }

  async getOffer(serviceCode: string, countryId: number): Promise<HeroSmsOffer> {
    const service = String(serviceCode ?? '').trim();
    const country = Math.round(Number(countryId));
    if (!service) throw new Error('请先选择服务');
    if (!Number.isFinite(country) || country < 0) throw new Error('请先选择国家或地区');
    const text = await this.request('getPrices', { service, country });
    return parseHeroSmsOffer(parseJson(text));
  }

  async getCountryOffers(serviceCode: string): Promise<HeroSmsCountryOffer[]> {
    const service = String(serviceCode ?? '').trim();
    if (!service) throw new Error('请先选择服务');
    const text = await this.request('getPrices', { service });
    return parseHeroSmsCountryOffers(parseJson(text));
  }

  async buyNumber(serviceCode: string, countryId: number, maxPrice?: number): Promise<HeroSmsActivation> {
    const service = String(serviceCode ?? '').trim();
    const country = Math.round(Number(countryId));
    if (!service || !Number.isFinite(country)) throw new Error('请先选择服务和号码国家');
    const price = Number(maxPrice);
    const text = await this.request('getNumberV2', {
      service,
      country,
      ...(Number.isFinite(price) && price > 0 ? { maxPrice: price, fixedPrice: '1' } : {})
    });
    const parsed = parseJson(text);
    const mapped = parseHeroSmsActivation(parsed);
    if (mapped) return mapped;

    // 部分账户仍可能走旧版返回：ACCESS_NUMBER:<id>:<phone>
    if (text.startsWith('ACCESS_NUMBER:')) {
      const [, id, phone] = text.split(':');
      if (id && phone) {
        return {
          id, phone, serviceCode: service, countryId: country, cost: null, currency: 'USD',
          createdAt: new Date().toISOString(), endsAt: '', canGetAnotherSms: false, operator: '',
          phase: 'waiting', code: '', text: '', receivedAt: ''
        };
      }
    }
    throw new Error(heroSmsErrorText(text));
  }

  async getActivation(id: string): Promise<HeroSmsActivationStatus> {
    const activationId = String(id ?? '').trim();
    if (!activationId) throw new Error('缺少激活 ID');
    const text = await this.request('getStatus', { id: activationId });
    const parsed = record(parseJson(text));
    const raw = parsed ? textValue(parsed.status ?? parsed.message ?? parsed.code) : text;
    const code = parsed ? textValue(parsed.code) : raw.startsWith('STATUS_OK:') ? raw.slice('STATUS_OK:'.length) : '';
    const phase = phaseFrom(raw, Boolean(code));
    if (phase === 'unknown' && /BAD_|NO_|ERROR/i.test(raw)) throw new Error(heroSmsErrorText(raw));
    return {
      id: activationId,
      phase,
      code,
      text: parsed ? textValue(parsed.text ?? parsed.smsText) : '',
      receivedAt: parsed ? textValue(parsed.receivedAt ?? parsed.dateTime) : '',
      message: phase === 'code' ? `验证码：${code}` : phase === 'waiting' ? '等待短信' : phase === 'retry' ? '等待重发' : phase === 'canceled' ? '已取消' : raw
    };
  }

  private async setStatus(id: string, status: 3 | 6 | 8): Promise<string> {
    const activationId = String(id ?? '').trim();
    if (!activationId) throw new Error('缺少激活 ID');
    const text = await this.request('setStatus', { id: activationId, status });
    const success = text.startsWith('ACCESS_') || text === '' || text === 'STATUS_OK';
    if (!success) throw new Error(heroSmsErrorText(text));
    return text;
  }

  async resend(id: string): Promise<HeroSmsActivationStatus> {
    await this.setStatus(id, 3);
    return this.getActivation(id);
  }

  async finish(id: string): Promise<void> {
    await this.setStatus(id, 6);
  }

  async cancel(id: string): Promise<void> {
    await this.setStatus(id, 8);
  }
}
