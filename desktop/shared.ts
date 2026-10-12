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
export type ContentCategory = 'nutrition' | 'wellbeing' | 'family' | 'general';
export type ContentStage = 'topics' | 'brief' | 'claims' | 'draft' | 'review' | 'revise';
/** 前端可视化用的图片：thumbnail 是小尺寸 data URI，path 只作标识与排错。 */
export type ContentAssetView = { path: string; caption: string; thumbnail: string };
export type ContentAssetBundle = { cover: ContentAssetView | null; images: ContentAssetView[] };
export type ContentTaskStatus = 'idea' | 'brief' | 'draft' | 'review' | 'ready' | 'published';
export type ContentTask = {
  id: number;
  category: ContentCategory;
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
export type WeWriteRunStatus = 'active' | 'failed' | 'completed';
export type WeWriteStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
export type WeWriteStep = { name: string; label: string; status: WeWriteStepStatus; updated: string };
export type WeWriteRunSummary = {
  id: string;
  title: string;
  status: WeWriteRunStatus;
  mode: string;
  createdAt: string;
  updatedAt: string;
  steps: Record<string, WeWriteStepStatus>;
  completedSteps: number;
  totalSteps: number;
  verifiedSourceCount: number;
  sourceCount: number;
  publishAllowed: boolean;
  lastError: string;
  hasArticle: boolean;
  hasPreview: boolean;
};
export type WeWriteRunDetail = WeWriteRunSummary & {
  keywords: string[];
  framework: string;
  persona: string;
  enhanceStrategy: string;
  wordCount: number;
  stepList: WeWriteStep[];
  artifacts: Record<string, string>;
  runDirectory: string;
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
  cliAvailable: boolean;
  cliError: string;
  cliVersion: string;
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
  skills: { total: number; elderHealth: boolean; complianceReference: boolean; topicReference: boolean };
  counts: { total: number; active: number; completed: number; failed: number };
};
export type WeWriteEnvironment = {
  cliAvailable: boolean;
  cliError: string;
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
export type WeWriteActionResult =
  | { ok: true; output: string; html?: string; target?: string }
  | { ok: false; error: string; detail: string };

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
  createContentTask(category: ContentCategory, topic?: string): Promise<ContentTask>;
  updateContentTask(id: number, patch: Partial<ContentTask>): Promise<ContentTask>;
  generateContentStage(id: number, stage: ContentStage): Promise<ContentTask>;
  generateContentCover(id: number): Promise<ContentTask>;
  generateContentImages(id: number, count?: number): Promise<ContentTask>;
  /** 一次同时生成封面与正文配图；imageWarning 非空表示只完成了一部分或有降级说明。 */
  generateContentImagesWithCover(id: number, count?: number): Promise<ContentTask & { imageWarning: string }>;
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
  listWeWriteRuns(includeCompleted?: boolean): Promise<WeWriteRunSummary[]>;
  getWeWriteRun(runId: string): Promise<WeWriteRunDetail>;
  renderWeWritePreview(runId: string, theme?: string): Promise<WeWriteActionResult>;
  validateWeWritePreview(runId: string): Promise<WeWriteActionResult>;
  scoreWeWriteArticle(runId: string): Promise<WeWriteActionResult>;
  fetchWeWriteHotspots(limit?: number): Promise<WeWriteActionResult>;
  searchWeChatArticles(query: string, days?: number): Promise<WeWriteActionResult>;
  openWeWriteRunDirectory(runId: string): Promise<WeWriteActionResult>;
  getWeWriteCover(runId: string): Promise<WeWriteActionResult>;
  publishWeWriteDraft(runId: string, theme?: string, coverPath?: string): Promise<WeWriteActionResult>;
  listVideoProjects(): Promise<VideoProject[]>;
  createVideoProject(platform: VideoPlatform, topic?: string): Promise<VideoProject>;
  updateVideoProject(id: number, patch: Partial<VideoProject>): Promise<VideoProject>;
  generateVideoStage(id: number, stage: VideoStage): Promise<VideoProject>;
  generateVideoCover(id: number): Promise<VideoProject>;
  chooseVideoCover(id: number): Promise<VideoProject | null>;
  getVideoAssets(id: number): Promise<VideoAssetBundle>;
  exportVideoProject(id: number): Promise<VideoProject>;
  openVideoPackage(id: number): Promise<string>;
  onChanged(callback: () => void): () => void;
  onWeWriteChanged(callback: () => void): () => void;
}
