import type { ContentDirection } from '../shared';
import { NativeContentEditor } from './native-content/NativeContentEditor';
import { NativeContentHeader } from './native-content/NativeContentHeader';
import { TaskList } from './native-content/TaskList';
import { Board } from './native-content/steps';
import { useNativeContentActions } from './native-content/useNativeContentActions';
import { laneSlot, useNativeContentState } from './native-content/useNativeContentState';

export default function NativeContentPanel({
  profile,
  notify,
  onOpenConfig,
  onOpenBackend,
}: {
  profile: ContentDirection | null;
  notify: (message: string) => void;
  onOpenConfig: () => void;
  onOpenBackend: () => void;
}) {
  const state = useNativeContentState(profile, notify);
  const actions = useNativeContentActions(state, notify, onOpenBackend);
  return (
    <section className="native-content">
      <NativeContentHeader
        profile={profile}
        taxonomy={state.taxonomy}
        directionId={state.directionId}
        subdirectionId={state.subdirectionId}
        topicSeed={state.topicSeed}
        creating={Boolean(state.jobs[laneSlot(-1, 'main')])}
        mode={state.mode}
        onSubdirection={state.selectSubdirection}
        onTopicSeed={state.setTopicSeed}
        onCreate={() => void actions.create()}
        onMode={state.setMode}
        onOpenConfig={onOpenConfig}
      />
      {state.mode === 'board' ? (
        <Board tasks={state.tasks} env={state.env} onOpen={actions.openTask} />
      ) : (
        <div className="native-layout">
          <TaskList
            tasks={state.tasks}
            env={state.env}
            selectedId={state.selectedId}
            jobs={state.jobs}
            onOpen={actions.openTask}
          />
          <NativeContentEditor state={state} actions={actions} notify={notify} />
        </div>
      )}
    </section>
  );
}
