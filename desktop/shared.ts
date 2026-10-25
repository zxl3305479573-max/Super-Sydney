export type EventStatus = 'pending' | 'approved' | 'rejected';
export type EventKind = 'manual' | 'activity' | 'codex' | 'claude' | 'file_change' | 'adapter';
export type EventDraft = {
  what_done: string;
  why: string;
  tools: string;
  problems: string;
  solution: string;
  result: string;
  reuse: string;
  category: string;
  content_candidate: boolean;
};
export type WorkEvent = {
  id: number;
  created_at: string;
  app_name: string;
  window_title: string;
  kind: EventKind;
  note: string;
  duration_seconds: number;
  status: EventStatus;
  category: string;
  value_score: number;
  summary: string;
  source: 'desktop' | 'codex' | 'claude' | 'file' | 'adapter';
  source_session_id: string;
  source_turn_id?: string;
  source_message_id: string;
  codex_prompt: string;
  codex_response: string;
  /** Tool / file metadata of an AI turn (JSON of AiTurnTrace); never tool output. */
  ai_trace_json?: string;
  ai_draft_json: string;
  ai_draft_model: string;
  ai_drafted_at: string;
  related_path: string;
  adapter: string;
  change_type: string;
};
export type Settings = {
  captureEnabled: boolean;
  capturePaused: boolean;
  codexCaptureEnabled: boolean;
  /** Also capture Codex CLI / IDE-extension sessions, not only Codex Desktop. */
  codexIncludeCli: boolean;
  claudeCaptureEnabled: boolean;
  /** Extra Claude transcript roots besides ~/.claude/projects (or $CLAUDE_CONFIG_DIR/projects). */
  claudeExtraRoots: string[];
  llmEnabled: boolean;
  allowedApps: string[];
  blockedApps: string[];
  captureIntervalSeconds: number;
  captureAllPending: boolean;
  vaultPath: string;
  screenCaptureEnabled: boolean;
  screenCaptureIntervalSeconds: number;
  screenRetentionHours: number;
  inputWatchEnabled: boolean;
  inputWatchPaths: string[];
  /** 云同步：把已确认事件按隐私规则批量上传到自建同步 API。密码单独走系统安全存储。 */
  cloudSyncEnabled: boolean;
  cloudSyncUrl: string;
  cloudSyncUsername: string;
  /** 是否上传窗口标题（默认关）。 */
  cloudSyncIncludeWindowTitle: boolean;
  /** 是否上传文件路径（默认关）。 */
  cloudSyncIncludeFilePath: boolean;
};
/** 云同步的运行状态与待上传队列，只在主进程维护，渲染进程拿到的是掩码后的快照。 */
export type CloudSyncStatus = {
  enabled: boolean;
  clientId: string;
  /** 上次成功收到响应的时间（ISO），从未同步过为空串。 */
  lastSyncAt: string;
  /** 待上传条数。 */
  pending: number;
  running: boolean;
  error: string;
};
export type CodexCaptureStatus = { state: 'disabled' | 'stopped' | 'listening' | 'error'; error: string };
export type ClaudeCaptureStatus = CodexCaptureStatus;
export type ScreenCaptureStatus = { state: 'disabled' | 'stopped' | 'capturing' | 'error'; saved: number; error: string };
export type CaptureStatus = { state: 'idle' | 'sampling' | 'blocked' | 'error'; appName: string; windowTitle: string; sampledAt: string; message: string };
/* ── 自我进化 ─────────────────────────────────────────────────── */
export type RuleEvidenceView = { eventId: number; reason: string; prompt: string; previousPrompt: string; previousResponse: string };
export type RuleCandidateView = {
  id: number; project: string; cwd: string; evidence: RuleEvidenceView[]; ruleText: string; rationale: string;
  status: 'proposed' | 'applied' | 'rejected'; applied: Array<{ path: string; before: string | null; after: string }>; createdAt: string; updatedAt: string;
};
export type RulePatchPreview = { path: string; exists: boolean; added: string[] };
export type AiReviewResult = { target: string; turns: number; repeats: number; friction: number; rules: number; notesUsed: number; staleNotes: number };
export type EvolutionState = { rules: RuleCandidateView[]; pendingCardEvents: number; llmEnabled: boolean };
export type CardExtractResult = { considered: number; created: string[]; updated: string[]; index: string };
export type LlmKeyStatus = { configured: boolean; masked: string; encryptionAvailable: boolean };

/* ── 公众号（WeWrite）模块 ─────────────────────────────────────────
 * 该模块只做两类事：读取 ~/.wewrite 下由 CLI 产生的运行状态，
 * 以及触发确定性 CLI 命令。选题/写作/审稿属于 WeWrite 的提示词层，
 * 必须由 agent 执行，应用不代跑。
 */
export type ContentStage = 'topics' | 'brief' | 'claims' | 'draft' | 'review' | 'revise';
/** 未给公众号资料设置篇幅时使用的写作目标；界面提示与实际生成共用，避免两处漂移。 */
export const DEFAULT_CONTENT_WORD_COUNT = '600-1200';
/**
 * 内容方向是两级、由用户自己维护的分类：
 * 一级「内容方向」（如 中老年健康科普 / 科技与数码），二级「具体方向」（如 饮食营养与蔬果利弊）。
 * 写作与配图的提示词都从这里的 name/note 取，不再写死某个领域。
 */
/** imagePrompt：配图风格模板，替换默认的画风与禁忌两行；具体方向留空时沿用方向的，方向也留空时用内置默认。 */
export type ContentSubdirection = { id: number; name: string; note: string; imagePrompt: string };
/**
 * 一级内容方向 = 一份「公众号资料」：写作相关的配置全部按资料隔离。
 * 写作、配图、推送署名、新建任务的排版主题都只用文章所属资料的值，不再回退到账号级 style.yaml——
 * 否则新加的资料会被最初那份资料的设定带偏。图片服务、内容 API、微信凭证仍是全局一份。
 *   - name：资料名称（界面上切换用）；accountName：公众号名称
 *   - note：写作约束；imagePrompt：配图风格模板
 *   - audience / tone / voice：读者定位
 *   - persona / theme / wordCount / contentStyle：模板设置
 */
export type ContentProfileFields = {
  accountName: string; industry: string; author: string;
  audience: string; tone: string; voice: string;
  persona: string; theme: string; wordCount: string; contentStyle: string;
  blacklistWords: string[]; blacklistTopics: string[];
};
export type ContentDirection = { id: number; name: string; note: string; imagePrompt: string; subdirections: ContentSubdirection[] } & ContentProfileFields;
export type ContentTaxonomy = { directions: ContentDirection[]; defaultSubdirectionId: number | null };
/** 保存时用：没有 id 表示新增，缺失的 id 表示删除。 */
export type ContentSubdirectionInput = { id?: number; name: string; note?: string; imagePrompt?: string };
export type ContentDirectionInput = { id?: number; name: string; note?: string; imagePrompt?: string; subdirections: ContentSubdirectionInput[] } & Partial<ContentProfileFields>;
/** AI 优化约束说明：subdirectionName 为空表示优化一级方向的约束，否则优化该具体方向的额外要求。 */
/** audience：方向自己的目标读者，可空。 */
export type DirectionNoteRequest = { directionName: string; directionNote: string; subdirectionName: string; note: string; audience?: string };
export type DirectionNoteSuggestion = { note: string; changes: string[] };
/** 配图风格模板的 AI 优化请求；parentTemplate 是具体方向留空时会沿用的上级模板。建议复用 DirectionNoteSuggestion。 */
export type ImageStyleRequest = { directionName: string; directionNote: string; subdirectionName: string; subdirectionNote: string; parentTemplate: string; template: string; audience?: string };
/** 前端可视化用的图片：thumbnail 是小尺寸 data URI，path 只作标识与排错。 */
export type ContentAssetView = { path: string; caption: string; thumbnail: string };
export type ContentAssetBundle = { cover: ContentAssetView | null; images: ContentAssetView[] };
/**
 * AI 生图的候选图：同一处可以先生成多张，用户挑一张再落进正文或封面。
 * 候选是「这一次挑哪张」的临时状态，不落库；重新生成或挑完就作废。
 */
