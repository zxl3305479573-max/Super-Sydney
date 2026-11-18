import { useEffect, useRef, useState } from 'react';
import {
  VIDEO_BGM_STYLES,
  type VideoBgmMode,
  type VideoBgmStyle,
  type VideoProject,
  type VideoShot,
  type VideoTtsSettings,
  type VideoTtsStatus,
  type VideoVoiceMode,
  type VideoWorkflow
} from '../../shared';
import { buildSrt, buildTimeline, formatDuration, shotDurations } from '../../services/video-pipeline';
import { describeVoiceProfile, parseVoiceProfile, shotAudio, voiceCoverage } from '../../services/video-production';
import { Icon, readableError } from '../ui';
import { isExternalSkillWorkflow } from './format';

export function VoiceStep({
  project,
  shots,
  workflow,
  voiceMode,
  bgmMode,
  bgmStyle,
  resolvedBgmStyleLabel,
  bgmVolume,
  bgmDucking,
  bgmFadeIn,
  bgmFadeOut,
  busy,
  onVoiceMode,
  onBgmMode,
  onBgmStyle,
  onBgmVolume,
  onBgmDucking,
  onBgmFadeIn,
  onBgmFadeOut,
  onChooseBgm,
  onGenerateVoice,
  onSave,
  onNextStep,
  notify
}: {
  project: VideoProject;
  shots: VideoShot[];
  workflow: VideoWorkflow;
  voiceMode: VideoVoiceMode;
  bgmMode: VideoBgmMode;
  bgmStyle: VideoBgmStyle;
  resolvedBgmStyleLabel: string;
  bgmVolume: number;
  bgmDucking: boolean;
  bgmFadeIn: number;
  bgmFadeOut: number;
  busy: string;
  onVoiceMode: (mode: VideoVoiceMode) => void;
  onBgmMode: (mode: VideoBgmMode) => void;
  onBgmStyle: (style: VideoBgmStyle) => void;
  onBgmVolume: (volume: number) => void;
  onBgmDucking: (ducking: boolean) => void;
  onBgmFadeIn: (seconds: number) => void;
  onBgmFadeOut: (seconds: number) => void;
  onChooseBgm: () => void;
  onGenerateVoice: (force: boolean) => void;
  onSave: () => void;
  onNextStep: () => void;
  notify: (message: string) => void;
}) {
  const locked = Boolean(busy);
  const externalSkill = isExternalSkillWorkflow(workflow);
  const silent = voiceMode === 'silent';
  const effectiveProject = { ...project, options: { ...project.options, voiceMode } };
  const coverage = voiceCoverage(effectiveProject, shots);
  const { seconds, voiced } = shotDurations(effectiveProject, shots);
  const timeline = buildTimeline(shots, seconds);
  const srt = buildSrt(timeline.lines);
  const profile = parseVoiceProfile(project.assets.voiceProfile);

  const [playingShot, setPlayingShot] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => () => {
    audioRef.current?.pause();
    audioRef.current = null;
  }, [project.id]);

  const togglePlayShot = async (position: number) => {
    if (playingShot === position) {
      audioRef.current?.pause();
      audioRef.current = null;
      setPlayingShot(null);
      return;
    }
    try {
      audioRef.current?.pause();
      const dataUri = await window.sydney.readVideoShotAudio(project.id, position);
      if (!dataUri) {
        notify('该镜头还没有生成好的音频文件');
        return;
      }
      const player = new Audio(dataUri);
      audioRef.current = player;
      setPlayingShot(position);
      player.onended = () => setPlayingShot(current => (current === position ? null : current));
      player.onerror = () => {
        setPlayingShot(null);
        notify('音频试听播放失败');
      };
      await player.play();
    } catch (error) {
      setPlayingShot(null);
      notify(readableError(error));
    }
  };

  const copySrt = async () => {
    try {
      await navigator.clipboard.writeText(srt);
      notify('SRT 字幕已复制到剪贴板');
    } catch (error) {
      notify(readableError(error));
    }
  };

  return (
    <section className="flow-panel">
      <header className="flow-panel-head">
        <div>
          <h3>{externalSkill ? '背景音乐与混音' : '声音、字幕与背景音乐'}</h3>
          <p>
            {externalSkill
              ? '为成片铺底自动原创循环 BGM 或本地音乐；有原声时默认启用旁白自动闪避，不盖住人声。'
              : '逐镜合成配音后自动以真实音频时长驱动画面与字幕时间轴（每行 ≤14 字）；修改单镜口播只需补配那一镜。'}
          </p>
        </div>
      </header>

      {!externalSkill && (
        <>
          <div className="choice-row" role="radiogroup" aria-label="配音方式">
            <button
              type="button"
              role="radio"
              aria-checked={!silent}
              className={`choice ${silent ? '' : 'is-active'}`}
              disabled={locked}
              onClick={() => onVoiceMode('tts')}
            >
              AI 语音合成（按真实音频定镜头时长）
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={silent}
              className={`choice ${silent ? 'is-active' : ''}`}
              disabled={locked}
              onClick={() => onVoiceMode('silent')}
            >
              不配音（仅输出画面与字幕，按分镜秒数）
            </button>
          </div>

          {!silent && (
            <>
              <TtsSettingsPanel locked={locked} notify={notify} />

              <div className="flow-sub-head">
                <h4>
                  逐镜配音
                  <small>
                    已就绪 {coverage.ready}/{coverage.needed} 镜
                    {coverage.stale > 0 ? `（${coverage.stale} 镜口播已改待重配）` : ''}
                    {profile ? ` · 当前快照：${describeVoiceProfile(profile)}` : ''}
                  </small>
                </h4>
                <div className="flow-inline-actions">
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={locked || !coverage.needed}
                    onClick={() => onGenerateVoice(false)}
                  >
                    {busy === 'voice' ? '合成配音中…' : coverage.ready ? '补齐 / 更新配音' : '生成全部配音'}
                  </button>
                  {project.assets.audio.length > 0 && (
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={locked}
                      title="按上方最新保存的配音设置重新合成全部镜头"
                      onClick={() => {
                        if (window.confirm('按当前配音设置重新合成全部镜头？已有镜头配音将被替换。')) {
                          onGenerateVoice(true);
                        }
                      }}
                    >
                      按新声音全部重配
                    </button>
                  )}
                </div>
              </div>
            </>
          )}

          {shots.length > 0 && (
            <div className="flow-table-wrap">
              <table className="flow-table video-voice-table">
                <thead>
                  <tr>
                    <th>镜号</th>
                    <th>口播内容</th>
                    <th>镜头时长</th>
                    <th>配音状态与试听</th>
                  </tr>
                </thead>
                <tbody>
                  {shots.map((shot, pos) => {
                    const audio = !silent ? shotAudio(effectiveProject, shot) : null;
                    const statusLabel = !shot.narration.trim()
                      ? '无口播'
                      : silent
                        ? '静音模式'
                        : audio
                          ? '✓ 已配音'
                          : project.assets.audio.length ? '口播已改·待补配' : '待配音';
                    return (
                      <tr key={`${shot.index}-${pos}`}>
                        <td>#{shot.index}</td>
                        <td>{shot.narration || '—'}</td>
                        <td>{seconds[pos]?.toFixed(1) ?? shot.seconds} 秒</td>
                        <td>
                          <div className="video-voice-cell">
                            <span className={audio ? 'video-voice-ok' : ''}>{statusLabel}</span>
                            {audio && (
                              <button
                                type="button"
                                className="button button-quiet button-small"
                                onClick={() => void togglePlayShot(pos)}
                              >
                                <Icon name={playingShot === pos ? 'pause' : 'play'} size={12} />
                                {playingShot === pos ? '停止' : '试听'}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <div className="flow-sub-head">
        <h4>
          背景音乐（BGM）
          <small>
            {bgmMode === 'auto'
              ? `自动原创 · 匹配曲风「${resolvedBgmStyleLabel}」`
              : bgmMode === 'custom'
                ? (project.options.bgmPath ? project.options.bgmPath.split(/[\\/]/).pop() : '待选择本地音乐')
                : '已关闭背景音乐'}
          </small>
        </h4>
      </div>

      <div className="video-audio-options">
        <label>
          <span>BGM 来源</span>
          <select value={bgmMode} onChange={event => onBgmMode(event.target.value as VideoBgmMode)} disabled={locked}>
            <option value="auto">自动原创（离线确定性合成）</option>
            <option value="custom">本地音乐文件</option>
            <option value="none">关闭 BGM</option>
          </select>
        </label>
        <label>
          <span>原创编曲风格</span>
          <select value={bgmStyle} onChange={event => onBgmStyle(event.target.value as VideoBgmStyle)} disabled={locked || bgmMode !== 'auto'}>
            {VIDEO_BGM_STYLES.map(item => <option key={item.value} value={item.value}>{item.label} · {item.hint}</option>)}
          </select>
        </label>
        <label>
          <span>BGM 音量（%）</span>
          <input
            type="number"
            min={0}
            max={100}
            value={bgmVolume}
            onChange={event => onBgmVolume(Math.min(100, Math.max(0, Number(event.target.value) || 0)))}
            disabled={locked || bgmMode === 'none'}
          />
        </label>
        <label>
          <span>片头淡入（秒）</span>
          <input
            type="number"
            min={0}
            max={10}
            step={0.1}
            value={bgmFadeIn}
            onChange={event => onBgmFadeIn(Math.min(10, Math.max(0, Number(event.target.value) || 0)))}
            disabled={locked || bgmMode === 'none'}
          />
        </label>
        <label>
          <span>片尾淡出（秒）</span>
          <input
            type="number"
            min={0}
            max={10}
            step={0.1}
            value={bgmFadeOut}
            onChange={event => onBgmFadeOut(Math.min(10, Math.max(0, Number(event.target.value) || 0)))}
            disabled={locked || bgmMode === 'none'}
          />
        </label>
        <label className="video-checkbox-field">
          <input
            type="checkbox"
            checked={bgmDucking}
            onChange={event => onBgmDucking(event.target.checked)}
            disabled={locked || bgmMode === 'none'}
          />
          <span>人声出现时自动闪避压低 BGM</span>
        </label>
        <div className="video-bgm-picker">
          <button type="button" className="button button-secondary button-small" disabled={locked} onClick={onChooseBgm}>
            <Icon name="folder" size={14} />{busy === 'bgm' ? '选择中…' : '选择本地音乐'}
          </button>
          <span>
            {bgmMode === 'auto'
              ? `首次渲染时本机合成 16 秒无版权循环 BGM（当前匹配「${resolvedBgmStyleLabel}」）`
              : bgmMode === 'custom'
                ? (project.options.bgmPath || '尚未选择本地音频文件')
                : '成片只保留清晰口播与点缀音效'}
          </span>
        </div>
      </div>

      {!externalSkill && (
        <details className="flow-secondary-tools">
          <summary>
            <span>查看 / 复制 SRT 字幕时间轴</span>
            <small>{timeline.lines.length} 行 · 总长 {formatDuration(timeline.total)} · {voiced ? '已对齐真实配音' : '按分镜秒数估算'}</small>
          </summary>
          <div className="flow-inline-actions" style={{ marginBottom: 8 }}>
            <button type="button" className="button button-secondary button-small" disabled={!srt} onClick={() => void copySrt()}>
              复制 SRT 字幕
            </button>
          </div>
          {srt ? <pre className="video-srt">{srt}</pre> : <p className="flow-empty">填写分镜口播后会自动生成按句切分的 SRT 字幕。</p>}
        </details>
      )}

      <div className="flow-inline-actions">
        <button type="button" className="button button-secondary" disabled={locked} onClick={onSave}>
          {busy === 'save' ? '保存中…' : '保存声音设置'}
        </button>
        <button type="button" className="button button-quiet" disabled={locked} onClick={onNextStep}>
          {externalSkill ? '下一步：成片验收 →' : '下一步：画面素材 →'}
        </button>
      </div>
    </section>
  );
}

function TtsSettingsPanel({ locked, notify }: { locked: boolean; notify: (message: string) => void }) {
  const [status, setStatus] = useState<VideoTtsStatus | null>(null);
  const [draft, setDraft] = useState<VideoTtsSettings | null>(null);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.sydney.getVideoTtsStatus()
      .then(next => {
        if (alive) {
          setStatus(next);
          setDraft(next.settings);
        }
      })
      .catch(error => notify(readableError(error)));
    return () => { alive = false; };
  }, [notify]);

  if (!status || !draft) return null;

  const edit = (patch: Partial<VideoTtsSettings>) => setDraft({ ...draft, ...patch });
  const dirty = JSON.stringify(draft) !== JSON.stringify(status.settings) || Boolean(key.trim());

  const run = async (action: () => Promise<VideoTtsStatus>, message: string) => {
    setSaving(true);
    try {
      const next = await action();
      setStatus(next);
      setDraft(next.settings);
      setKey('');
      notify(message);
    } catch (error) {
      notify(readableError(error));
    } finally {
      setSaving(false);
    }
  };

  const save = () => void run(async () => {
    let next = await window.sydney.saveVideoTtsSettings(draft);
    if (key.trim()) next = await window.sydney.saveVideoTtsKey(key.trim());
    return next;
  }, '全局配音设置已保存；已有视频如需换声请点「按新声音全部重配」');

  const summary = status.settings.provider === 'system'
    ? `Windows 系统语音 · ${status.settings.systemVoice || '默认音色'}`
    : `OpenAI 兼容接口 · ${status.settings.model} (${status.settings.voice})${status.key.configured ? '' : ' · 未填 Key'}`;

  return (
    <details className="flow-secondary-tools video-tts-panel">
      <summary>
        <span>全局配音引擎设置（TTS）</span>
        <small>{summary}</small>
      </summary>
      <div className="native-task-fields">
        <label>
          <span>配音来源</span>
          <select
            disabled={locked || saving}
            value={draft.provider}
            onChange={event => edit({ provider: event.target.value as VideoTtsSettings['provider'] })}
          >
            <option value="system">Windows 系统语音（免费、离线）</option>
            <option value="openai">OpenAI / 硅基流动兼容语音接口</option>
          </select>
        </label>
        {draft.provider === 'system' ? (
          <>
            <label>
              <span>系统语音包</span>
              <select disabled={locked || saving} value={draft.systemVoice} onChange={event => edit({ systemVoice: event.target.value })}>
                <option value="">系统默认语音</option>
                {status.systemVoices.map(voice => <option key={voice} value={voice}>{voice}</option>)}
              </select>
            </label>
            <label>
              <span>语速调整（-5 慢 ～ +5 快）</span>
              <input
                type="number"
                min={-5}
                max={5}
                step={1}
                disabled={locked || saving}
                value={draft.systemRate}
                onChange={event => edit({ systemRate: Number(event.target.value) || 0 })}
              />
            </label>
          </>
        ) : (
          <>
            <label className="native-field-wide">
              <span>语音接口地址（自动走系统代理）</span>
              <input
                disabled={locked || saving}
                value={draft.baseUrl}
                onChange={event => edit({ baseUrl: event.target.value })}
                placeholder="https://api.openai.com/v1 或 https://api.siliconflow.cn/v1"
              />
            </label>
            <label>
              <span>语音模型</span>
              <input disabled={locked || saving} value={draft.model} onChange={event => edit({ model: event.target.value })} placeholder="gpt-4o-mini-tts / FunAudioLLM/CosyVoice2-0.5B" />
            </label>
            <label>
              <span>音色标识（voice）</span>
              <input disabled={locked || saving} value={draft.voice} onChange={event => edit({ voice: event.target.value })} placeholder="alloy 或服务商音色名" />
            </label>
            <label>
              <span>语速倍率（0.5 ～ 2.0）</span>
              <input
                type="number"
                min={0.5}
                max={2}
                step={0.05}
                disabled={locked || saving}
                value={draft.speed}
                onChange={event => edit({ speed: Number(event.target.value) || 1 })}
              />
            </label>
            <label className="native-field-wide">
              <span>语音 API Key{status.key.configured ? `（已加密保存 ${status.key.masked}）` : ''}</span>
              <input
                type="password"
                autoComplete="off"
                disabled={locked || saving}
                value={key}
                onChange={event => setKey(event.target.value)}
                placeholder={status.key.configured ? '留空保留现有密钥' : '输入语音服务 API Key'}
              />
            </label>
          </>
        )}
      </div>
      <div className="flow-inline-actions">
        <button type="button" className="button button-secondary button-small" disabled={locked || saving || !dirty} onClick={save}>
          {saving ? '保存中…' : '保存配音设置'}
        </button>
        {draft.provider === 'openai' && status.key.configured && (
          <button
            type="button"
            className="button button-quiet button-small"
            disabled={locked || saving}
            onClick={() => void run(() => window.sydney.deleteVideoTtsKey(), '已删除保存的配音 API Key')}
          >
            删除 Key
          </button>
        )}
      </div>
    </details>
  );
}
