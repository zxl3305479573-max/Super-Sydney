import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContentDirection, ContentTask, ContentTaxonomy, ImageCandidateBundle } from '../../shared';
import { buildPipeline, currentStepKey, type PipelineStepKey } from '../../services/content-pipeline';
import { profileDefaultSubdirection } from '../content-taxonomy';
import { readableError } from '../ui';
import { type Env } from './format';
import { useContentAssets } from './steps';

export type Lane = 'main' | 'cover';
export const BOTH_LANES: Lane[] = ['main', 'cover'];
export const laneSlot = (id: number, lane: Lane) => (lane === 'main' ? String(id) : `${id}:cover`);

export function useElapsed(since: number): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    setSeconds(0);
    if (!since) return;
    const tick = () => setSeconds(Math.max(0, Math.round((Date.now() - since) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  return seconds;
}

/** State and passive refreshes for one native article workspace. */
export function useNativeContentState(profile: ContentDirection | null, notify: (message: string) => void) {
  const directionId = profile?.id ?? null;
  const [allTasks, setTasks] = useState<ContentTask[]>([]);
  const tasks = useMemo(
    () => allTasks.filter((task) => task.directionId === directionId || task.directionId === null),
    [allTasks, directionId],
  );
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [taxonomy, setTaxonomy] = useState<ContentTaxonomy | null>(null);
  const [subdirectionId, setSubdirectionId] = useState<number | null>(null);
  const [topicSeed, setTopicSeed] = useState('');
  const [jobs, setJobs] = useState<Record<string, { key: string; since: number }>>({});
  const [env, setEnv] = useState<Env>({ wechatConfigured: false });
  const [mode, setMode] = useState<'pipeline' | 'board'>('pipeline');
  const [step, setStep] = useState<PipelineStepKey>('topic');
  const [dirty, setDirty] = useState(false);
  const [candidateCount, setCandidateCount] = useState(1);
  const [candidateSheets, setCandidateSheets] = useState<Record<number, ImageCandidateBundle>>({});
  const categoryPicked = useRef(false);
  const selected = tasks.find((item) => item.id === selectedId) ?? null;
  const selectedRef = useRef<number | null>(null);
  selectedRef.current = selectedId;
  const busy = selectedId !== null ? (jobs[laneSlot(selectedId, 'main')]?.key ?? '') : '';
  const coverBusy = selectedId !== null ? (jobs[laneSlot(selectedId, 'cover')]?.key ?? '') : '';
  const busySeconds = useElapsed(selectedId !== null ? (jobs[laneSlot(selectedId, 'main')]?.since ?? 0) : 0);
  const coverSeconds = useElapsed(selectedId !== null ? (jobs[laneSlot(selectedId, 'cover')]?.since ?? 0) : 0);
  const candidateSheet = selectedId !== null ? (candidateSheets[selectedId] ?? null) : null;
  const setCandidateSheet = (id: number, bundle: ImageCandidateBundle | null) =>
    setCandidateSheets((current) => {
      const next = { ...current };
      if (bundle) next[id] = bundle;
      else delete next[id];
      return next;
    });
  const setJob = (id: number, key: string, lanes: Lane[] = ['main']) =>
    setJobs((current) => {
      const next = { ...current };
      for (const lane of lanes) {
        const slot = laneSlot(id, lane);
        if (key) next[slot] = { key, since: current[slot]?.since ?? Date.now() };
        else delete next[slot];
      }
      return next;
    });
  const onTask = (id: number) => selectedRef.current === id;
  const selectSubdirection = (value: number | null) => {
    categoryPicked.current = true;
    setSubdirectionId(value);
  };
  const pipeline = useMemo(() => (selected ? buildPipeline(selected, env) : []), [selected, env]);
  const assets = useContentAssets(selected?.id ?? 0, selected?.updatedAt ?? '');
  const refresh = useCallback(async () => {
    const next = await window.sydney.listContentTasks();
    setTasks(next);
    const visible = next.filter((task) => task.directionId === directionId || task.directionId === null);
    setSelectedId((current) =>
      current && visible.some((task) => task.id === current) ? current : (visible[0]?.id ?? null),
    );
  }, [directionId]);
  useEffect(() => {
    void refresh().catch((error) => notify(readableError(error)));
  }, [refresh, notify]);
  const refreshEnvironment = useCallback(async () => {
    const [next, tree] = await Promise.all([window.sydney.getWeWriteEnvironment(), window.sydney.getContentTaxonomy()]);
    setEnv({ wechatConfigured: next.wechatConfigured });
    setTaxonomy(tree);
    if (!categoryPicked.current) setSubdirectionId(profileDefaultSubdirection(tree, directionId));
  }, [directionId]);
  useEffect(() => {
    void refreshEnvironment().catch(() => undefined);
  }, [refreshEnvironment]);
  useEffect(
    () =>
      window.sydney.onWeWriteChanged(() => {
        void refreshEnvironment().catch(() => undefined);
      }),
    [refreshEnvironment],
  );
  useEffect(() => {
    if (selected && !dirty) setStep(currentStepKey(selected, env));
  }, [selectedId]);
  return {
    directionId,
    tasks,
    setTasks,
    selectedId,
    setSelectedId,
    taxonomy,
    subdirectionId,
    setSubdirectionId,
    selectSubdirection,
    topicSeed,
    setTopicSeed,
    jobs,
    setJobs,
    env,
    mode,
    setMode,
    step,
    setStep,
    dirty,
    setDirty,
    candidateCount,
    setCandidateCount,
    selected,
    selectedRef,
    busy,
    coverBusy,
    busySeconds,
    coverSeconds,
    candidateSheet,
    setCandidateSheet,
    setJob,
    onTask,
    pipeline,
    assets,
  };
}