/** origin 用来区分「本次刚生成」和「以前生成过、这次拿来用」。 */
export type ImageCandidateOption = { path: string; thumbnail: string; origin: 'new' | 'history' };
export type ImageCandidateGroup = {
  /** 挑完回传给主进程的标识：封面是 cover，正文配图是 slot:<位置序号>。 */
  key: string;
  /** 界面上的位置说明，例如「封面」「第 2 处 · 少喝浓汤」。 */
  label: string;
  /** 这个位置要配合的内容提要。 */
  excerpt: string;
  options: ImageCandidateOption[];
};
export type ImageCandidateBundle = { taskId: number; groups: ImageCandidateGroup[]; warning: string };
/** 候选图要生成哪几处：封面、正文配图，或两者一起。 */
export type ImageCandidateScope = 'cover' | 'inline' | 'both';
export type ContentTaskStatus = 'idea' | 'brief' | 'draft' | 'review' | 'ready' | 'published';
export type ContentTask = {
  id: number;
  /** 内容方向与具体方向：允许为空（老任务或还没归类），提示词会退化成只按选题写。 */
  directionId: number | null;
  subdirectionId: number | null;
  /** 由分类表 join 出来的展示名，界面直接渲染，不必再查表。 */
  directionName: string;
  subdirectionName: string;
  topic: string;
  title: string;
  status: ContentTaskStatus;
  briefJson: string;
  claimsJson: string;
  sourcesJson: string;
  topicsJson: string;
  draft: string;
  finalArticle: string;
  reviewJson: string;
  coverPath: string;
  /** 排版主题名，见 services/article-html.ts 的 ARTICLE_THEMES。 */
  theme: string;
  publishJson: string;
  exportPath: string;
  createdAt: string;
  updatedAt: string;
};
export type WeWriteTheme = { name: string; description: string };
export type WeWriteCheck = { group: string; name: string; status: string; detail: string };
export type WeWriteSummary = {
  passed: number;
  warnings: number;
  failures: number;
  skipped: number;
  antiAiLevel: string;
  antiAiScore: number;
  antiAiMax: number;
  styleSetupLevel: string;
  styleSetupScore: number;
  styleSetupMax: number;
};
/**
 * 公众号模块的「环境与配置」全量快照。
 * 安全约束：任何密钥字段只以掩码形式进入渲染进程，绝不返回明文。
 */
export type WeWriteConfigDraft = {
  style: {
    name: string;
    industry: string;
    targetAudience: string;
    tone: string;
    voice: string;
    wordCount: string;
    contentStyle: string;
    persona: string;
    theme: string;
    author: string;
    topics: string[];
    defaultTopic: string;
    blacklistWords: string[];
    blacklistTopics: string[];
  };
  wechat: { appid: string; secret: string; author: string };
  writer?: { baseUrl: string; model: string; apiKey: string; enabled: boolean };
  image: { provider: string; model: string; baseUrl: string; apiKey: string; estimatedCost: string };
};
export type WeWriteOverview = {
  writer: { baseUrl: string; model: string; apiKeyMasked: string; enabled: boolean };
  home: string;
  checks: WeWriteCheck[];
  summary: WeWriteSummary;
  recommendations: string[];
  files: { configYaml: boolean; styleYaml: boolean; playbookMd: boolean; historyYaml: boolean; persona: string; exemplarCount: number };
  flags: { skipPublish: boolean; skipImageGen: boolean; useWriterModel: boolean; needsOnboard: boolean };
  image: { provider: string; model: string; baseUrl: string; apiKeyMasked: string; estimatedCost: string };
  /** config.yaml 的 wechat.author（微信草稿默认署名），与 style.author 相互独立。 */
  wechat: { author: string };
  style: {
    name: string; industry: string; targetAudience: string; tone: string; voice: string;
    wordCount: string; contentStyle: string; persona: string; theme: string; author: string; defaultTopic: string;
    topics: string[]; blacklistWords: string[]; blacklistTopics: string[];
  };
  themes: WeWriteTheme[];
};
/**
 * 全应用统一的模型配置（「设置 → 模型」）：一个内容模型、一个图片模型，所有模块共用。
 * 预设：内容模型（writer）与图片模型（image）各自可以存多套，用下拉切换。
 */
export type ModelConfigView = {
  /** 允许调用内容模型（应用设置 llmEnabled）。 */
  enabled: boolean;
  writer: { baseUrl: string; model: string; key: LlmKeyStatus };
  image: { provider: string; model: string; baseUrl: string; apiKeyMasked: string; estimatedCost: string };
  presets: ModelPresetView[];
  /** 当前在用的配置对应哪个预设；空串表示「自定义」。 */
  activePresets: Record<ModelPresetKind, string>;
};
/** key 留空表示保留现有的。 */
export type ModelConfigDraft = {
  writer: { baseUrl: string; model: string; apiKey: string };
  image: { provider: string; model: string; baseUrl: string; apiKey: string; estimatedCost: string };
};
export type ModelPresetKind = 'writer' | 'image';
export type ModelPreset = { id: string; kind: ModelPresetKind; name: string; baseUrl: string; model: string; provider: string; estimatedCost: string };
export type ModelPresetView = ModelPreset & { apiKeyMasked: string };
/** apiKey 留空表示沿用当前在用的 key。 */
export type ModelPresetInput = { kind: ModelPresetKind; name: string; baseUrl: string; model: string; provider?: string; estimatedCost?: string; apiKey?: string };
export type WeWriteEnvironment = {
  home: string;
  theme: string;
  themes: WeWriteTheme[];
  configFound: boolean;
  styleFound: boolean;
  persona: string;
  wechatConfigured: boolean;
  imageConfigured: boolean;
  defaultTopic: string;
};
/* ── 公众号文章数据 ──────────────────────────────────────────────
 * 账号未认证、调不了 datacube 接口，数据来自用户从后台导出的表格。
 * 指标都可空：不同导出包含的列不同，null 表示"这份数据里没有"，不是 0。
 */
export type ArticleMetricKey = 'readUsers' | 'reads' | 'shareUsers' | 'shares' | 'likes' | 'wows' | 'favorites' | 'comments' | 'delivered' | 'follows';
export type ArticleMetrics = Record<ArticleMetricKey, number | null>;
export type ArticleStatRecord = {
  id: number;
  title: string;
  publishDate: string;
  metrics: ArticleMetrics;
  source: string;
  importedAt: string;
  /** 按标题匹配到的创作任务；null 表示不是在本应用里写的，或标题被改过。 */
  taskId: number | null;
  /** 所属公众号资料（取自匹配到的任务）。 */
  directionId: number | null;
  directionName: string;
  subdirectionName: string;
  /** 分享 / 阅读，优先用人数。 */
  shareRate: number | null;
  /** (点赞 + 在看 + 收藏) / 阅读。 */
  engageRate: number | null;
  /** 阅读人数 / 送达人数，只有导出里带送达人数时才有。 */
  openRate: number | null;
};
export type ArticleStatGroup = { name: string; count: number; medianReads: number | null; meanShareRate: number | null; meanEngageRate: number | null };
export type ArticleStatsView = {
  records: ArticleStatRecord[];
  groups: ArticleStatGroup[];
  /** unmatched：按资料查看时，对不上任何创作任务、因而无法归到资料的文章数（不计入其它数字）。 */
  overview: { articles: number; matched: number; unmatched: number; medianReads: number | null; totalReads: number | null; meanShareRate: number | null };
  availableMetrics: ArticleMetricKey[];
  lastImportedAt: string;
};
export type ArticleStatsImportResult = { file: string; added: number; updated: number; view: ArticleStatsView };
/* ── 视频模块 ────────────────────────────────────────────────────
 * 面向中老年健康科普账号的短视频流水线：选题 → 口播脚本 → 分镜 →
 * 配音与字幕 → 画面 → 成片 → 封面 → 制作包。
 * 模型负责选题、脚本与分镜（和可选的逐镜配图）；配音走 TTS，字幕、画面帧与成片在本地确定性生成；
 * 导出前必须由人确认，模块不代替任何平台做发布。
 * 设计见 docs/superpowers/specs/2026-10-14-video-production-design.md。
 */
