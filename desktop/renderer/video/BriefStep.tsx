import { useEffect, useState } from 'react';
import type {
  LlmKeyStatus,
  VideoContentStructure,
  VideoPlatform,
  VideoProject,
  VideoTopicSearchResult,
  VideoWorkflow,
  XhsHotNote,
  XhsHotspotSource
} from '../../shared';
import { formatDuration, videoPlatformLabel } from '../../services/video-pipeline';
import { fuzzyCount } from '../../services/xhs-hotspot';
import { Icon, readableError, shortTime } from '../ui';
import {
  CONTENT_STRUCTURES,
  PLATFORMS,
  estimatedSpokenSeconds,
  isExternalSkillWorkflow,
  readVideoTopics
} from './format';

const TOPIC_DAY_OPTIONS = [3, 7, 14, 30];
const TOPIC_SIZE_OPTIONS = [10, 20, 50];
const TOPIC_SOURCE_OPTIONS: Array<{ value: XhsHotspotSource; label: string }> = [
  { value: 'auto', label: '自动（红狐优先）' },
  { value: 'redfox', label: '红狐 API' },
  { value: 'web', label: '联网搜索' }
];

function daysAgo(days: number): string {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function BriefStep({
  project,
  draft,
  platform,
  workflow,
  websiteUrl,
  logoPath,
  sourcePath,
  sourceLanguage,
  targetLanguage,
  targetCode,
  contentStructure,
  contentBrief,
  busy,
  onPatchDraft,
  onWebsiteUrl,
  onLogoPath,
  onChooseLogo,
  onSourcePath,
  onChooseSource,
  onSourceLanguage,
  onTargetLanguage,
  onTargetCode,
  onContentStructure,
  onContentBrief,
  onGenerateTopics,
  onAnalyzeProduct,
  onSave,
  onNextStep,
  notify
}: {
  project: VideoProject;
  draft: Partial<VideoProject>;
  platform: VideoPlatform;
  workflow: VideoWorkflow;
  websiteUrl: string;
  logoPath: string;
  sourcePath: string;
  sourceLanguage: string;
  targetLanguage: string;
  targetCode: string;
  contentStructure: VideoContentStructure;
  contentBrief: string;
  busy: string;
  onPatchDraft: (patch: Partial<VideoProject>) => void;
  onWebsiteUrl: (value: string) => void;
  onLogoPath: (value: string) => void;
  onChooseLogo: () => void;
  onSourcePath: (value: string) => void;
  onChooseSource: () => void;
  onSourceLanguage: (value: string) => void;
  onTargetLanguage: (value: string) => void;
  onTargetCode: (value: string) => void;
  onContentStructure: (value: VideoContentStructure) => void;
  onContentBrief: (value: string) => void;
  onGenerateTopics: () => void;
  onAnalyzeProduct: () => void;
  onSave: () => void;
  onNextStep: () => void;
  notify: (message: string) => void;
}) {
  const locked = Boolean(busy);
  const suggestions = readVideoTopics(project.topicsJson);
  const currentTitle = String(draft.title ?? project.title ?? '');
  const currentTopic = String(draft.topic ?? project.topic ?? '');
  const currentAudience = String(draft.audience ?? project.audience ?? '');
  const currentDuration = Number(draft.durationSeconds ?? project.durationSeconds ?? 60);
  const currentScript = String(draft.script ?? project.script ?? '');
  const spokenEst = estimatedSpokenSeconds(currentScript);
  const drift = currentDuration > 0 && currentScript.trim() ? spokenEst - currentDuration : 0;
  const externalSkill = isExternalSkillWorkflow(workflow);

  return <section className="flow-panel">
    <header className="flow-panel-head">
      <div>
        <h3>{externalSkill ? '素材与输出参数' : '选题与项目简报'}</h3>
        <p>
          {workflow === 'product-demo'
            ? '填写产品官网与品牌 Logo，工作台会抓取公开页面、提炼事实并生成可核实的产品切入角度。'
            : externalSkill
              ? '选择本机视频或录制配置文件，确认目标画布与时长后即可进入背景音乐或直接生成成片。'
              : '锁定目标平台、时长与受众；可搜平台热点或让 AI 生成 5 个不同角度的候选选题。'}
        </p>
      </div>
    </header>

    <div className="native-task-fields">
      <label className="native-field-wide">
        <span>项目标题</span>
        <input
          disabled={locked}
          value={currentTitle}
          onChange={event => onPatchDraft({ title: event.target.value })}
          placeholder={workflow === 'product-demo' ? '留空时自动使用官网标题' : '观众一眼能看懂主题的视频标题'}
        />
      </label>
      <label>
        <span>主输出画布平台</span>
        <select
          disabled={locked}
          value={platform}
          onChange={event => onPatchDraft({ platform: event.target.value as VideoPlatform })}
        >
          {PLATFORMS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>
      <label>
        <span>目标时长（秒）</span>
        <input
          disabled={locked}
          type="number"
          min={5}
          max={600}
          value={currentDuration}
          onChange={event => onPatchDraft({ durationSeconds: Math.max(5, Number(event.target.value) || 60) })}
        />
      </label>
      <label>
        <span>目标受众</span>
        <input
          disabled={locked}
          value={currentAudience}
          onChange={event => onPatchDraft({ audience: event.target.value })}
          placeholder={workflow === 'product-demo' ? '第一次了解这个产品的人' : '例如：关心饮食控糖的中老年读者 / 独立开发者'}
        />
      </label>

      <label className="native-field-wide">
        <span>{workflow === 'product-demo' ? '产品重点说明（可选）' : externalSkill ? '素材备注 / 剪辑说明（可选）' : '选题方向 / 想解决的具体问题'}</span>
        <textarea
          disabled={locked}
          rows={2}
          value={currentTopic}
          onChange={event => onPatchDraft({ topic: event.target.value })}
          placeholder={workflow === 'product-demo' ? '例如：突出团队协作与本地隐私；不要提未上线的定价' : '例如：为什么很多人早餐不吃主食反而中午更犯困'}
        />
      </label>

      {workflow === 'script-to-video' && <>
        <label>
          <span>讲解结构</span>
          <select
            disabled={locked}
            value={contentStructure}
            onChange={event => onContentStructure(event.target.value as VideoContentStructure)}
          >
            {CONTENT_STRUCTURES.map(item => <option key={item.value} value={item.value}>{item.label} · {item.hint}</option>)}
          </select>
        </label>
        <div className="video-brief-hint">
          <span>创作约束说明</span>
          <small>会同时传给口播脚本与分镜模型，确保语气、禁区与案例要求前后一致。</small>
        </div>
        <label className="native-field-wide">
          <span>本项目创作要求（可选）</span>
          <textarea
            disabled={locked}
            rows={2}
            value={contentBrief}
            onChange={event => onContentBrief(event.target.value)}
            placeholder="例如：少用专业术语，用日常买菜做饭举例；只讲 3 个最容易执行的判断，结尾给明天早上就能做的动作。"
          />
        </label>
      </>}

      {workflow === 'product-demo' && <>
        <label className="native-field-wide">
          <span>产品官网 URL</span>
          <input
            disabled={locked}
            value={websiteUrl}
            onChange={event => onWebsiteUrl(event.target.value)}
            placeholder="https://example.com"
          />
        </label>
        <div className="video-file-picker-row native-field-wide">
          <label>
            <span>品牌 Logo 文件</span>
            <input
              disabled={locked}
              value={logoPath}
              onChange={event => onLogoPath(event.target.value)}
              placeholder="支持 PNG / JPG / WebP / SVG，将在每镜右上角展示"
            />
          </label>
          <button type="button" className="button button-secondary" disabled={locked} onClick={onChooseLogo}>
            <Icon name="folder" size={14} />{busy === 'logo' ? '选择中…' : '选择 Logo'}
          </button>
        </div>
      </>}

      {externalSkill && <>
        <div className="video-file-picker-row native-field-wide">
          <label>
            <span>{workflow === 'browser-demo' ? '浏览器录制配置 JSON' : '源视频文件路径'}</span>
            <input
              disabled={locked}
              value={sourcePath}
              onChange={event => onSourcePath(event.target.value)}
              placeholder={workflow === 'browser-demo' ? '选择 browser-demo.json 配置文件' : '选择本机 MP4 / MOV / MKV 视频文件'}
            />
          </label>
          <button type="button" className="button button-secondary" disabled={locked} onClick={onChooseSource}>
            <Icon name="folder" size={14} />选择文件
          </button>
        </div>
        {workflow === 'localize' && <>
          <label>
            <span>源语言</span>
            <input disabled={locked} value={sourceLanguage} onChange={event => onSourceLanguage(event.target.value)} placeholder="auto 或 en / ja / zh" />
          </label>
          <label>
            <span>目标语言名称</span>
            <input disabled={locked} value={targetLanguage} onChange={event => onTargetLanguage(event.target.value)} placeholder="简体中文" />
          </label>
          <label>
            <span>目标语言短码</span>
            <input disabled={locked} value={targetCode} onChange={event => onTargetCode(event.target.value)} placeholder="zh" />
          </label>
        </>}
      </>}
    </div>

    {currentScript.trim() && !externalSkill && Math.abs(drift) >= 15 && (
      <p className="flow-attention-note">
        当前脚本约 {formatDuration(spokenEst)}，与目标时长 {formatDuration(currentDuration)} 相差 {drift > 0 ? '+' : ''}{drift} 秒；可调整目标时长或在下一步重生成脚本。
      </p>
    )}

    {workflow === 'product-demo' && (
      <div className="workbench-status-grid">
        <div><strong>{project.options.productScreenshots.length}</strong><span>已保存官网截图</span></div>
        <div><strong>{project.options.productResearch ? '已提取事实' : '待抓取'}</strong><span>官网公开资料</span></div>
        <div><strong>{project.options.brandColors.length}</strong><span>提取品牌色</span></div>
      </div>
    )}

    {workflow === 'script-to-video' && (
      <TopicHotspotBox
        platform={platform}
        projectId={project.id}
        defaultKeyword={currentTopic}
        currentTitle={currentTitle}
        locked={locked}
        onAdopt={(title, topic) => onPatchDraft({ title, topic })}
        notify={notify}
      />
    )}

    <div className="flow-inline-actions">
      {!externalSkill && (
        <button
          type="button"
          className="button button-primary"
          disabled={locked}
          onClick={workflow === 'product-demo' ? onAnalyzeProduct : onGenerateTopics}
        >
          {busy === 'topics'
            ? '生成中…'
            : workflow === 'product-demo'
              ? '抓取官网并生成 5 个切入方向'
              : suggestions.length ? '换一批 AI 候选选题' : 'AI 生成 5 个候选选题'}
        </button>
      )}
      <button type="button" className="button button-secondary" disabled={locked} onClick={onSave}>
        {busy === 'save' ? '保存中…' : '保存简报'}
      </button>
      <button type="button" className="button button-quiet" disabled={locked} onClick={onNextStep}>
        {externalSkill ? '下一步：背景音乐 →' : '下一步：口播脚本 →'}
      </button>
    </div>

    {!externalSkill && suggestions.length > 0 && (
      <div className="video-topic-candidates" aria-label="AI 候选选题">
        <div className="flow-sub-head">
          <h4>AI 候选选题<small>点击任意卡片即可填入标题与选题方向；标出的待核实事实请在写稿时留意</small></h4>
        </div>
        <div className="native-topic-options">
          {suggestions.map((item, idx) => {
            const selected = currentTitle.trim() === item.title.trim();
            return (
              <button
                type="button"
                key={`${idx}-${item.title}`}
                disabled={locked}
                className={`native-task video-topic-option-card ${selected ? 'is-selected' : ''}`}
                onClick={() => {
                  onPatchDraft({
                    title: item.title,
                    topic: [item.angle, item.hook ? `开场钩子：${item.hook}` : ''].filter(Boolean).join('；') || item.title
                  });
                  notify(`已采用选题「${item.title}」`);
                }}
              >
                <div className="video-topic-option-head">
                  <strong>{item.title}</strong>
                  <span className="chip">{selected ? '✓ 已采用' : '采用选题'}</span>
                </div>
                {item.hook && <small><b>前 3 秒钩子：</b>{item.hook}</small>}
                {item.angle && <small><b>切入角度：</b>{item.angle}</small>}
                {item.why && <small><b>受众价值：</b>{item.why}</small>}
                {item.evidence && <small><b>待核实事实：</b>{item.evidence}</small>}
                {item.risk && <small className="flow-risk"><b>边界提醒：</b>{item.risk}</small>}
              </button>
            );
          })}
        </div>
      </div>
    )}
  </section>;
}

function TopicHotspotBox({
  platform,
  projectId,
  defaultKeyword,
  currentTitle,
  locked,
  onAdopt,
  notify
}: {
  platform: VideoPlatform;
  projectId: number;
  defaultKeyword: string;
  currentTitle: string;
  locked: boolean;
  onAdopt: (title: string, topic: string) => void;
  notify: (message: string) => void;
}) {
  const [keyword, setKeyword] = useState(defaultKeyword);
  const [days, setDays] = useState(7);
  const [pageSize, setPageSize] = useState(10);
  const [source, setSource] = useState<XhsHotspotSource>('auto');
  const [result, setResult] = useState<VideoTopicSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [keyStatus, setKeyStatus] = useState<LlmKeyStatus | null>(null);
  const platformName = videoPlatformLabel(platform);

  useEffect(() => {
    setKeyword(defaultKeyword);
    setResult(null);
  }, [projectId, platform]);

  useEffect(() => {
    void window.sydney.getRedfoxKeyStatus().then(setKeyStatus).catch(() => setKeyStatus(null));
  }, []);

  const search = async (word = keyword, refresh = false) => {
    if (searching) return;
    setSearching(true);
    try {
      setKeyword(word);
      setResult(await window.sydney.searchVideoTopics({
        platform,
        keyword: word,
        startDate: daysAgo(days),
        pageSize,
        refresh,
        source
      }));
    } catch (error) {
      notify(readableError(error));
    } finally {
      setSearching(false);
    }
  };

  const adopt = (note: XhsHotNote) => {
    const context = note.desc.replace(/\s+/g, ' ').trim().slice(0, 320);
    onAdopt(note.title.slice(0, 100), context || note.title);
    notify(`已采用热门线索「${note.title}」`);
  };

  return (
    <details className="flow-secondary-tools video-hotspot-details">
      <summary>
        <span>从{platformName}热点与公开搜索找选题线索</span>
        <small>{keyStatus?.configured ? '红狐 API 优先，失败自动降级联网搜索' : '未配红狐 Key，当前自动使用联网搜索'}</small>
      </summary>
      <div className="video-topic-research">
        <form className="xhs-search" onSubmit={event => { event.preventDefault(); void search(); }}>
          <input
            className="input"
            placeholder={platform === 'xiaohongshu' ? '输入关键词，或留空查红狐全站热门' : `输入${platformName}选题关键词，例如：控糖早餐、AI 编程`}
            value={keyword}
            onChange={event => setKeyword(event.target.value)}
          />
          <select className="input" aria-label="数据源" value={source} onChange={event => setSource(event.target.value as XhsHotspotSource)}>
            {TOPIC_SOURCE_OPTIONS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
          <select className="input" aria-label="时间范围" value={days} onChange={event => setDays(Number(event.target.value))}>
            {TOPIC_DAY_OPTIONS.map(value => <option key={value} value={value}>近 {value} 天</option>)}
          </select>
          <select className="input" aria-label="条数" value={pageSize} onChange={event => setPageSize(Number(event.target.value))}>
            {TOPIC_SIZE_OPTIONS.map(value => <option key={value} value={value}>{value} 条</option>)}
          </select>
          <button className="button button-secondary" type="submit" disabled={locked || searching}>
            <Icon name="search" size={14} />{searching ? '检索中…' : '搜热点'}
          </button>
        </form>

        {result && (
          <div className="xhs-result">
            {result.notice && <p className="xhs-hint xhs-hint-warn"><Icon name="alert" size={14} />{result.notice}</p>}
            <p className="xhs-result-meta">
              <span className={`chip ${result.source === 'redfox' ? 'chip-accent' : ''}`}>
                {result.source === 'redfox' ? '红狐数据' : '联网搜索'} · {videoPlatformLabel(result.platform)}
              </span>
              「{result.keyword || '全站热门'}」共 {result.total} 条，展示 {result.notes.length} 条 · {result.cached ? `缓存于 ${shortTime(result.fetchedAt)}` : `查询于 ${shortTime(result.fetchedAt)}`}
              {result.cached && (
                <button className="button button-quiet button-small" type="button" disabled={locked} onClick={() => void search(result.keyword, true)}>
                  <Icon name="refresh" size={13} />强制刷新
                </button>
              )}
            </p>
            {result.relatedSearches.length > 0 && (
              <div className="xhs-chip-row">
                <span className="xhs-chip-label">相关搜索</span>
                {result.relatedSearches.slice(0, 8).map(item => (
                  <button key={item.keyword} className="chip" type="button" onClick={() => void search(item.keyword)}>
                    {item.keyword}<small>{item.count}</small>
                  </button>
                ))}
              </div>
            )}
            {result.hotTopics.length > 0 && (
              <div className="xhs-chip-row">
                <span className="xhs-chip-label">热门话题</span>
                {result.hotTopics.slice(0, 8).map(item => (
                  <button key={item.topic} className="chip chip-soft" type="button" onClick={() => void search(item.topic)}>
                    #{item.topic}
                  </button>
                ))}
              </div>
            )}
            {result.notes.length ? (
              <ul className="xhs-hot-list">
                {result.notes.map(note => {
                  const isAdopted = currentTitle.trim() === note.title.trim();
                  return (
                    <li key={note.id} className="xhs-hot">
                      <div className="xhs-hot-main">
                        <button
                          type="button"
                          className="xhs-hot-title"
                          title="在系统浏览器中查看原链接"
                          onClick={() => void window.sydney.openXhsLink(note.link).catch(err => notify(readableError(err)))}
                        >
                          {note.title}
                        </button>
                        <p className="xhs-hot-meta">
                          <span>{note.author.nickname}{note.author.fans ? `（${fuzzyCount(note.author.fans)}粉）` : ''}</span>
                          {note.createTime && <span>{note.createTime.slice(0, 10)}</span>}
                        </p>
                        {note.desc && <p className="xhs-hot-desc">{note.desc}</p>}
                      </div>
                      <div className="xhs-hot-stats">
                        {note.unverified ? <><strong>—</strong><small>公开网页</small></> : <><strong>{fuzzyCount(note.interactive)}</strong><small>互动</small></>}
                      </div>
                      <button type="button" className="button button-secondary button-small" disabled={isAdopted} onClick={() => adopt(note)}>
                        {isAdopted ? '已采用' : '采用'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="flow-empty">未检索到匹配结果，请换个关键词或放宽天数重试。</p>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
