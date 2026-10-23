import { ipcMain, net } from 'electron';
import type { AppContext } from '../app-context';
import type { HeroSmsOverview } from '../shared';
import { mergeHeroSmsActivations } from '../services/hero-sms-activations';
import { HeroSmsClient, type HeroSmsFetch } from '../services/herosms';

/**
 * 接码模块的 HeroSMS 开放 API。
 *
 * 网络走 Electron net.fetch，跟随系统代理；key 只在主进程读出，
 * 不通过 state:get 或任何事件发给渲染进程。
 */
export function registerHeroSmsIpc(ctx: AppContext): void {
  const client = () => new HeroSmsClient({
    apiKey: ctx.heroSmsApiKey(),
    // net.fetch 与浏览器 fetch 的响应接口一致；这里收窄成客户端需要的最小接口。
    fetch: ((url, init) => net.fetch(url, init)) as HeroSmsFetch
  });

  const status = () => {
    const stored = ctx.heroSmsKeyStore.getStatus();
    return !stored.configured && (process.env.HERO_SMS_API_KEY ?? '').trim()
      ? { ...stored, configured: true, masked: '（来自环境变量 HERO_SMS_API_KEY）' }
      : stored;
  };

  ipcMain.handle('hero-sms:key:status', () => status());
  ipcMain.handle('hero-sms:key:save', (_event, value: string) => {
    ctx.heroSmsKeyStore.save(String(value ?? ''));
    return status();
  });
  ipcMain.handle('hero-sms:key:delete', () => {
    ctx.heroSmsKeyStore.remove();
    return status();
  });
  ipcMain.handle('hero-sms:key:test', async () => client().getBalance());

  ipcMain.handle('hero-sms:overview', async (): Promise<HeroSmsOverview> => {
    const api = client();
    const [account, countries, services, remoteActivations] = await Promise.all([
      api.getBalance(),
      api.getCountries(),
      api.getServices(),
      api.getActiveActivations()
    ]);
    const activations = mergeHeroSmsActivations(remoteActivations, ctx.heroSmsActivations.read());
    return {
      balance: account.balance,
      currency: account.currency,
      countries,
      services,
      activations,
      refreshedAt: new Date().toISOString()
    };
  });
  ipcMain.handle('hero-sms:offer', (_event, serviceCode: string, countryId: number) =>
    client().getOffer(String(serviceCode ?? ''), Number(countryId)));
  ipcMain.handle('hero-sms:country-offers', (_event, serviceCode: string) =>
    client().getCountryOffers(String(serviceCode ?? '')));
  ipcMain.handle('hero-sms:buy', async (_event, serviceCode: string, countryId: number, maxPrice?: number) => {
    const activation = await client().buyNumber(String(serviceCode ?? ''), Number(countryId), Number(maxPrice));
    ctx.heroSmsActivations.upsert(activation);
    return activation;
  });
  ipcMain.handle('hero-sms:activation:get', async (_event, id: string) => {
    const status = await client().getActivation(String(id ?? ''));
    ctx.heroSmsActivations.update(status.id, { phase: status.phase, code: status.code, text: status.text, receivedAt: status.receivedAt });
    return status;
  });
  ipcMain.handle('hero-sms:activation:resend', async (_event, id: string) => {
    const status = await client().resend(String(id ?? ''));
    ctx.heroSmsActivations.update(status.id, { phase: status.phase, code: status.code, text: status.text, receivedAt: status.receivedAt });
    return status;
  });
  ipcMain.handle('hero-sms:activation:finish', async (_event, id: string) => {
    const activationId = String(id ?? '');
    await client().finish(activationId);
    ctx.heroSmsActivations.remove(activationId);
  });
  ipcMain.handle('hero-sms:activation:cancel', async (_event, id: string) => {
    const activationId = String(id ?? '');
    await client().cancel(activationId);
    ctx.heroSmsActivations.remove(activationId);
  });
}