export type VideoPlatform = 'douyin' | 'shipinhao' | 'xiaohongshu' | 'bilibili' | 'general';
export type VideoStage = 'topics' | 'script' | 'storyboard';
export type VideoProjectStatus = 'idea' | 'script' | 'storyboard' | 'exported';
/** 镜头在讲解里的作用：开场钩子、讲问题、讲概念、步骤、证据、结论、行动建议。 */
export type VideoShotRole = 'hook' | 'problem' | 'concept' | 'step' | 'evidence' | 'takeaway' | 'cta';
export type VideoShot = {
  index: number;
  /** 分镜给的估计时长（秒）；配音之后以真实音频时长为准。 */
  seconds: number;
  /** 画面：拍什么、用什么素材。 */
  visual: string;
  /** 口播词，进 TTS 或人声；字幕也从它切句。 */
  narration: string;
  /** 画面大字：这一镜的要点（≤12 字），不是逐句字幕。 */
  caption: string;
  /** 旧分镜没有这个字段，归一化后为空串。 */
  role?: VideoShotRole | '';
  /** AI 配图用的提示词；为空时退回 visual。 */
  imagePrompt?: string;
};
export type VideoVoiceMode = 'tts' | 'silent';
export type VideoTemplate = 'warm' | 'clean' | 'night';
export type VideoImageMode = 'none' | 'ai';
/** 用户可改的成片选项，走 video:update 保存。 */
export type VideoRenderOptions = {
  voiceMode: VideoVoiceMode;
  template: VideoTemplate;
  imageMode: VideoImageMode;
  /** 背景音乐（本地文件）；空串表示不加。 */
  bgmPath: string;
  /** 背景音乐音量，百分比 0–100。 */
  bgmVolume: number;
  /** 画面底部固定的一行：账号名或合规提示。 */
  footer: string;
  /** 画面里带哪个 IP 的品牌角标和角色（IP 库里的 id）；空串表示不带。 */
  ipId: string;
  /** 分镜模型填写 image_prompt 的自定义规则；空串按默认规则。 */
  storyboardImagePromptRule: string;
  /** 逐镜 AI 配图的最终提示词模板，支持 {title}、{subject}。 */
  shotImagePromptTemplate: string;
  /** AI 竖版封面的提示词模板，支持 {title}、{context}。 */
  coverImagePromptTemplate: string;
};
export type VideoAudioAsset = { key: string; path: string; seconds: number };
export type VideoImageAsset = { key: string; path: string };
export type VideoRenderedFile = { path: string; signature: string; seconds: number; renderedAt: string };
/** 素材账本：只由主进程写。配音、配图按内容哈希登记，改一镜只重做一镜。 */
export type VideoRenderAssets = {
  /** 上次生成配音时快照的声音参数；配音的键由它和口播文本算出。 */
  voiceProfile: string;
  audio: VideoAudioAsset[];
  images: VideoImageAsset[];
  /** 每镜一帧的预览图，渲染成片前自查用。 */
  preview: { signature: string; paths: string[] } | null;
  video: VideoRenderedFile | null;
};
export type VideoProject = {
  id: number;
  platform: VideoPlatform;
  topic: string;
  title: string;
  audience: string;
  durationSeconds: number;
  status: VideoProjectStatus;
  topicsJson: string;
  script: string;
  storyboardJson: string;
  coverPath: string;
  exportPath: string;
  options: VideoRenderOptions;
  assets: VideoRenderAssets;
  createdAt: string;
  updatedAt: string;
};
/** shotImages / preview 是缩略图 data URL，按镜头顺序；没有的镜头为空串。 */
export type VideoAssetBundle = { cover: ContentAssetView | null; shotImages: string[]; preview: string[]; videoPath: string };
export type VideoTtsProvider = 'system' | 'openai';
/** 全局配音设置：userData/video-tts.json；OpenAI 兼容接口的 key 另存系统安全存储。 */
export type VideoTtsSettings = {
  provider: VideoTtsProvider;
  baseUrl: string;
  model: string;
  voice: string;
  /** 接口语速倍率 0.5–2。 */
  speed: number;
  /** Windows 系统语音名，空串表示系统默认。 */
  systemVoice: string;
  /** 系统语音语速 -5～5，0 为正常。 */
  systemRate: number;
};
export type VideoTtsStatus = { settings: VideoTtsSettings; key: LlmKeyStatus; systemVoices: string[] };
export type VideoProgressTask = 'voice' | 'images' | 'preview' | 'render';
export type VideoProgress = { id: number; task: VideoProgressTask; done: number; total: number; message: string };

/* ── 小红书模块 ──────────────────────────────────────────────────
 * 按「定位、选题、写作、视觉、复盘」五环节 + 总控拆分（见 docs/superpowers/specs/2026-10-13-xiaohongshu-module-design.md）。
 * 账号级数据（定位档案、诊断、复盘）每个账号一份；笔记级数据每篇一条任务，
 * 走 选题 → 正文 → 标题 → 视觉 → 发布前检测 → 发布包。
 * 模块不代发布：终点是知识库里的发布包，由人手动发到小红书。
 */
/** 小红书自己的模型连接（与公众号分开）；两个 key 不在这里，走系统安全存储。 */
export type XhsTab = 'home' | 'positioning' | 'hotspot' | 'notes' | 'audit' | 'analytics' | 'browser';
export type XhsAccount = {
  id: number;
  name: string;
  /** 定位档案（XhsPositioning 的 JSON），由「账号定位」写入；未定位时为空串。 */
  positioningJson: string;
  /** 定位问答记录（XhsPositioningTurn[] 的 JSON）。 */
  positioningChatJson: string;
  /** 这个账号用的 IP（IP 库里的 id）；空串表示不使用 IP。 */
  ipId: string;
  createdAt: string;
  updatedAt: string;
};
/** 小红书的 IP 封面模板（见 services/xhs-ip-cover）。 */
export type XhsIpCoverTemplate = 'tutorial' | 'list' | 'recap';

export type XhsIpCoverInput = {
  template: XhsIpCoverTemplate;
  /** 用 IP 的哪个角色动作（IpPose.id）；空串表示按模板自动挑。 */
  pose: string;
  title: string;
  sub: string;
  tag: string;
  /** 只有 tutorial 用，最多 5 步。 */
  steps: string[];
  /** 只有 list 用：巨大数字和单位、右上角贴纸。 */
  number: string;
  unit: string;
  sticker: string;
  /** 只有 recap 用：角色上方的气泡台词。 */
  bubble: string;
};

/** 公众号的 IP 封面模板（见 services/wechat-ip-cover）。 */
export type WechatIpCoverInput = {
  style: 'light' | 'dark';
  /** 用 IP 的哪个角色动作（IpPose.id）；空串表示自动挑。 */
  pose: string;
  title: string;
  sub: string;
  tag: string;
};

/** 视频的 IP 竖版封面（见 services/video-ip-cover）。 */
export type VideoIpCoverInput = { style: 'light' | 'dark'; pose: string; title: string; sub: string };

/* ── IP 库 ─────────────────────────────────────────────────────── */

