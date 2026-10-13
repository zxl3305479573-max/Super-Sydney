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
 * 字幕 → 封面 → 制作包。
 * 模型只负责选题、脚本与分镜；字幕与制作包由本地确定性生成，
 * 导出前必须由人确认，模块不代替任何平台做发布。
 */
export type VideoPlatform = 'douyin' | 'shipinhao' | 'xiaohongshu' | 'bilibili' | 'general';
export type VideoStage = 'topics' | 'script' | 'storyboard';
export type VideoProjectStatus = 'idea' | 'script' | 'storyboard' | 'exported';
export type VideoShot = {
  index: number;
  /** 该镜头时长（秒），字幕时间轴由它累加算出。 */
  seconds: number;
  /** 画面：拍什么、用什么素材。 */
  visual: string;
  /** 口播词，进 TTS 或人声。 */
  narration: string;
  /** 屏幕字幕；留空时用口播词。 */
  caption: string;
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
  createdAt: string;
  updatedAt: string;
};
export type VideoAssetBundle = { cover: ContentAssetView | null };
export type AppState = { settings: Settings; stats: { total: number; pending: number; duration: number }; events: WorkEvent[]; codexCapture: CodexCaptureStatus; claudeCapture: ClaudeCaptureStatus; screenCapture: ScreenCaptureStatus; captureStatus: CaptureStatus };

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

export interface SydneyApi {
  getState(): Promise<AppState>;
  createEvent(event: Partial<WorkEvent>): Promise<number>;
  updateEvent(id: number, patch: Partial<WorkEvent>): Promise<void>;
  deleteEvent(id: number): Promise<void>;
  setCapture(mode: 'start' | 'pause' | 'stop'): Promise<void>;
  saveSettings(settings: Partial<Settings>): Promise<Settings>;
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
  listContentTasks(): Promise<ContentTask[]>;
  getContentTaxonomy(): Promise<ContentTaxonomy>;
  /** 保存两级内容方向；返回归一化后的结果（含新分配的 id 与默认具体方向）。 */
  saveContentTaxonomy(directions: ContentDirectionInput[], defaultSubdirectionId?: number | null): Promise<ContentTaxonomy>;
  /** 用内容 API 把约束原稿整理成规则条目；只返回建议，不落库。 */
  optimizeDirectionNote(request: DirectionNoteRequest): Promise<DirectionNoteSuggestion>;
  /** 按内容方向与已写内容优化配图风格模板，只返回建议。 */
  optimizeImageStyle(request: ImageStyleRequest): Promise<DirectionNoteSuggestion>;
  createContentTask(directionId: number | null, subdirectionId: number | null, topic?: string): Promise<ContentTask>;
  updateContentTask(id: number, patch: Partial<ContentTask>): Promise<ContentTask>;
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
  publishContentTask(id: number, allowUnreviewed?: boolean): Promise<ContentTask & { mediaId: string }>;
  exportContentTask(id: number, allowUnreviewed?: boolean): Promise<ContentTask>;
  getWeWriteEnvironment(): Promise<WeWriteEnvironment>;
  getWeWriteOverview(): Promise<WeWriteOverview>;
  saveWeWriteConfig(config: WeWriteConfigDraft): Promise<WeWriteOverview>;
  /** profileId 为公众号资料（一级方向）id；传 null 返回全部。 */
  getArticleStats(profileId: number | null): Promise<ArticleStatsView>;
  /** 弹出文件选择框导入后台导出的数据表；用户取消时返回 null。返回的视图按 profileId 过滤。 */
  importArticleStats(profileId: number | null): Promise<ArticleStatsImportResult | null>;
  deleteArticleStat(id: number, profileId: number | null): Promise<ArticleStatsView>;
  listVideoProjects(): Promise<VideoProject[]>;
  createVideoProject(platform: VideoPlatform, topic?: string): Promise<VideoProject>;
  updateVideoProject(id: number, patch: Partial<VideoProject>): Promise<VideoProject>;
  generateVideoStage(id: number, stage: VideoStage): Promise<VideoProject>;
  generateVideoCover(id: number): Promise<VideoProject>;
  chooseVideoCover(id: number): Promise<VideoProject | null>;
  getVideoAssets(id: number): Promise<VideoAssetBundle>;
  exportVideoProject(id: number): Promise<VideoProject>;
  openVideoPackage(id: number): Promise<string>;
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
  onChanged(callback: () => void): () => void;
  onWeWriteChanged(callback: () => void): () => void;
  onSiteModuleChanged(callback: () => void): () => void;
}
