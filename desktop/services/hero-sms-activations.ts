import fs from 'node:fs';
import path from 'node:path';
import type { HeroSmsActivation, HeroSmsPhase } from '../shared.ts';
import { writeFileAtomic } from './atomic-file.ts';

/**
 * 本机的 HeroSMS 号码明细。
 *
 * 活跃列表接口可能把号码打码（例如 79********1），而购号接口会返回完整号码。
 * 这里只留最近 20 条本机购号结果，和远端活跃列表按激活 ID 合并，重启后仍能复制完整号码。
 * 文件在 userData 内、权限 0600；不包含 API Key。
 */
export class HeroSmsActivationStore {
  private readonly file: string;

  constructor(directory: string) {
    this.file = path.join(directory, 'hero-sms-activations.json');
  }

  read(): HeroSmsActivation[] {
    if (!fs.existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { activations?: unknown };
      if (!Array.isArray(parsed.activations)) return [];
      return parsed.activations.map(normalizeActivation).filter((item): item is HeroSmsActivation => Boolean(item));
    } catch {
      return [];
    }
  }

  upsert(activation: HeroSmsActivation): void {
    const rows = this.read().filter(item => item.id !== activation.id);
    this.write([activation, ...rows].slice(0, 20));
  }

  update(id: string, patch: Partial<HeroSmsActivation>): HeroSmsActivation | null {
    const rows = this.read();
    const current = rows.find(item => item.id === id);
    if (!current) return null;
    const next = { ...current, ...patch, id };
    if (JSON.stringify(next) === JSON.stringify(current)) return current;
    this.write([next, ...rows.filter(item => item.id !== id)]);
    return next;
  }

  remove(id: string): void {
    const rows = this.read();
    if (!rows.some(item => item.id === id)) return;
    this.write(rows.filter(item => item.id !== id));
  }

  private write(activations: HeroSmsActivation[]): void {
    writeFileAtomic(this.file, JSON.stringify({ activations }), { mode: 0o600 });
  }
}

const PHASES: HeroSmsPhase[] = ['waiting', 'code', 'retry', 'canceled', 'completed', 'unknown'];

function normalizeActivation(value: unknown): HeroSmsActivation | null {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!row) return null;
  const id = String(row.id ?? '').trim();
  const phone = String(row.phone ?? '').trim();
  if (!id || !phone) return null;
  const phase = PHASES.includes(row.phase as HeroSmsPhase) ? row.phase as HeroSmsPhase : 'unknown';
  const cost = Number(row.cost);
  return {
    id,
    phone,
    serviceCode: String(row.serviceCode ?? ''),
    countryId: Number(row.countryId) || 0,
    cost: Number.isFinite(cost) ? cost : null,
    currency: String(row.currency ?? 'USD'),
    createdAt: String(row.createdAt ?? ''),
    endsAt: String(row.endsAt ?? ''),
    canGetAnotherSms: Boolean(row.canGetAnotherSms),
    operator: String(row.operator ?? ''),
    phase,
    code: String(row.code ?? ''),
    text: String(row.text ?? ''),
    receivedAt: String(row.receivedAt ?? '')
  };
}

/** 远端决定哪些号码仍是活跃的；本机明细只补全被打码的号码与空字段。 */
export function mergeHeroSmsActivations(remote: HeroSmsActivation[], local: HeroSmsActivation[]): HeroSmsActivation[] {
  const mine = new Map(local.map(item => [item.id, item]));
  return remote.map(item => {
    const saved = mine.get(item.id);
    if (!saved) return item;
    return {
      ...saved,
      ...item,
      phone: item.phone.includes('*') && !saved.phone.includes('*') ? saved.phone : item.phone,
      serviceCode: item.serviceCode || saved.serviceCode,
      countryId: item.countryId || saved.countryId,
      cost: item.cost ?? saved.cost,
      currency: item.currency || saved.currency,
      createdAt: item.createdAt || saved.createdAt,
      endsAt: item.endsAt || saved.endsAt,
      canGetAnotherSms: item.canGetAnotherSms || saved.canGetAnotherSms,
      operator: item.operator || saved.operator,
      phase: item.phase === 'unknown' ? saved.phase : item.phase,
      code: item.code || saved.code,
      text: item.text || saved.text,
      receivedAt: item.receivedAt || saved.receivedAt
    };
  });
}