/** IP 的透明底角色动作素材；file 是 IP 目录里的文件名。 */
export type IpPose = { id: string; label: string; file: string };
export type IpColors = { primary: string; accent: string; secondary: string };
export type IpProfile = {
  id: string;
  /** 名称，也是封面上的品牌名。 */
  name: string;
  /** 口头禅或简介。 */
  tagline: string;
  /** 主色（深色，正文与底色）、强调色（高亮、标签）、辅色（点缀、浅底）。 */
  colors: IpColors;
  /** 头像文件名；空串表示没有。 */
  avatar: string;
  poses: IpPose[];
  /** 参考图（以后生成新动作时当参考），可选。 */
  reference: string;
  createdAt: string;
  updatedAt: string;
};
export type IpProfilePatch = Partial<Pick<IpProfile, 'name' | 'tagline' | 'colors'>> & { poses?: Array<Pick<IpPose, 'id' | 'label'>> };
export type IpModule = 'wechat' | 'video';
export type IpLibraryView = {
  ips: Array<IpProfile & { avatarThumb: string; referenceThumb: string; poseThumbs: Record<string, string> }>;
  /** 各模块上次选的 IP；空串表示不使用。 */
  selections: Record<IpModule, string>;
};
/** 模板渲染用：品牌信息与图片（data URI）。模板只认这份资料，不认具体是哪个 IP。 */
export type IpRenderKit = {
  id: string;
  name: string;
  tagline: string;
  colors: IpColors;
  avatar: string;
  poses: Array<{ id: string; label: string; src: string }>;
};

export type XhsPositioning = {
  track: { name: string; reason: string; alternatives: string[] };
  /** 定位句：我是谁、给谁看、提供什么价值。 */
  statement: string;
  /** 人设三件套。 */
  persona: { name: string; bio: string; visual: string };
  pillars: Array<{ name: string; description: string }>;
  /** 前 20 篇选题。 */
  firstTopics: Array<{ title: string; pillar: string; noteType: XhsNoteType }>;
  coldStart: Array<{ phase: string; actions: string[] }>;
  generatedAt: string;
};
export type XhsPositioningTurn = { role: 'coach' | 'user'; text: string; questions?: string[] };

export type XhsNoteStatus = 'idea' | 'body' | 'title' | 'visual' | 'packaged';
export type XhsNoteType = 'review' | 'tutorial' | 'story' | 'list' | 'avoid' | 'share' | 'recap';
export type XhsNote = {
  id: number;
  accountId: number;
  topic: string;
  noteType: XhsNoteType;
  /** 用户自己的经验与素材：正文只能基于它写「亲身经历」，没有就按科普 / 整理口吻写。 */
  material: string;
  title: string;
  body: string;
  /** 标签数组的 JSON（不带 #）。 */
  tagsJson: string;
  /** 选题来源：从热点笔记转过来时记下那条笔记（XhsHotNote 的 JSON），手动建的为空串。 */
  sourceJson: string;
  /** 由内容推导出的进度，列表展示用；写库时按 deriveXhsStatus 重算。 */
  status: XhsNoteStatus;
  /** 正文写作的结构信息（XhsWriterMeta 的 JSON）。 */
  writerJson: string;
  /** 标题工坊结果（XhsTitleWorkshop 的 JSON）。 */
  titleCandidatesJson: string;
  /** 发布前检测（XhsCheckReport 的 JSON）。 */
  checksJson: string;
  /** 图文卡片分页内容（XhsCardPlan 的 JSON）。 */
  cardsJson: string;
  coverPath: string;
  /** 封面之后的图组（XhsImageItem[] 的 JSON），顺序就是发布顺序；导出发布包只用这一组。 */
  imagesJson: string;
  /** 候选图库（XhsCandidate[] 的 JSON）：每次生成 / 添加的图都按批次留在这里，从中挑选封面与发布图组。 */
  candidatesJson: string;
  /** 各产物基于的内容指纹（XhsBasis 的 JSON），用来判断「上游改过、这里需复核」。 */
  basisJson: string;
  exportPath: string;
  createdAt: string;
  updatedAt: string;
};
export type XhsBasis = { body?: string; title?: string; cover?: string; cards?: string; checks?: string; package?: string };
export type XhsStepKey = 'topic' | 'body' | 'title' | 'visual' | 'checks' | 'package';
export type XhsGenerateStage = 'body' | 'revise' | 'titles' | 'checks' | 'cards';
export type XhsWriterMeta = { opening: string[]; outline: string[]; interaction: string };
export type XhsTitleCandidate = {
  title: string;
  method: string;
  /** 各项 0-5：搜索词覆盖、人群指向、收藏动机、点击钩子。 */
  scores: { search: number; audience: number; save: number; hook: number };
  total: number;
  risks: string[];
  role: 'primary' | 'backup' | 'test';
  reason: string;
};
export type XhsTitleWorkshop = {
  candidates: XhsTitleCandidate[];
  ab: Array<{ a: string; b: string; variable: string; how: string }>;
  keywords: string[];
  generatedAt: string;
};
export type XhsCheckItem = { id: string; label: string; ok: boolean | null; level: 'error' | 'warn' | 'info'; detail: string; source: 'local' | 'model' };
export type XhsCheckReport = { items: XhsCheckItem[]; checkedAt: string; modelError: string };
export type XhsCardPage = { heading: string; points: string[]; emphasis: string };
export type XhsCardPlan = { style: string; pages: XhsCardPage[] };
export type XhsImageItem = { path: string; source: 'card' | 'info' | 'local'; caption: string };
/** 候选图库里的一张图。batch 是同一次生成的批次号，界面按它分组；cover 是生成 / 选过的封面。 */
export type XhsCandidate = { path: string; source: XhsImageItem['source'] | 'cover'; caption: string; batch: string; createdAt: string };
export type XhsCandidateView = ContentAssetView & Omit<XhsCandidate, 'path' | 'caption'> & { inGroup: boolean; isCover: boolean };
export type XhsNoteAssets = { cover: ContentAssetView | null; images: Array<ContentAssetView & { source: XhsImageItem['source'] }>; candidates: XhsCandidateView[] };

/** 热点数据里的一条笔记。互动数是数据源给的原值，展示时再模糊化，不反推精确值。 */
export type XhsHotNote = {
  id: string;
  title: string;
  desc: string;
  cover: string;
  link: string;
  createTime: string;
  topics: string[];
  author: { id: string; nickname: string; fans: number };
  interactive: number;
  liked: number;
  collected: number;
  comments: number;
  shared: number;
  /** 公众号 / 图文平台有明确阅读数时单独保留；小红书原接口没有这个字段。 */
  readCount?: number;
  /** 有关键词时红狐给的评分：总分 15 = 相关性 10 + 热度 3 + 时效 2；全站热门时为 null。 */
  score: { total: number; relevance: number; popularity: number; recency: number } | null;
  /** 联网搜索得来、没有互动数据的条目。 */
  unverified?: boolean;
};
export type XhsHotspotSource = 'auto' | 'redfox' | 'web';
export type XhsHotspotQuery = {
  /** 空串 = 全站热门（仅红狐支持）。 */
  keyword: string;
  /** yyyy-MM-dd；留空时默认近 7 天。 */
  startDate?: string;
  endDate?: string;
  pageSize?: number;
  /** 跳过 24 小时缓存强制重查。 */
  refresh?: boolean;
  /** auto：有红狐 key 用红狐，拿不到再退联网搜索。 */
  source?: XhsHotspotSource;
};
export type XhsHotspotResult = {
  source: 'redfox' | 'web' | 'view';
  keyword: string;
  startDate: string;
  endDate: string;
  total: number;
  notes: XhsHotNote[];
  /** 主结果太少时数据源给的近期热门参考。 */
  latest: XhsHotNote[];
  relatedSearches: Array<{ keyword: string; count: number }>;
  hotTopics: Array<{ topic: string; count: number; interactive: number }>;
  tips: string;
  fetchedAt: string;
  /** 这次结果是否来自本地缓存。 */
  cached: boolean;
  /** 降级说明，例如「红狐 Key 无效，已改用联网搜索」。 */
  notice?: string;
};
/** 视频选题按发布平台选择数据源；小红书沿用现有适配器，其他平台走各自的红狐接口或平台化联网搜索。 */
export type VideoTopicSearchQuery = XhsHotspotQuery & { platform: VideoPlatform };
export type VideoTopicSearchResult = XhsHotspotResult & { platform: VideoPlatform };
export type XhsTopicIdea = { title: string; pillar: string; noteType: XhsNoteType; angle: string; why: string };

