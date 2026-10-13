import type { XhsFunnelLayer, XhsNoteType, XhsStepKey, XhsTab } from '../shared.ts';

/**
 * 小红书模块的「定义表」：笔记类型、标题方法、检测项、诊断维度、漏斗层级、卡片风格。
 *
 * 这些是推文那套 Skill 的方法论落成的数据，提示词、本地规则和界面都从这里取，
 * 改一处全模块生效。纯数据，无 Node 依赖，渲染进程也直接引用。
 */

export const XHS_BODY_LIMIT = 1000;
export const XHS_TITLE_LIMIT = 20;
export const XHS_TAG_RANGE = { min: 3, max: 10 };

export const XHS_NOTE_TYPES: Array<{ value: XhsNoteType; label: string; structure: string }> = [
  { value: 'review', label: '种草测评', structure: '开头点明测了什么、适合谁 → 3-5 个维度逐条说优缺点（真实感受 + 具体场景）→ 总结适合 / 不适合的人 → 互动' },
  { value: 'tutorial', label: '干货教程', structure: '开头给结果或痛点 → 步骤 1、2、3（每步一个动作 + 一个注意点）→ 常见误区 → 收藏提醒 + 互动' },
  { value: 'story', label: '个人故事', structure: '开头一个具体瞬间 → 起因 → 转折 → 我学到的 1-2 条 → 给读者的一句话 + 互动' },
  { value: 'list', label: '合集清单', structure: '开头说明清单解决什么问题 → 编号条目（名称 + 一句理由 + 适合谁）→ 选择建议 → 收藏提醒 + 互动' },
  { value: 'avoid', label: '避雷拔草', structure: '开头直接说结论（别踩这个坑）→ 坑在哪里、为什么 → 替代做法 → 理性提醒（不攻击具体品牌 / 个人）+ 互动' },
  { value: 'share', label: '好物分享', structure: '开头一句使用场景 → 是什么、解决了什么 → 使用细节与小缺点 → 适合谁 + 互动' },
  { value: 'recap', label: '经验复盘', structure: '开头交代背景和结果 → 做对的 2-3 件事 → 做错的 1-2 件事 → 下次怎么做 → 互动' }
];

export function xhsNoteTypeLabel(value: string): string {
  return XHS_NOTE_TYPES.find(item => item.value === value)?.label ?? '干货教程';
}

/** 15 种标题方法：标题工坊按这些方法各出候选。 */
export const XHS_TITLE_METHODS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'number', label: '数字盘点', hint: '用具体数字给出确定感，例如「3 个习惯」' },
  { key: 'question', label: '痛点提问', hint: '把读者的困扰直接问出来' },
  { key: 'counter', label: '反常识', hint: '挑战一个常见误解（必须有依据）' },
  { key: 'result', label: '结果前置', hint: '先给读者能得到的结果' },
  { key: 'crowd', label: '人群点名', hint: '点出「谁」该看，例如「家有老人的」' },
  { key: 'contrast', label: '对比反差', hint: '前后、对错、两种做法对比' },
  { key: 'suspense', label: '悬念留白', hint: '留一个读者想知道的答案' },
  { key: 'warning', label: '避坑提醒', hint: '提醒别做什么' },
  { key: 'steps', label: '步骤教程', hint: '「手把手」「一步步」的教程感' },
  { key: 'emotion', label: '情绪共鸣', hint: '说中读者的情绪或处境' },
  { key: 'scene', label: '场景代入', hint: '把读者放进一个具体场景' },
  { key: 'experience', label: '亲历分享', hint: '基于用户提供的真实经历；没有素材时不要用' },
  { key: 'save', label: '省时省事', hint: '强调省时间、省力气、省钱' },
  { key: 'timely', label: '时间节点', hint: '换季、节气、节日等时间钩子' },
  { key: 'collection', label: '收藏合集', hint: '「建议收藏」「一篇看懂」式的合集' }
];

export const XHS_TITLE_ROLES: Record<'primary' | 'backup' | 'test', string> = { primary: '主推', backup: '备选', test: 'A/B 测试用' };

/**
 * 绝对化 / 夸大 / 医疗功效用语。命中只提示风险，由人判断：
 * 「最近」里的「最」这类误伤靠排除词处理。
 */
