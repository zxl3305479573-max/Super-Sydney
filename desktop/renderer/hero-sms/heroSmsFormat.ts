import type { HeroSmsActivation, HeroSmsActivationStatus } from '../../shared';

export const SERVICE_KEY = 'sydney.hero-sms.service';
export const COUNTRY_KEY = 'sydney.hero-sms.country';
export const savedValue = (key: string) => {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
};
export const persist = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* only changes the next default */
  }
};
export function money(value: number | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const number = Number(value);
  const sign = currency === 'EUR' ? '€' : currency === 'CNY' ? '¥' : currency === 'RUB' ? '₽' : '$';
  return `${sign}${number.toFixed(Math.abs(number) > 0 && Math.abs(number) < 0.01 ? 3 : 2)}`;
}
export const phaseText = (value: HeroSmsActivation['phase']) =>
  ({
    waiting: '等待短信',
    code: '验证码已到',
    retry: '等待重发',
    canceled: '已取消',
    completed: '已完成',
    unknown: '状态未知',
  })[value];
export const mergeStatus = (activation: HeroSmsActivation, status: HeroSmsActivationStatus): HeroSmsActivation => ({
  ...activation,
  phase: status.phase,
  code: status.code || activation.code,
  text: status.text || activation.text,
  receivedAt: status.receivedAt || activation.receivedAt,
});
