import type { ContentDirection, ContentTaxonomy } from '../../shared';
import ContentSettingsPanel from '../ContentSettings';
import { subdirectionsOf } from '../content-taxonomy';
import { ModuleToolbar } from '../ui';

export function NativeContentHeader({
  profile,
  taxonomy,
  directionId,
  subdirectionId,
  topicSeed,
  creating,
  mode,
  onSubdirection,
  onTopicSeed,
  onCreate,
  onMode,
  onOpenConfig,
}: {
  profile: ContentDirection | null;
  taxonomy: ContentTaxonomy | null;
  directionId: number | null;
  subdirectionId: number | null;
  topicSeed: string;
  creating: boolean;
  mode: 'pipeline' | 'board';
  onSubdirection: (value: number | null) => void;
  onTopicSeed: (value: string) => void;
  onCreate: () => void;
  onMode: (value: 'pipeline' | 'board') => void;
  onOpenConfig: () => void;
}) {
  return (
    <>
      <ContentSettingsPanel profile={profile} onOpenConfig={onOpenConfig} />
      <ModuleToolbar className="native-create" label="新建文章任务">
        <label>
          <span>具体方向</span>
          <select value={subdirectionId ?? ''} onChange={(event) => onSubdirection(Number(event.target.value) || null)}>
            <option value="">未指定</option>
            {subdirectionsOf(taxonomy?.directions ?? [], directionId).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="native-topic-seed">
          <span>已有选题或方向（可选）</span>
          <input
            value={topicSeed}
            onChange={(event) => onTopicSeed(event.target.value)}
            placeholder="例如：柚子和常用药物的相互作用"
          />
        </label>
        <button className="button button-primary" disabled={creating} onClick={onCreate}>
          新建文章任务
        </button>
        <div className="flow-mode" role="tablist" aria-label="视图">
          <button
            role="tab"
            aria-selected={mode === 'pipeline'}
            className={mode === 'pipeline' ? 'is-active' : ''}
            onClick={() => onMode('pipeline')}
          >
            单篇流水线
          </button>
          <button
            role="tab"
            aria-selected={mode === 'board'}
            className={mode === 'board' ? 'is-active' : ''}
            onClick={() => onMode('board')}
          >
            全局看板
          </button>
        </div>
      </ModuleToolbar>
    </>
  );
}
