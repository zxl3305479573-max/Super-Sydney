import { useCallback, useEffect, useRef, useState } from 'react';
import type { HeroSmsOffer, HeroSmsOverview } from '../../shared';
import { isHeroSmsOpenAiService, sortHeroSmsCountriesByOffer } from '../../services/herosms';
import { readableError } from '../ui';
import { COUNTRY_KEY, SERVICE_KEY, mergeStatus, money, persist, savedValue } from './heroSmsFormat';

export function useHeroSmsWorkspace(active: boolean, notify: (message: string) => void) {
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

  const loadOverview = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      setError('');
      try {
        const next = await window.sydney.getHeroSmsOverview();
        setOverview(next);
        setServiceCode((current) =>
          current && next.services.some((item) => item.code === current)
            ? current
            : (next.services.find((item) => item.code === 'tg')?.code ?? next.services[0]?.code ?? ''),
        );
        setCountryId((current) =>
          current !== '' && next.countries.some((item) => item.id === Number(current)) ? Number(current) : '',
        );
        setSelectedId((current) =>
          current && next.activations.some((item) => item.id === current) ? current : (next.activations[0]?.id ?? ''),
        );
      } catch (issue) {
        setError(readableError(issue));
        if (!quiet) notify(readableError(issue));
      } finally {
        setLoading(false);
      }
    },
    [notify],
  );

  useEffect(() => {
    let alive = true;
    void window.sydney
      .getHeroSmsKeyStatus()
      .then((status) => {
        if (!alive) return;
        setKeyStatus(status);
        if (status.configured) void loadOverview(true);
      })
      .catch((issue) => {
        if (alive) setError(readableError(issue));
      });
    return () => {
      alive = false;
    };
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
    void window.sydney
      .getHeroSmsCountryOffers(serviceCode)
      .then((rows) => {
        if (!cancelled) {
          setCountryOffers(
            Object.fromEntries(rows.map((item) => [item.countryId, { cost: item.cost, count: item.count }])),
          );
        }
      })
      .catch((issue) => {
        if (!cancelled) setError(readableError(issue));
      })
      .finally(() => {
        if (!cancelled) setOffersBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [keyStatus.configured, Boolean(overview), serviceCode]);

  useEffect(() => {
    if (countryId === '') {
      setOffer(null);
      return;
    }
    setOffer(countryOffers[countryId] ?? null);
  }, [countryId, countryOffers]);

  const selected = overview?.activations.find((item) => item.id === selectedId) ?? null;
  const selectedService = overview?.services.find((item) => item.code === serviceCode) ?? null;
  const selectedCountry = overview?.countries.find((item) => item.id === countryId) ?? null;

  const refreshActivation = useCallback(
    async (quiet = false) => {
      if (!selectedId) return;
      if (!quiet) setBusy('refresh');
      try {
        const next = await window.sydney.getHeroSmsActivation(selectedId);
        setOverview((current) =>
          current
            ? {
                ...current,
                activations: current.activations.map((item) =>
                  item.id === selectedId ? mergeStatus(item, next) : item,
                ),
              }
            : current,
        );
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
    },
    [selectedId, notify],
  );

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
      setOverview((current) =>
        current
          ? {
              ...current,
              balance: Math.max(0, current.balance - (activation.cost ?? offer?.cost ?? 0)),
              activations: [activation, ...current.activations],
            }
          : current,
      );
      setSelectedId(activation.id);
      notifiedCode.current = '';
      setCountryOffers((current) => {
        const currentOffer = current[Number(countryId)];
        return currentOffer
          ? { ...current, [countryId]: { ...currentOffer, count: Math.max(0, currentOffer.count - 1) } }
          : current;
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
      setOverview((current) =>
        current
          ? {
              ...current,
              activations: current.activations.map((item) =>
                item.id === selectedId
                  ? { ...mergeStatus(item, next), code: next.code, text: next.text, receivedAt: next.receivedAt }
                  : item,
              ),
            }
          : current,
      );
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

  const services = (overview?.services ?? [])
    .filter((item) => {
      const query = serviceSearch.trim().toLocaleLowerCase();
      const aliases = isHeroSmsOpenAiService(item) ? ' codex openai chatgpt' : '';
      return !query || `${item.name} ${item.code}${aliases}`.toLocaleLowerCase().includes(query);
    })
    .slice(0, 220);
  if (selectedService && !services.some((item) => item.code === selectedService.code))
    services.unshift(selectedService);
  const filteredCountries = (overview?.countries ?? [])
    .filter((item) => {
      const query = countrySearch.trim().toLocaleLowerCase();
      return (
        !query ||
        item.name.toLocaleLowerCase().includes(query) ||
        item.englishName.toLocaleLowerCase().includes(query) ||
        String(item.id).includes(query)
      );
    })
    .slice(0, 220);
  const countries = serviceCode ? sortHeroSmsCountriesByOffer(filteredCountries, countryOffers) : filteredCountries;
  if (selectedCountry && !countries.some((item) => item.id === selectedCountry.id)) countries.unshift(selectedCountry);
  const openAiService = overview?.services.find(isHeroSmsOpenAiService) ?? null;

  const deleteKey = () =>
    void window.sydney
      .deleteHeroSmsKey()
      .then((next) => {
        setKeyStatus(next);
        if (next.configured) void loadOverview(true);
        else setOverview(null);
        notify(next.configured ? '已删除本机保存的 Key，当前仍在使用环境变量' : '已删除本机保存的 HeroSMS Key');
      })
      .catch((issue) => notify(readableError(issue)));

  return {
    keyStatus,
    keyDraft,
    setKeyDraft,
    overview,
    serviceCode,
    setServiceCode,
    countryId,
    setCountryId,
    serviceSearch,
    setServiceSearch,
    countrySearch,
    setCountrySearch,
    offer,
    countryOffers,
    selectedId,
    setSelectedId,
    busy,
    loading,
    offersBusy,
    error,
    selected,
    services,
    countries,
    openAiService,
    loadOverview,
    refreshActivation,
    saveKey,
    testKey,
    buy,
    resend,
    finish,
    cancel,
    copy,
    deleteKey,
  };
}
