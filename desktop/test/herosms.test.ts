import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HeroSmsClient,
  heroSmsServiceLabel,
  isHeroSmsOpenAiService,
  parseHeroSmsActivation,
  parseHeroSmsCountries,
  parseHeroSmsCountryOffers,
  parseHeroSmsOffer,
  parseHeroSmsServices,
  sortHeroSmsCountriesByOffer,
  type HeroSmsFetch
} from '../services/herosms.ts';
import { HeroSmsActivationStore, mergeHeroSmsActivations } from '../services/hero-sms-activations.ts';

function fetchFrom(handler: (url: URL) => { status?: number; body: string }): { fetch: HeroSmsFetch; calls: URL[] } {
  const calls: URL[] = [];
  return {
    calls,
    fetch: async url => {
      const parsed = new URL(url);
      calls.push(parsed);
      const response = handler(parsed);
      return { status: response.status ?? 200, text: async () => response.body };
    }
  };
}

test('HeroSMS parsers normalize countries, services, offers and active records', () => {
  assert.deepEqual(parseHeroSmsCountries({
    '6': { id: 6, eng: 'Indonesia', chn: '印度尼西亚' },
    '2': { id: 2, eng: 'Kazakhstan', chn: '哈萨克斯坦' }
  }), [
    { id: 2, name: '哈萨克斯坦', englishName: 'Kazakhstan' },
    { id: 6, name: '印度尼西亚', englishName: 'Indonesia' }
  ]);

  assert.deepEqual(parseHeroSmsServices({ status: 'success', services: [
    { code: 'tg', name: 'Telegram' },
    { code: 'wa', name: 'WhatsApp' }
  ] }), [
    { code: 'tg', name: 'Telegram' },
    { code: 'wa', name: 'WhatsApp' }
  ]);
  assert.equal(isHeroSmsOpenAiService({ code: 'dr', name: 'OpenAI' }), true);
  assert.equal(isHeroSmsOpenAiService({ code: 'x', name: 'ChatGPT Plus' }), true);
  assert.equal(heroSmsServiceLabel({ code: 'dr', name: 'OpenAI' }), 'OpenAI / ChatGPT（Codex）');
  assert.deepEqual(sortHeroSmsCountriesByOffer([
    { id: 3, name: '暂无报价', englishName: 'Unknown' },
    { id: 2, name: '无货国家', englishName: 'Sold Out' },
    { id: 1, name: '高价国家', englishName: 'Expensive' },
    { id: 4, name: '低价国家', englishName: 'Cheap' }
  ], {
    1: { cost: 0.2, count: 8 },
    2: { cost: 0.01, count: 0 },
    4: { cost: 0.05, count: 3 }
  }).map(item => item.id), [4, 1, 2, 3]);

  assert.deepEqual(parseHeroSmsOffer({ '6': { tg: { cost: '0.125', count: '18', physicalCount: 18 } } }), { cost: 0.125, count: 18 });
  assert.deepEqual(parseHeroSmsOffer({ '6': { tg: { cost: 0.2, count: 0 } } }), { cost: 0.2, count: 0 });
  assert.deepEqual(parseHeroSmsCountryOffers({
    '6': { dr: { cost: '0.22', count: '12' } },
    '2': { dr: { cost: 0.14, physicalCount: 3 } }
  }), [
    { countryId: 2, cost: 0.14, count: 3 },
    { countryId: 6, cost: 0.22, count: 12 }
  ]);

  const activation = parseHeroSmsActivation({
    activationId: '635468024',
    phoneNumber: '79584123456',
    serviceCode: 'tg',
    activationCost: 12.5,
    currency: 840,
    countryCode: 6,
    canGetAnotherSms: true,
    activationTime: '2026-02-18T16:11:33+00:00',
    activationEndTime: '2026-02-18T18:11:23+00:00',
    activationOperator: 'any',
    activationStatus: '4',
    smsCode: '12345',
    smsText: 'Telegram code 12345'
  });
  assert.equal(activation?.phase, 'code');
  assert.equal(activation?.code, '12345');
  assert.equal(activation?.currency, 'USD');
  assert.equal(activation?.phone, '79584123456');
});