export type XhsFunnelLayer = 'exposure' | 'click' | 'depth' | 'engagement' | 'save' | 'follow';
export type XhsRouterAdvice = {
  chain: 'A' | 'B' | 'C';
  layer: XhsFunnelLayer | '';
  title: string;
  reason: string;
  steps: Array<{ tab: XhsTab; label: string }>;
  source: 'rule' | 'model';
};

export type XhsAuditNote = { title: string; liked: number; collected: number; comments: number; date: string; isVideo: boolean };
export type XhsAuditInput = {
  target: 'self' | 'competitor';
  name: string;
  bio: string;
  fans: number;
  follows: number;
  likesAndCollects: number;
  notes: XhsAuditNote[];
  /** 封面风格的文字描述（模型看不到图，只能据此判断统一性）。 */
  coverNote: string;
};
export type XhsAuditMetrics = {
  noteCount: number;
  avgInteractions: number;
  medianInteractions: number;
  interactionRate: number | null;
  hitRate: number | null;
  postsPerWeek: number | null;
  longestGapDays: number | null;
};
export type XhsAuditResult = {
  metrics: XhsAuditMetrics;
  dimensions: Array<{ key: string; label: string; score: number | null; evidence: string }>;
  total: number;
  bottleneck: string;
  actions: Array<{ priority: number; action: string; why: string }>;
  positioningAdvice: string;
};
export type XhsReport = { id: number; accountId: number; kind: 'audit' | 'analytics'; title: string; inputJson: string; resultJson: string; createdAt: string };

export type XhsStatMetrics = {
  impressions: number | null;
  views: number | null;
  ctr: number | null;
  avgViewSeconds: number | null;
  completion: number | null;
  likes: number | null;
  comments: number | null;
  collects: number | null;
  shares: number | null;
  follows: number | null;
};
export type XhsNoteStat = { id: number; accountId: number; title: string; publishDate: string; metrics: XhsStatMetrics; noteId: number | null; importedAt: string };
export type XhsFunnelRow = {
  stat: XhsNoteStat;
  /** 各层的值：曝光是绝对数，其余是比率；缺数据为 null。 */
  values: Record<XhsFunnelLayer, number | null>;
  /** 各层相对账号中位数的倍数。 */
  ratios: Record<XhsFunnelLayer, number | null>;
  weakest: XhsFunnelLayer | '';
};
export type XhsAnalyticsInterpretation = {
  summary: string;
  findings: Array<{ layer: XhsFunnelLayer | ''; finding: string; evidence: string }>;
  next: Array<{ action: string; target: 'title' | 'cover' | 'writer' | 'audit' | 'positioning' }>;
  patterns: string[];
};
export type XhsAnalyticsView = {
  rows: XhsFunnelRow[];
  medians: Record<XhsFunnelLayer, number | null>;
  layerCounts: Record<XhsFunnelLayer, number>;
  dominant: XhsFunnelLayer | '';
  latestReport: XhsReport | null;
};
export type XhsStatsImportResult = { file: string; added: number; updated: number; view: XhsAnalyticsView };

export type EmbeddedViewState = { url: string; title: string; loading: boolean; canGoBack: boolean; visible: boolean; error: string };
export type XhsViewState = EmbeddedViewState & { accountId: number };
/** 变现分组里固定嵌入的站点（闲鱼、16688、接码）：状态结构与小红书窗口一致，走 embed:* 通道、按 key 区分。 */
export type EmbeddedSiteKey = 'xianyu' | 'site16688' | 'heroSms' | 'wechatMp';

/* ── 变现 · HeroSMS 接码 API ───────────────────────────────────
 * 接码模块走 HeroSMS 官方开放 API（SMS-Activate / handler_api 兼容层）。
 * key 只存在系统安全存储，渲染进程只拿到掩码状态；同一次调用只返回一个号码结果。
 */
export type HeroSmsCountry = { id: number; name: string; englishName: string };
export type HeroSmsService = { code: string; name: string };
export type HeroSmsOffer = { cost: number | null; count: number };
export type HeroSmsCountryOffer = HeroSmsOffer & { countryId: number };
export type HeroSmsPhase = 'waiting' | 'code' | 'retry' | 'canceled' | 'completed' | 'unknown';
export type HeroSmsActivation = {
  id: string;
  phone: string;
  serviceCode: string;
  countryId: number;
  cost: number | null;
  currency: string;
  createdAt: string;
  endsAt: string;
  canGetAnotherSms: boolean;
  operator: string;
  phase: HeroSmsPhase;
  code: string;
  text: string;
  receivedAt: string;
};
export type HeroSmsActivationStatus = {
  id: string;
  phase: HeroSmsPhase;
  code: string;
  text: string;
  receivedAt: string;
  message: string;
};
export type HeroSmsOverview = {
  balance: number;
  currency: string;
  countries: HeroSmsCountry[];
  services: HeroSmsService[];
  activations: HeroSmsActivation[];
  refreshedAt: string;
};
export type XhsProfileRead = { name: string; redId: string; bio: string; fans: number; follows: number; likesAndCollects: number };
export type XhsPageContent = { url: string; kind: 'search' | 'profile' | 'feed' | 'other'; notes: XhsHotNote[]; profile: XhsProfileRead | null };
export type XhsPageRead = XhsPageContent & { accountId: number };
export type XhsDraftFillResult = { accountId: number; imageCount: number; title: string; bodyChars: number };
export type AppState = { settings: Settings; stats: { total: number; pending: number; duration: number }; events: WorkEvent[]; codexCapture: CodexCaptureStatus; claudeCapture: ClaudeCaptureStatus; screenCapture: ScreenCaptureStatus; captureStatus: CaptureStatus };

/** 成长 · 链接收藏里的一条。tags 是用户自己打的分类，openedAt 为空表示存下以后还没打开过。 */
export type LinkEntry = { id: number; url: string; title: string; note: string; tags: string[]; createdAt: string; updatedAt: string; openedAt: string };
export type LinkInput = { url: string; title?: string; note?: string; tags?: string[] };

/* ── 变现 · 站点模块（AI 代充） ──────────────────────────────────
 * 把现成的多个站点嵌进窗口，同一时刻显示选中的那个。站点是第三方页面，
 * 各开在自己的 WebContentsView 里、共用独立会话分区：登录态留在那儿，
 * 应用只记一份地址列表，不碰站点数据。这块状态不进 AppState，走单独的 site:* 通道。
 */
export type SiteViewBounds = { x: number; y: number; width: number; height: number };
/** 一个站点：id 由界面生成并保持不变，名称留空时主进程按域名兜底。 */
export type SiteEntry = { id: string; name: string; url: string };
export type SiteModuleState = {
  sites: SiteEntry[];
  /** 当前显示的站点；列表为空时是空串。 */
  activeId: string;
  /** 当前站点停在哪一页，可能已经从首页点到订单页。 */
  currentUrl: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  /** 视图是否正挂在窗口上（离开这个模块就会摘下来）。 */
  visible: boolean;
  error: string;
};

