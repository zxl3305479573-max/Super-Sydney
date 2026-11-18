import {
  VIDEO_MOTION_PRESETS,
  VIDEO_SOUND_EFFECTS,
  type VideoProject,
  type VideoShot,
  type VideoShotRole
} from '../../shared';
import { formatDuration, narrationCoverage, serializeVideoShots } from '../../services/video-pipeline';
import { VIDEO_SHOT_ROLES } from '../../services/video-production';
import { Icon, readableError } from '../ui';
import { estimatedSpokenSeconds } from './format';

export function ScriptStep({
  project,
  script,
  targetDuration,
  busy,
  onChange,
  onGenerate,
  onAutoScriptAndStoryboard,
  onSave,
  onNextStep
}: {
  project: VideoProject;
  script: string;
  targetDuration: number;
  busy: string;
  onChange: (value: string) => void;
  onGenerate: () => void;
  onAutoScriptAndStoryboard: () => void;
  onSave: () => void;
  onNextStep: () => void;
}) {
  const locked = Boolean(busy);
  const charLen = script.replace(/\s+/g, '').length;
  const est = estimatedSpokenSeconds(script);
  const hasTitle = Boolean((project.title || project.topic).trim());

  return (
    <section className="flow-panel">
      <header className="flow-panel-head">
        <div>
          <h3>口播脚本</h3>
          <p>第一句直接进痛点、场景或结论，只放可直接朗读的纯口播词；改完脚本后重新拆分镜即可同步全链路。</p>
        </div>
        <span className="video-step-stat">
          约 {charLen} 字 · 预计朗读 {formatDuration(est)} / 目标 {formatDuration(targetDuration)}
        </span>
      </header>

      <textarea
        className="flow-draft"
        disabled={locked}
        value={script}
        onChange={event => onChange(event.target.value)}
        placeholder="在这里编写或粘贴口播稿；也可点下方「AI 生成口播脚本」按简报里的讲解结构自动起稿…"
      />

      <div className="flow-inline-actions">
        <button type="button" className="button button-primary" disabled={locked || !hasTitle} onClick={onGenerate}>
          {busy === 'script' ? '生成中…' : script.trim() ? '重新 AI 生成脚本' : 'AI 生成口播脚本'}
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={locked || !hasTitle}
          title="一次完成「口播脚本 → 分镜拆解」（不触发付费生图与配音）"
          onClick={onAutoScriptAndStoryboard}
        >
          {busy === 'auto-text' ? '连续生成中…' : '一键生成脚本 + 分镜'}
        </button>
        <button type="button" className="button button-secondary" disabled={locked} onClick={onSave}>
          {busy === 'save' ? '保存中…' : '保存脚本'}
        </button>
        <button type="button" className="button button-quiet" disabled={locked} onClick={onNextStep}>
          下一步：分镜编排 →
        </button>
      </div>
    </section>
  );
}

function reindexShots(list: VideoShot[]): VideoShot[] {
  return list.map((shot, idx) => ({ ...shot, index: idx + 1 }));
}