test('HeroSMS client uses handler_api actions and maps a complete activation lifecycle', async () => {
  const { fetch, calls } = fetchFrom(url => {
    const action = url.searchParams.get('action');
    if (action === 'getBalance') return { body: 'ACCESS_BALANCE:4.25' };
    if (action === 'getCountries') return { body: JSON.stringify([{ id: 6, chn: '印度尼西亚', eng: 'Indonesia' }]) };
    if (action === 'getServicesList') return { body: JSON.stringify({ status: 'success', services: [{ code: 'tg', name: 'Telegram' }] }) };
    if (action === 'getActiveActivations') return { body: JSON.stringify({ status: 'success', data: [] }) };
    if (action === 'getPrices') return { body: JSON.stringify(url.searchParams.has('country')
      ? { '6': { tg: { cost: 0.12, count: 7 } } }
      : { '6': { tg: { cost: 0.12, count: 7 } }, '2': { tg: { cost: 0.18, count: 2 } } }) };
    if (action === 'getNumberV2') return { body: JSON.stringify({
      activationId: '777001', phoneNumber: '79584123456', serviceCode: 'tg', countryCode: 6,
      activationCost: 0.12, currency: 840, activationOperator: 'any', canGetAnotherSms: true
    }) };
    if (action === 'getStatus') return { body: 'STATUS_OK:654321' };
    if (action === 'setStatus') return { body: url.searchParams.get('status') === '3' ? 'ACCESS_RETRY_GET' : 'ACCESS_ACTIVATION' };
    return { status: 404, body: 'BAD_ACTION' };
  });
  const client = new HeroSmsClient({ apiKey: 'test key+value', fetch });

  assert.deepEqual(await client.getBalance(), { balance: 4.25, currency: 'USD' });
  assert.equal((await client.getCountries())[0].name, '印度尼西亚');
  assert.equal((await client.getServices())[0].code, 'tg');
  assert.deepEqual(await client.getActiveActivations(), []);
  assert.deepEqual(await client.getOffer('tg', 6), { cost: 0.12, count: 7 });
  assert.deepEqual(await client.getCountryOffers('tg'), [
    { countryId: 2, cost: 0.18, count: 2 },
    { countryId: 6, cost: 0.12, count: 7 }
  ]);

  const bought = await client.buyNumber('tg', 6, 0.12);
  assert.equal(bought.id, '777001');
  assert.equal(bought.phone, '79584123456');
  assert.equal(bought.phase, 'waiting');

  const status = await client.getActivation('777001');
  assert.equal(status.phase, 'code');
  assert.equal(status.code, '654321');
  assert.equal((await client.resend('777001')).code, '654321');
  await client.finish('777001');
  await client.cancel('777001');

  assert.equal(calls.every(url => url.searchParams.get('api_key') === 'test key+value'), true);
  assert.equal(calls.every(url => url.origin === 'https://hero-sms.com'), true);
  assert.equal(calls.some(url => url.searchParams.get('action') === 'getNumberV2' && url.searchParams.get('maxPrice') === '0.12' && url.searchParams.get('fixedPrice') === '1'), true);
  assert.equal(calls.some(url => url.searchParams.get('action') === 'setStatus' && url.searchParams.get('status') === '8'), true);
});

test('HeroSMS client rejects missing keys and turns API error tokens into readable errors', async () => {
  let called = false;
  const missing = new HeroSmsClient({
    apiKey: '',
    fetch: async () => { called = true; return { status: 200, text: async () => '' }; }
  });
  await assert.rejects(() => missing.getBalance(), /还没有配置 HeroSMS API Key/);
  assert.equal(called, false);

  const invalid = new HeroSmsClient({
    apiKey: 'bad',
    fetch: async () => ({ status: 200, text: async () => 'BAD_KEY' })
  });
  await assert.rejects(() => invalid.getBalance(), /API Key 无效/);

  const unauthorized = new HeroSmsClient({
    apiKey: 'bad',
    fetch: async () => ({ status: 401, text: async () => '{"title":"UNAUTHORIZED"}' })
  });
  await assert.rejects(() => unauthorized.getBalance(), /API Key 无效/);

  const network = new HeroSmsClient({
    apiKey: 'very-secret-key',
    fetch: async () => { throw new Error('failed https://hero-sms.com/?api_key=very-secret-key'); }
  });
  await assert.rejects(() => network.getBalance(), error => {
    assert.doesNotMatch(String(error), /very-secret-key/);
    assert.match(String(error), /HeroSMS 网络请求失败/);
    return true;
  });
});

test('HeroSMS local activation details fill in masked remote numbers and update status', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-herosms-'));
  const store = new HeroSmsActivationStore(dir);
  store.upsert({
    id: '777001', phone: '79584123456', serviceCode: 'tg', countryId: 6, cost: 0.12, currency: 'USD',
    createdAt: '2026-02-18T16:11:33Z', endsAt: '2026-02-18T18:11:23Z', canGetAnotherSms: true, operator: 'any',
    phase: 'waiting', code: '', text: '', receivedAt: ''
  });
  assert.equal(store.update('777001', { phase: 'code', code: '654321' })?.code, '654321');
  assert.equal(store.read()[0].phone, '79584123456');

  const merged = mergeHeroSmsActivations([{
    id: '777001', phone: '79********6', serviceCode: 'tg', countryId: 6, cost: null, currency: 'USD',
    createdAt: '', endsAt: '', canGetAnotherSms: false, operator: '', phase: 'unknown', code: '', text: '', receivedAt: ''
  }], store.read());
  assert.equal(merged[0].phone, '79584123456');
  assert.equal(merged[0].code, '654321');
  assert.equal(merged[0].cost, 0.12);

  store.remove('777001');
  assert.deepEqual(store.read(), []);
});
