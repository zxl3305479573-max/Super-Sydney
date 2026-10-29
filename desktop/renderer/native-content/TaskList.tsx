import type { ContentTask } from '../../shared';
import { buildPipeline, currentStepKey } from '../../services/content-pipeline';
import { shortTime } from '../ui';
import type { Env } from './format';
import { taskScopeLabel } from '../content-taxonomy';

export function TaskList({
  tasks,
  env,
  selectedId,
  jobs,
  onOpen,
}: {
  tasks: ContentTask[];
  env: Env;
  selectedId: number | null;
  jobs: Record<string, { key: string; since: number }>;
  onOpen: (task: ContentTask) => void;
}) {
  const laneSlot = (id: number, lane: 'main' | 'cover') => (lane === 'main' ? String(id) : `${id}:cover`);
  return (
    <aside className="native-task-list">
      <div className="native-list-head">
        <h2>文章任务</h2>
        <span>{tasks.length}</span>
      </div>
      {tasks.length ? (
        tasks.map((task) => {
          const steps = buildPipeline(task, env);
          const current = steps.find((item) => item.key === currentStepKey(task, env));
          return (
            <button
              key={task.id}
              className={`native-task ${selectedId === task.id ? 'is-selected' : ''}`}
              onClick={() => onOpen(task)}
            >
              <strong>{task.title || task.topic || taskScopeLabel(task)}</strong>
              <span>
                {taskScopeLabel(task)} ·{' '}
                {steps.every((item) => item.state === 'done') ? '已完成' : `第 ${current?.index} 步 ${current?.label}`}
              </span>
              <div className="flow-mini" aria-hidden="true">
                {steps.map((item) => (
                  <i key={item.key} className={`flow-mini-${item.state}`} />
                ))}
              </div>
              <small>
                {jobs[laneSlot(task.id, 'main')] || jobs[laneSlot(task.id, 'cover')]
                  ? '处理中…'
                  : shortTime(task.updatedAt)}
              </small>
            </button>
          );
        })
      ) : (
        <p className="native-empty">还没有文章任务</p>
      )}
    </aside>
  );
}