export function StoryboardStep({
  projectId,
  shots,
  rawJson,
  script,
  busy,
  onReplaceShots,
  onRawJsonChange,
  onGenerate,
  onSave,
  onNextStep,
  notify
}: {
  projectId: number;
  shots: VideoShot[];
  rawJson: string;
  script: string;
  busy: string;
  onReplaceShots: (next: VideoShot[]) => void;
  onRawJsonChange: (raw: string) => void;
  onGenerate: () => void;
  onSave: () => void;
  onNextStep: () => void;
  notify: (message: string) => void;
}) {
  const locked = Boolean(busy);
  const totalSeconds = shots.reduce((sum, item) => sum + item.seconds, 0);
  const coverage = shots.length ? narrationCoverage(script, shots) : 1;

  const patchShot = (position: number, patch: Partial<VideoShot>) => {
    onReplaceShots(shots.map((shot, index) => (index === position ? { ...shot, ...patch } : shot)));
  };

  const insertAfter = (position: number) => {
    const templateShot: VideoShot = {
      index: position + 2,
      seconds: 5,
      role: 'step',
      caption: '新增要点',
      narration: '',
      visual: '清晰展示核心动作与日常场景',
      imagePrompt: '',
      motion: 'auto',
      soundEffect: 'none',
      soundEffectPath: '',
      soundEffectVolume: 24,
      soundEffectAt: 0
    };
    const next = [...shots.slice(0, position + 1), templateShot, ...shots.slice(position + 1)];
    onReplaceShots(reindexShots(next));
  };

  const removeAt = (position: number) => {
    if (shots.length <= 1) {
      notify('至少保留 1 个镜头');
      return;
    }
    onReplaceShots(reindexShots(shots.filter((_, index) => index !== position)));
  };

  const moveShot = (position: number, delta: -1 | 1) => {
    const target = position + delta;
    if (target < 0 || target >= shots.length) return;
    const copy = [...shots];
    const [moved] = copy.splice(position, 1);
    copy.splice(target, 0, moved);
    onReplaceShots(reindexShots(copy));
  };

  const chooseLocalSfx = (position: number) => {
    void window.sydney.chooseVideoSoundEffect(projectId)
      .then(file => { if (file) patchShot(position, { soundEffectPath: file }); })
      .catch(error => notify(readableError(error)));
  };

  return (
    <section className="flow-panel">
      <header className="flow-panel-head">
        <div>
          <h3>分镜工作区</h3>
          <p>逐镜调整作用、画面大字（支持【重点】高亮，同步作为 B 站章节标题）、口播、运镜与音效；改一镜只重算那一镜素材。</p>
        </div>
        <span className="video-step-stat">
          {shots.length} 个镜头 · 预计 {formatDuration(totalSeconds)}
        </span>
      </header>

      {shots.length > 0 && script.trim() && coverage < 0.8 && (
        <p className="flow-attention-note">
          当前分镜口播仅覆盖了脚本 {Math.round(coverage * 100)}% 的句子——配音与字幕全部取自镜头口播，漏掉的句子不会出现在成片中，建议补齐或重新拆分镜。
        </p>
      )}

      {shots.length ? (
        <div className="flow-table-wrap">
          <table className="flow-table video-storyboard-table" aria-label="可编辑分镜表">
            <thead>
              <tr>
                <th>镜号</th>
                <th>作用与秒数</th>
                <th>画面大字（≤12字）</th>
                <th>这一镜口播</th>
                <th>画面说明 / 配图提示词</th>
                <th>运镜与点缀音效</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {shots.map((shot, position) => (
                <tr key={`${shot.index}-${position}`}>
                  <td className="video-shot-index-cell"><strong>#{shot.index}</strong></td>
                  <td>
                    <div className="video-shot-stack">
                      <select
                        className="flow-table-control"
                        disabled={locked}
                        value={shot.role ?? ''}
                        onChange={event => patchShot(position, { role: event.target.value as VideoShotRole | '' })}
                      >
                        <option value="">未分类</option>
                        {VIDEO_SHOT_ROLES.map(role => <option key={role.value} value={role.value}>{role.label}</option>)}
                      </select>
                      <label className="video-shot-inline-num">
                        <span>预计秒数</span>
                        <input
                          className="flow-table-control video-shot-seconds"
                          disabled={locked}
                          type="number"
                          min={1}
                          max={60}
                          value={shot.seconds}
                          onChange={event => patchShot(position, { seconds: Math.min(60, Math.max(1, Number(event.target.value) || 1)) })}
                        />
                      </label>
                    </div>
                  </td>
                  <td>
                    <input
                      className="flow-table-control"
                      disabled={locked}
                      value={shot.caption}
                      onChange={event => patchShot(position, { caption: event.target.value })}
                      placeholder="例如：记住【三个半分钟】"
                    />
                  </td>
                  <td>
                    <textarea
                      className="flow-table-control"
                      disabled={locked}
                      rows={3}
                      value={shot.narration}
                      onChange={event => patchShot(position, { narration: event.target.value })}
                      placeholder="这一镜朗读的口播词（进 TTS 与字幕）"
                    />
                  </td>
                  <td>
                    <div className="video-shot-stack">
                      <textarea
                        className="flow-table-control"
                        disabled={locked}
                        rows={2}
                        value={shot.visual}
                        onChange={event => patchShot(position, { visual: event.target.value })}
                        placeholder="画面描述"
                      />
                      <input
                        className="flow-table-control"
                        disabled={locked}
                        value={shot.imagePrompt ?? ''}
                        onChange={event => patchShot(position, { imagePrompt: event.target.value })}
                        placeholder="AI 生图提示词（留空沿用画面描述）"
                      />
                    </div>
                  </td>
                  <td>
                    <div className="video-shot-sfx">
                      <select
                        className="flow-table-control"
                        disabled={locked}
                        aria-label="运镜方式"
                        value={shot.motion ?? 'auto'}
                        onChange={event => patchShot(position, { motion: event.target.value as VideoShot['motion'] })}
                      >
                        {VIDEO_MOTION_PRESETS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                      </select>
                      <select
                        className="flow-table-control"
                        disabled={locked}
                        aria-label="内置音效"
                        value={shot.soundEffect ?? 'none'}
                        onChange={event => patchShot(position, { soundEffect: event.target.value as VideoShot['soundEffect'] })}
                      >
                        {VIDEO_SOUND_EFFECTS.map(item => <option key={item.value} value={item.value}>音效：{item.label}</option>)}
                      </select>
                      <div className="video-shot-sfx-row">
                        <button type="button" className="button button-quiet button-small" disabled={locked} onClick={() => chooseLocalSfx(position)}>
                          {shot.soundEffectPath ? '换音效文件' : '本地音效'}
                        </button>
                        {shot.soundEffectPath && (
                          <button type="button" className="button button-quiet button-small" disabled={locked} onClick={() => patchShot(position, { soundEffectPath: '' })}>
                            清除
                          </button>
                        )}
                      </div>
                      {(shot.soundEffect && shot.soundEffect !== 'none') || shot.soundEffectPath ? (
                        <div className="video-shot-sfx-nums">
                          <label title="音效音量百分比">
                            <span>音量%</span>
                            <input
                              className="flow-table-control video-shot-seconds"
                              disabled={locked}
                              type="number"
                              min={0}
                              max={100}
                              value={shot.soundEffectVolume ?? 24}
                              onChange={event => patchShot(position, { soundEffectVolume: Math.min(100, Math.max(0, Number(event.target.value) || 0)) })}
                            />
                          </label>
                          <label title="相对本镜起点的延迟秒数">
                            <span>延迟s</span>
                            <input
                              className="flow-table-control video-shot-seconds"
                              disabled={locked}
                              type="number"
                              min={0}
                              max={30}
                              step={0.1}
                              value={shot.soundEffectAt ?? 0}
                              onChange={event => patchShot(position, { soundEffectAt: Math.min(30, Math.max(0, Number(event.target.value) || 0)) })}
                            />
                          </label>
                        </div>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <div className="video-shot-row-actions">
                      <button type="button" className="icon-button" disabled={locked || position === 0} title="上移一镜" onClick={() => moveShot(position, -1)}>↑</button>
                      <button type="button" className="icon-button" disabled={locked || position === shots.length - 1} title="下移一镜" onClick={() => moveShot(position, 1)}>↓</button>
                      <button type="button" className="icon-button" disabled={locked} title="在下方插入一镜" onClick={() => insertAfter(position)}><Icon name="plus" size={13} /></button>
                      <button type="button" className="icon-button" disabled={locked || shots.length <= 1} title="删除这一镜" onClick={() => removeAt(position)}><Icon name="trash" size={13} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flow-empty-box">
          <p className="flow-empty">还没有分镜。可点下方「AI 拆解分镜」，或手动新建第一个镜头。</p>
          <button
            type="button"
            className="button button-secondary button-small"
            disabled={locked}
            onClick={() => onReplaceShots([{
              index: 1,
              seconds: 5,
              role: 'hook',
              caption: '核心看点',
              narration: script.trim().split(/\n+/)[0] ?? '',
              visual: '开场主画面',
              imagePrompt: '',
              motion: 'auto',
              soundEffect: 'none',
              soundEffectVolume: 24,
              soundEffectAt: 0
            }])}
          >
            <Icon name="plus" size={14} />手动添加第 1 镜
          </button>
        </div>
      )}

      {rawJson.trim() && (
        <details className="flow-secondary-tools">
          <summary><span>直接编辑分镜 JSON（进阶）</span><small>保存时自动校验结构，格式错误不会清空现有分镜</small></summary>
          <textarea
            className="flow-draft"
            style={{ minHeight: 180 }}
            disabled={locked}
            value={rawJson || serializeVideoShots(shots)}
            onChange={event => onRawJsonChange(event.target.value)}
          />
        </details>
      )}

      <div className="flow-inline-actions">
        <button type="button" className="button button-primary" disabled={locked || !script.trim()} onClick={onGenerate}>
          {busy === 'storyboard' ? '拆解中…' : shots.length ? '重新 AI 拆解分镜' : 'AI 拆解分镜'}
        </button>
        <button type="button" className="button button-secondary" disabled={locked} onClick={onSave}>
          {busy === 'save' ? '保存中…' : '保存分镜'}
        </button>
        <button type="button" className="button button-quiet" disabled={locked} onClick={onNextStep}>
          下一步：声音字幕 →
        </button>
      </div>
    </section>
  );
}