export const XHS_RISK_WORDS: Array<{ word: string; reason: string }> = [
  { word: '最', reason: '绝对化用语' },
  { word: '第一', reason: '绝对化用语' },
  { word: '顶级', reason: '绝对化用语' },
  { word: '100%', reason: '绝对化承诺' },
  { word: '百分百', reason: '绝对化承诺' },
  { word: '绝对', reason: '绝对化用语' },
  { word: '永久', reason: '绝对化承诺' },
  { word: '根治', reason: '医疗功效宣称' },
  { word: '治愈', reason: '医疗功效宣称' },
  { word: '包治', reason: '医疗功效宣称' },
  { word: '药到病除', reason: '医疗功效宣称' },
  { word: '神药', reason: '医疗功效宣称' },
  { word: '抗癌', reason: '医疗功效宣称' },
  { word: '排毒', reason: '伪科学功效' },
  { word: '降血压', reason: '医疗功效宣称（需谨慎表述）' },
  { word: '降血糖', reason: '医疗功效宣称（需谨慎表述）' },
  { word: '秒杀', reason: '夸大用语' },
  { word: '神器', reason: '夸大用语' },
  { word: '史上', reason: '绝对化用语' },
  { word: '全网', reason: '绝对化用语' },
  { word: '无副作用', reason: '绝对化承诺' }
];
/** 含「最」但不是绝对化用语的常见词。 */
export const XHS_RISK_EXCEPTIONS = ['最近', '最后', '最初', '最好还是', '最终', '最少', '最多'];

/** 14 项发布前检测：前 9 项本地规则即可判断，后 5 项需要模型。 */
export const XHS_CHECKS: Array<{ id: string; label: string; source: 'local' | 'model'; hint: string }> = [
  { id: 'title_length', label: '标题不超过 20 字', source: 'local', hint: '小红书标题上限 20 字，超出发不出去' },
  { id: 'body_length', label: '正文不超过 1000 字', source: 'local', hint: '小红书正文上限 1000 字' },
  { id: 'body_min', label: '正文信息量足够', source: 'local', hint: '少于 150 字很难兑现标题承诺' },
  { id: 'tag_count', label: '标签 3–10 个', source: 'local', hint: '太少拿不到搜索流量，太多显得堆砌' },
  { id: 'tag_format', label: '标签干净不重复', source: 'local', hint: '标签不要带空格、标点或重复' },
  { id: 'emoji_density', label: 'emoji 密度适中', source: 'local', hint: '每 100 字不超过 4 个，满屏 emoji 影响阅读' },
  { id: 'risk_words', label: '无绝对化 / 功效宣称用语', source: 'local', hint: '「最」「根治」「100%」这类词容易被限流或违规' },
  { id: 'contact', label: '无外链与联系方式', source: 'local', hint: '链接、微信号、手机号、引流话术会被限流' },
  { id: 'paragraph', label: '段落短、手机上好读', source: 'local', hint: '单段不超过 120 字' },
  { id: 'hook', label: '开头 3 行留得住人', source: 'model', hint: '前 3 行要让人想继续往下看' },
  { id: 'payoff', label: '标题承诺在正文兑现', source: 'model', hint: '标题说了什么，正文就要给到什么' },
  { id: 'compliance', label: '符合内容方向的合规约束', source: 'model', hint: '例如健康科普不诊断、不开药方、不给剂量' },
  { id: 'persona', label: '与人设语气一致', source: 'model', hint: '和定位档案里的人设说话方式一致' },
  { id: 'interaction', label: '结尾有自然的互动引导', source: 'model', hint: '提一个具体、好回答的问题，而不是「求关注」' }
];

/** 账号诊断的 8 个维度。 */
export const XHS_AUDIT_DIMENSIONS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'positioning', label: '定位清晰度', hint: '主页一眼能看出是谁、给谁看、提供什么' },
  { key: 'vertical', label: '内容垂直度', hint: '笔记是否集中在 3-5 个内容支柱' },
  { key: 'cover', label: '封面统一性', hint: '封面风格、配色、字体是否统一可识别' },
  { key: 'hook', label: '标题钩子率', hint: '标题里有明确钩子（数字、痛点、结果…）的比例' },
  { key: 'cadence', label: '更新节奏', hint: '发布频率与稳定性' },
  { key: 'engagement', label: '互动率', hint: '平均互动 / 粉丝数' },
  { key: 'hits', label: '爆款率', hint: '远高于账号中位数的笔记占比' },
  { key: 'conversion', label: '粉丝转化', hint: '获赞收藏转化成粉丝的效率' }
];