/** 自绘标题栏要的窗口状态：最大化决定按钮图标，失焦时标题栏变淡，macOS 要给红绿灯让位。 */
export type WindowChromeState = { maximized: boolean; fullscreen: boolean; focused: boolean; platform: string };
export type WindowControl = 'minimize' | 'toggle-maximize' | 'close';
export type AppTheme = 'light' | 'dark';

export interface SydneyApi {
  getState(): Promise<AppState>;
  createEvent(event: Partial<WorkEvent>): Promise<number>;
  updateEvent(id: number, patch: Partial<WorkEvent>): Promise<void>;
  deleteEvent(id: number): Promise<void>;
  setCapture(mode: 'start' | 'pause' | 'stop'): Promise<void>;
  saveSettings(settings: Partial<Settings>): Promise<Settings>;
  getCloudSyncStatus(): Promise<CloudSyncStatus>;
  runCloudSync(): Promise<CloudSyncStatus>;
  getCloudSyncKeyStatus(): Promise<LlmKeyStatus>;
  saveCloudSyncKey(value: string): Promise<LlmKeyStatus>;
  deleteCloudSyncKey(): Promise<LlmKeyStatus>;
  chooseVault(): Promise<string | null>;
  openVault(): Promise<string>;
  chooseFiles(): Promise<string[]>;
  generateDailySummary(): Promise<string>;
  generateWeeklySummary(): Promise<string>;
  generateWorkflow(): Promise<{ target: string; count: number }>;
  /** Write the AI collaboration review (Codex + Claude) for the last `days` days into the vault. */
  generateAiReview(days?: number): Promise<AiReviewResult>;
  getEvolutionState(): Promise<EvolutionState>;
  draftRule(id: number): Promise<RuleCandidateView>;
  updateRule(id: number, ruleText: string): Promise<RuleCandidateView>;
  previewRule(id: number): Promise<RulePatchPreview[]>;
  applyRule(id: number, targets: string[]): Promise<RuleCandidateView>;
  rejectRule(id: number): Promise<RuleCandidateView>;
  undoRule(id: number): Promise<{ candidate: RuleCandidateView; restored: string[]; skipped: string[] }>;
  extractExperienceCards(days?: number): Promise<CardExtractResult>;
  draftEvent(id: number): Promise<EventDraft>;
  applyDraft(id: number): Promise<void>;
  clearDraft(id: number): Promise<void>;
  getLlmKeyStatus(): Promise<LlmKeyStatus>;
  saveLlmKey(value: string): Promise<LlmKeyStatus>;
  deleteLlmKey(): Promise<LlmKeyStatus>;
  getHeroSmsKeyStatus(): Promise<LlmKeyStatus>;
  saveHeroSmsKey(value: string): Promise<LlmKeyStatus>;
  deleteHeroSmsKey(): Promise<LlmKeyStatus>;
  /** 用当前 HeroSMS key 查询余额，作为最小连通性测试。 */
  testHeroSmsKey(): Promise<{ balance: number; currency: string }>;
  /** 余额、国家、服务和当前活跃号码；只在用户打开 / 刷新模块时请求。 */
  getHeroSmsOverview(): Promise<HeroSmsOverview>;
  /** 查询所选国家 / 服务当前的号码数量与价格。 */
  getHeroSmsOffer(serviceCode: string, countryId: number): Promise<HeroSmsOffer>;
  /** 查询一个服务在所有国家的报价，用于直接写进国家下拉项。 */
  getHeroSmsCountryOffers(serviceCode: string): Promise<HeroSmsCountryOffer[]>;
  /** 明确点击确认后才调用；返回刚购买的号码。 */
  buyHeroSmsNumber(serviceCode: string, countryId: number, maxPrice?: number): Promise<HeroSmsActivation>;
  getHeroSmsActivation(id: string): Promise<HeroSmsActivationStatus>;
  resendHeroSmsCode(id: string): Promise<HeroSmsActivationStatus>;
  finishHeroSmsActivation(id: string): Promise<void>;
  cancelHeroSmsActivation(id: string): Promise<void>;
  listContentTasks(): Promise<ContentTask[]>;
  getContentTaxonomy(): Promise<ContentTaxonomy>;
  /** 保存两级内容方向；返回归一化后的结果（含新分配的 id 与默认具体方向）。 */
  saveContentTaxonomy(directions: ContentDirectionInput[], defaultSubdirectionId?: number | null): Promise<ContentTaxonomy>;
  /** 用内容 API 把约束原稿整理成规则条目；只返回建议，不落库。 */
  optimizeDirectionNote(request: DirectionNoteRequest): Promise<DirectionNoteSuggestion>;
  /** 按内容方向与已写内容优化配图风格模板，只返回建议。 */
  optimizeImageStyle(request: ImageStyleRequest): Promise<DirectionNoteSuggestion>;
  createContentTask(directionId: number | null, subdirectionId: number | null, topic?: string): Promise<ContentTask>;
  /** 删除文章任务与它在应用目录里的配图；已导出到知识库的文件不动。 */
  deleteContentTask(id: number): Promise<void>;
  updateContentTask(id: number, patch: Partial<ContentTask>): Promise<ContentTask>;
  /** 公众号选题：优先查红狐公众号作品库，失败时按关键词联网搜索。 */
  searchContentTopics(query: XhsHotspotQuery): Promise<XhsHotspotResult>;
  generateContentStage(id: number, stage: ContentStage): Promise<ContentTask>;
  generateContentCover(id: number): Promise<ContentTask>;
  generateContentImages(id: number, count?: number): Promise<ContentTask>;
  /** 一次同时生成封面与正文配图；imageWarning 非空表示只完成了一部分或有降级说明。 */
  generateContentImagesWithCover(id: number, count?: number): Promise<ContentTask & { imageWarning: string }>;
  /**
   * 生成候选图但不落正文/封面：每处出 candidates 张，交给用户挑。
   * 只有 candidates > 1 时才有意义（1 张走上面两个「生成即插入」的入口）。
   */
  generateContentImageCandidates(id: number, scope: ImageCandidateScope, count?: number, candidates?: number): Promise<ImageCandidateBundle>;
  /**
   * 打开「以前生成的图」候选面板：不打图片接口、不花钱，把这篇任务已经生成过的图按位置列出来挑。
   * 正文为空时只列封面；这篇文章还没生成过任何图时 groups 为空，warning 说明原因。
   */
  openContentImageLibrary(id: number, scope: ImageCandidateScope): Promise<ImageCandidateBundle>;
  /** 这篇文章生成过的封面与正文配图（带缩略图），给「文章配图」逐张换图用；不打图片接口。 */
  listContentImageHistory(id: number): Promise<{ cover: ImageCandidateOption[]; inline: ImageCandidateOption[] }>;
  /**
   * 把正文里第 index 张配图（或 'cover' 封面）换成这篇文章生成过的另一张图；换正文配图需重新审稿。
   * expected 是界面上看到的那张图的原路径，位置对不上时拒绝替换。
   */
  swapContentImage(id: number, index: number | 'cover', path: string, expected?: string): Promise<ContentTask>;
  /** 采用用户挑好的候选图；key 来自候选分组。返回落库后的文章。 */
  applyContentImageCandidates(id: number, picks: Array<{ key: string; path: string }>): Promise<ContentTask>;
  /** 放弃这次候选（界面关掉候选面板时调用），只是丢内存里的临时状态。 */
  discardContentImageCandidates(id: number): Promise<void>;
  /** 中断正在进行的生图（长等待时的出口）；返回是否真的中断了某个请求。 */
  cancelContentImages(id: number): Promise<boolean>;
  getContentAssets(id: number): Promise<ContentAssetBundle>;
  renderContentPreview(id: number, source?: 'draft' | 'final'): Promise<{ html: string }>;
  chooseContentCover(id: number): Promise<ContentTask | null>;
  /** 用公众号当前 IP 的模板本地出 2.35:1 封面（写成这篇的封面）和 1:1 分享图（另存），不调图片接口。 */
  renderContentIpCover(id: number, input: WechatIpCoverInput): Promise<{ task: ContentTask; share: { path: string; thumbnail: string } }>;
  /** 在资源管理器里显示这篇文章素材目录里的某个文件。 */
  revealContentAsset(id: number, file: string): Promise<void>;
  publishContentTask(id: number, allowUnreviewed?: boolean): Promise<ContentTask & { mediaId: string }>;
  exportContentTask(id: number, allowUnreviewed?: boolean): Promise<ContentTask>;
  getWeWriteEnvironment(): Promise<WeWriteEnvironment>;
  getWeWriteOverview(): Promise<WeWriteOverview>;
  saveWeWriteConfig(config: WeWriteConfigDraft): Promise<WeWriteOverview>;
  getModelConfig(): Promise<ModelConfigView>;
  saveModelConfig(draft: ModelConfigDraft): Promise<ModelConfigView>;
  testContentModel(): Promise<{ model: string }>;
  /** 把表单里的模型配置存成预设（同类型同名覆盖），不改动当前在用的配置。 */
  saveModelPreset(input: ModelPresetInput): Promise<ModelConfigView>;
  /** 切换到某个预设：写回 config.yaml / 内容 key 的安全存储，之后所有模块都用它。 */
  applyModelPreset(id: string): Promise<ModelConfigView>;
  deleteModelPreset(id: string): Promise<ModelConfigView>;
  /** profileId 为公众号资料（一级方向）id；传 null 返回全部。 */
  getArticleStats(profileId: number | null): Promise<ArticleStatsView>;
  /** 弹出文件选择框导入后台导出的数据表；用户取消时返回 null。返回的视图按 profileId 过滤。 */
  importArticleStats(profileId: number | null): Promise<ArticleStatsImportResult | null>;
  deleteArticleStat(id: number, profileId: number | null): Promise<ArticleStatsView>;
  listVideoProjects(): Promise<VideoProject[]>;
  /** 视频选题搜索：按发布平台调用对应红狐接口，失败或没有 Key 时改用平台化联网搜索。 */
  searchVideoTopics(query: VideoTopicSearchQuery): Promise<VideoTopicSearchResult>;
  createVideoProject(platform: VideoPlatform, topic?: string): Promise<VideoProject>;
  /** 删除视频任务与它的封面文件；已导出的发布包不动。 */
  deleteVideoProject(id: number): Promise<void>;
  updateVideoProject(id: number, patch: Partial<VideoProject>): Promise<VideoProject>;
  generateVideoStage(id: number, stage: VideoStage): Promise<VideoProject>;
  generateVideoCover(id: number): Promise<VideoProject>;
  chooseVideoCover(id: number): Promise<VideoProject | null>;
  /** 用这条视频选的 IP 本地排版出竖版封面（不调图片接口）。 */
  renderVideoIpCover(id: number, input: VideoIpCoverInput): Promise<VideoProject>;
  getVideoAssets(id: number): Promise<VideoAssetBundle>;
  exportVideoProject(id: number): Promise<VideoProject>;
  openVideoPackage(id: number): Promise<string>;
  /** 逐镜配音：只补缺失或口播改过的镜头；force 时按当前配音设置全部重配。 */
  generateVideoVoice(id: number, force?: boolean): Promise<VideoProject>;
  /** 逐镜 AI 配图：只补缺失或提示词改过的镜头。 */
  generateVideoImages(id: number, force?: boolean): Promise<VideoProject>;
  /** 每镜渲染一帧预览，渲染成片前自查。 */
  renderVideoPreview(id: number): Promise<VideoProject>;
  renderVideo(id: number): Promise<VideoProject>;
  /** 把当前有效成片另存为 .mp4；用户取消时返回 null。 */
  saveVideoMp4(id: number): Promise<string | null>;
  /** 选择背景音乐；用户取消时返回 null。 */
  chooseVideoBgm(id: number): Promise<VideoProject | null>;
  openVideoFile(id: number): Promise<string>;
  getVideoTtsStatus(): Promise<VideoTtsStatus>;
  saveVideoTtsSettings(patch: Partial<VideoTtsSettings>): Promise<VideoTtsStatus>;
  saveVideoTtsKey(value: string): Promise<VideoTtsStatus>;
  deleteVideoTtsKey(): Promise<VideoTtsStatus>;
  /** 订阅配音 / 配图 / 渲染的进度；返回取消订阅函数。 */
  onVideoProgress(callback: (progress: VideoProgress) => void): () => void;
  listXhsAccounts(): Promise<XhsAccount[]>;
  updateXhsAccount(id: number, patch: Partial<Pick<XhsAccount, 'name' | 'positioningJson' | 'ipId'>>): Promise<XhsAccount>;
  /** 新建一个小红书账号（名字不能重复）。 */
  createXhsAccount(name: string): Promise<XhsAccount>;
  /** 只能删没有笔记、报告和导入数据的空账号，且至少保留一个。 */
  deleteXhsAccount(id: number): Promise<void>;
  /** 定位问答走一步：answer 为空表示开始 / 继续提问；finish 为 true 时让教练直接出定位档案。 */
  stepXhsPositioning(accountId: number, answer: string, finish: boolean): Promise<XhsAccount>;
  resetXhsPositioning(accountId: number): Promise<XhsAccount>;
  /** 把定位档案里的前 20 篇选题（按下标）转成笔记任务，已转过的同名选题跳过。 */
  adoptXhsPositioningTopics(accountId: number, indexes: number[]): Promise<{ created: number; skipped: number }>;
  /** 向导：description 为空时只按规则推荐。 */
  recommendXhsRoute(accountId: number, description: string): Promise<XhsRouterAdvice>;
  listXhsNotes(accountId: number): Promise<XhsNote[]>;
  /** source 为热点笔记时，用它的标题做选题并记下来源。 */
  createXhsNote(accountId: number, topic: string, source?: XhsHotNote | null): Promise<XhsNote>;
  updateXhsNote(accountId: number, id: number, patch: Partial<XhsNote>): Promise<XhsNote>;
  deleteXhsNote(accountId: number, id: number): Promise<void>;
  /** 正文 / 按检测回改 / 标题工坊 / 发布前检测 / 图文卡片分页。 */
  generateXhsNote(accountId: number, id: number, stage: XhsGenerateStage, options?: { pageCount?: number; style?: string }): Promise<XhsNote>;
  /** 上游改过之后，人工确认某个产物仍然可用（重新盖上当前指纹）。 */
  confirmXhsBasis(accountId: number, id: number, key: keyof XhsBasis): Promise<XhsNote>;
  generateXhsCover(accountId: number, id: number, brief: string): Promise<XhsNote>;
  chooseXhsCover(accountId: number, id: number): Promise<XhsNote | null>;
  /** 用账号当前 IP 的封面模板本地排版出封面（不调图片接口），写成这篇笔记的封面。 */
  renderXhsIpCover(accountId: number, id: number, input: XhsIpCoverInput): Promise<XhsNote>;
  /** IP 库：全应用共用的 IP 形象，各内容模块各自选用。 */
  listIps(): Promise<IpLibraryView>;
  createIp(name: string): Promise<IpLibraryView>;
  updateIp(id: string, patch: IpProfilePatch): Promise<IpLibraryView>;
  deleteIp(id: string): Promise<IpLibraryView>;
  /** 选一张本地图片作为头像 / 新角色动作 / 参考图；取消选择时返回 null。 */
  addIpImage(id: string, kind: 'avatar' | 'pose' | 'reference', label?: string): Promise<IpLibraryView | null>;
  removeIpPose(id: string, poseId: string): Promise<IpLibraryView>;
  /** 模块级的 IP 选择（公众号、视频）；小红书按账号存在账号上。 */
  selectIp(module: IpModule, id: string): Promise<IpLibraryView>;
  /** 模板渲染用的 IP 资料（图片是 data URI）。 */
  getIpKit(id: string): Promise<IpRenderKit>;
  onIpChanged(callback: () => void): () => void;
  /** 把图文卡片逐页渲染成 3:4 PNG，替换图组里旧的卡片图。 */
  renderXhsCards(accountId: number, id: number): Promise<XhsNote>;
  /** 生图信息图：single 出 1 张总览图；pages 按卡片分页逐页出图（6–9 张）。 */
  generateXhsInfoImages(accountId: number, id: number, mode: 'single' | 'pages'): Promise<XhsNote>;
  cancelXhsImages(accountId: number, id: number): Promise<boolean>;
  addXhsLocalImages(accountId: number, id: number): Promise<XhsNote | null>;
  /** 图组排序 / 删除：只接受当前图组里已有的路径。 */
  arrangeXhsImages(accountId: number, id: number, paths: string[]): Promise<XhsNote>;
  /** 把候选图库里的某张图设为封面。 */
  useXhsCandidateAsCover(accountId: number, id: number, path: string): Promise<XhsNote>;
  /** 从候选图库里删掉一张没在用的图（连同应用目录里的文件）。 */
  removeXhsCandidate(accountId: number, id: number, path: string): Promise<XhsNote>;
  getXhsNoteAssets(accountId: number, id: number): Promise<XhsNoteAssets>;
  exportXhsNote(accountId: number, id: number): Promise<XhsNote>;
  openXhsPackage(accountId: number, id: number): Promise<string>;
  searchXhsHotspot(query: XhsHotspotQuery): Promise<XhsHotspotResult>;
  /** 没有热度数据时，按定位档案让模型给选题建议（标明未经数据验证）。 */
  suggestXhsTopics(accountId: number, keyword: string): Promise<XhsTopicIdea[]>;
  runXhsAudit(accountId: number, input: XhsAuditInput): Promise<XhsReport>;
  listXhsReports(accountId: number, kind: XhsReport['kind']): Promise<XhsReport[]>;
  deleteXhsReport(accountId: number, id: number): Promise<void>;
  getXhsAnalytics(accountId: number): Promise<XhsAnalyticsView>;
  /** 弹出文件选择框导入创作者中心导出的笔记数据；用户取消时返回 null。 */
  importXhsStats(accountId: number): Promise<XhsStatsImportResult | null>;
  deleteXhsStat(accountId: number, id: number): Promise<XhsAnalyticsView>;
  interpretXhsAnalytics(accountId: number): Promise<XhsAnalyticsView>;
  getXhsView(accountId: number): Promise<XhsViewState>;
  /** 显示某个账号的小红书窗口：每个账号一个独立会话，登录状态互不相通。 */
  openXhsView(accountId: number): Promise<XhsViewState>;
  closeXhsView(accountId: number): Promise<void>;
  setXhsViewBounds(accountId: number, bounds: SiteViewBounds | null): Promise<void>;
  /** publish 打开网页版创作者中心的发布页（不代填、不代发，只是打开）。 */
  navigateXhsView(accountId: number, target: { kind: 'home' | 'search' | 'publish' | 'url'; value?: string }): Promise<XhsViewState>;
  xhsViewGo(accountId: number, action: 'back' | 'reload'): Promise<XhsViewState>;
  /** 读取窗口里当前已渲染的页面（搜索结果 / 主页 / 发现页）；遇到登录或验证页会报错。 */
  readXhsView(accountId: number): Promise<XhsPageRead>;
  /** 在当前账号的创作者中心打开图文发布页，上传图片并填入标题、正文与标签；不会点击发布。 */
  fillXhsDraft(accountId: number, id: number): Promise<XhsDraftFillResult>;
  onXhsViewChanged(callback: (accountId: number) => void): () => void;
  /** 一次性把公众号现有的内容 / 图片接口配置（含 key）复制过来；之后两边各改各的。 */
  /** 用小红书的内容模型配置发一次最小请求。 */
  getRedfoxKeyStatus(): Promise<LlmKeyStatus>;
  saveRedfoxKey(value: string): Promise<LlmKeyStatus>;
  deleteRedfoxKey(): Promise<LlmKeyStatus>;
  /** 用已保存的 key 发一次最小查询；失败时抛出可读的错误。 */
  testRedfoxKey(): Promise<{ total: number }>;
  /** 用系统浏览器打开笔记或搜索结果链接；只接受 http/https。 */
  openXhsLink(url: string): Promise<void>;
  listLinks(): Promise<LinkEntry[]>;
  /** 地址只接受 http/https，没写协议补 https；同一地址不能重复收藏。 */
  createLink(input: LinkInput): Promise<LinkEntry>;
  updateLink(id: number, input: LinkInput): Promise<LinkEntry>;
  deleteLink(id: number): Promise<void>;
  /** 用系统浏览器打开库里存的地址，并记下打开时间。 */
  openLink(id: number): Promise<LinkEntry>;
  getSiteModule(): Promise<SiteModuleState>;
  /**
   * 保存整份站点列表（增、删、改名、换地址都走这里）；
   * activateId 只在该 id 确实在列表里时才切过去。地址只接受 http/https。
   */
  saveSiteModule(sites: SiteEntry[], activateId?: string | null): Promise<SiteModuleState>;
  /** 切换当前显示的站点；站点已经开过就只是摘一挂一，不重新加载。 */
  activateSiteModule(id: string): Promise<SiteModuleState>;
  /** 把当前站点的视图挂到窗口上；界面报位置之前不会真的显示。 */
  openSiteModule(): Promise<SiteModuleState>;
  /** 从窗口上摘下来。站点进程留着，切回来时登录态和滚动位置还在。 */
  closeSiteModule(): Promise<void>;
  /** 界面把承载区域的位置报给主进程；主进程会夹进窗口可视区。 */
  setSiteModuleBounds(bounds: SiteViewBounds | null): Promise<void>;
  siteModuleGo(action: 'back' | 'reload' | 'home'): Promise<SiteModuleState>;
  /** 支付页、客服链接这类需要完整浏览器能力的目标，交给系统浏览器。 */
  openSiteModuleInBrowser(): Promise<void>;
  getEmbeddedView(key: EmbeddedSiteKey): Promise<EmbeddedViewState>;
  /** 把站点视图挂到窗口上；界面报位置之前不会真的显示。 */
  openEmbeddedView(key: EmbeddedSiteKey): Promise<EmbeddedViewState>;
  /** 从窗口上摘下来，页面进程留着，切回来登录态与浏览位置都在。 */
  closeEmbeddedView(key: EmbeddedSiteKey): Promise<void>;
  setEmbeddedViewBounds(key: EmbeddedSiteKey, bounds: SiteViewBounds | null): Promise<void>;
  embeddedViewGo(key: EmbeddedSiteKey, action: 'back' | 'reload' | 'home'): Promise<EmbeddedViewState>;
  openEmbeddedInBrowser(key: EmbeddedSiteKey): Promise<void>;
  onEmbeddedViewChanged(key: EmbeddedSiteKey, callback: () => void): () => void;
  onChanged(callback: () => void): () => void;
  onWeWriteChanged(callback: () => void): () => void;
  onSiteModuleChanged(callback: () => void): () => void;
  getWindowChrome(): Promise<WindowChromeState>;
  windowControl(action: WindowControl): Promise<void>;
  /** 界面换主题后通知主进程：窗口底色、右键菜单跟着换，下次启动按它建窗。 */
  setTheme(theme: AppTheme): Promise<void>;
  onWindowChromeChanged(callback: (state: WindowChromeState) => void): () => void;
}