/** 六层漏斗：从曝光到涨粉，每层对应链路 C 的一个对症环节。 */
export const XHS_FUNNEL_LAYERS: Array<{ key: XhsFunnelLayer; label: string; metric: string; remedy: string; tab: XhsTab; step?: XhsStepKey }> = [
  { key: 'exposure', label: '曝光', metric: '曝光量', remedy: '曝光低：先做账号诊断，查标签、定位与账号权重', tab: 'audit' },
  { key: 'click', label: '点击', metric: '封面点击率（观看 / 曝光）', remedy: '曝光够、点击率低：改标题与封面', tab: 'notes', step: 'title' },
  { key: 'depth', label: '阅读深度', metric: '人均观看时长或完播率', remedy: '点了但没看完：改正文开头，前 3 行留住人', tab: 'notes', step: 'body' },
  { key: 'engagement', label: '互动', metric: '（点赞 + 评论）/ 观看', remedy: '看完不互动：改正文的价值兑现与结尾互动', tab: 'notes', step: 'body' },
  { key: 'save', label: '收藏转发', metric: '（收藏 + 分享）/ 观看', remedy: '收藏少：提高干货密度，标题给出收藏动机', tab: 'notes', step: 'body' },
  { key: 'follow', label: '涨粉', metric: '涨粉 / 观看', remedy: '内容好但不涨粉：回到账号定位，让主页与人设更清楚', tab: 'positioning' }
];

export function xhsFunnelLabel(layer: string): string {
  return XHS_FUNNEL_LAYERS.find(item => item.key === layer)?.label ?? '';
}

/** 图文卡片风格（本地 HTML 模板）。颜色都是具体值，渲染出来的 PNG 不跟随应用主题。 */
export const XHS_CARD_STYLES: Array<{ key: string; label: string; hint: string; bg: string; ink: string; accent: string; soft: string; font: string }> = [
  { key: 'warm', label: '暖橙大字', hint: '暖白底、大字号、橙色强调，手机上一眼看清', bg: '#FFF8EF', ink: '#2B2118', accent: '#E8742A', soft: '#FDE6CF', font: '"PingFang SC","Microsoft YaHei",sans-serif' },
  { key: 'cream', label: '奶油手账', hint: '米色底、圆角便签、柔和棕色', bg: '#FBF5EA', ink: '#4A3B2C', accent: '#B9835A', soft: '#F1E4CF', font: '"PingFang SC","Microsoft YaHei",sans-serif' },
  { key: 'fresh', label: '清新薄荷', hint: '白底薄荷绿，干净利落', bg: '#F5FBF8', ink: '#16302A', accent: '#1E9E78', soft: '#D7F1E7', font: '"PingFang SC","Microsoft YaHei",sans-serif' },
  { key: 'mono', label: '极简黑白', hint: '黑白灰 + 一点红，杂志感', bg: '#FFFFFF', ink: '#111111', accent: '#E0313B', soft: '#F1F1F1', font: '"PingFang SC","Microsoft YaHei",sans-serif' },
  { key: 'tech', label: '轻盈科技', hint: '白底紫蓝与青柠绿，圆角卡片', bg: '#F7F8FF', ink: '#1C1F3A', accent: '#5B5BF0', soft: '#E4E6FF', font: '"PingFang SC","Microsoft YaHei",sans-serif' }
];

export function xhsCardStyle(key: string) {
  return XHS_CARD_STYLES.find(item => item.key === key) ?? XHS_CARD_STYLES[0];
}

export const XHS_PAGE_COUNTS = [6, 7, 8, 9];

/** 封面的通用画风：不预设读者群体，读者与调性来自定位档案，画面内容来自笔记本身。 */
export const XHS_COVER_STYLE = [
  '画风：小红书常见的清爽质感，主体突出、构图干净、色彩协调，避免拥挤和强刺激色彩。',
  '画面里的中文标题要写对、写清楚、字号够大；不要水印或 logo，不要真实品牌标识，不要夸张或令人不适的画面。'
].join('\n');

/** 生图信息图的固定风格（推文 space-xhs-image 的「轻盈 AI 产品信息图」）。 */
export const XHS_INFO_IMAGE_STYLE = [
  '小红书竖版信息图，3:4 构图。',
  '风格：白底，紫蓝色为主色、青柠绿做点缀强调，圆角卡片分区，线性图标，留白充足，信息层级清楚。',
  '画面里的中文标题与要点要写对、写清楚、字号够大；一张图只讲一个主题，不要堆砌；不要水印或 logo，不要真实品牌标识。'
].join('\n');

export const XHS_TAB_LABELS: Record<XhsTab, string> = {
  home: '向导', positioning: '账号定位', hotspot: '热点选题', notes: '笔记创作', audit: '账号诊断', analytics: '笔记复盘', browser: '小红书窗口'
};
