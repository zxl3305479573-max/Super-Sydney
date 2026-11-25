import type {
  XhsCardLayout, XhsCoverPresetKey, XhsFunnelLayer, XhsInfoPresetKey, XhsMonetizationPathKey, XhsNoteIntent, XhsNoteType, XhsPillarRole, XhsStepKey, XhsTab
} from '../shared.ts';

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

/** 单篇笔记的商业角色：指导正文结构侧重与发布前正规渠道合规提醒（不导微信、不私挂外链）。 */
export const XHS_NOTE_INTENTS: Array<{
  value: XhsNoteIntent;
  label: string;
  hint: string;
  writingRule: string;
  complianceNotice: string;
}> = [
  {
    value: 'organic',
    label: '日常拉新 / 立人设',
    hint: '专注搜索词覆盖、收藏干货密度与涨粉，不挂商业推广',
    writingRule: '',
    complianceNotice: ''
  },
  {
    value: 'sample',
    label: '蒲公英商单 / 样片',
    hint: '品牌合作或置顶样片：在真实使用场景里自然带出体验与客观小缺点',
    writingRule: '本篇承担「蒲公英商单 / 品牌合作样片」角色：保持创作者独立人设与真实生活场景切入，自然融入产品解决的具体痛点与一个真实客观的小边界/适用提醒，切忌写成硬广说明书。',
    complianceNotice: '【蒲公英合作合规提醒】正式商单笔记须在蒲公英平台（pgy.xiaohongshu.com）完成报备，按约定选择是否展示左下角品牌标记（仅自然流量展示）；切勿接水下私单或私贴站外链接。'
  },
  {
    value: 'affiliate',
    label: '买手橱窗 / 笔记挂车',
    hint: '痛点场景 → 选品判断标准 → 细节实测，自然激发问链接与点商品卡',
    writingRule: '本篇承担「买手选品种草 / 笔记挂车」角色：按“具体使用痛点 → 为什么挑这款（选品对比标准）→ 真实细节与适合谁”展开，不喊夸张促销口号，靠选品审美与信任促成站内商品卡转化。',
    complianceNotice: '【买手带货合规提醒】请通过「创作者中心 → 买手合作」正规挂载站内商品卡或主页橱窗（无需走蒲公英商单报备）；切勿在正文或评论区私发淘宝/京东外链与微信号。'
  },
  {
    value: 'service',
    label: '专业咨询 / 个人售卖副业',
    hint: '拆解真实问题诊断思路与解决过程，用专业深度立信（忌搬运空话）',
    writingRule: '本篇承担「专业能力证明 / 个人售卖搞副业获客」角色：聚焦拆解一个具体问题的诊断逻辑、判断依据与解决步骤，用专业深度证明“你真的懂”，绝不堆砌搬运来的空洞方法论，也不写违规引流话术。',
    complianceNotice: '【个人售卖 / 专业服务合规提醒】站内收款请走小红书「个人售卖 → 搞副业」或专业号服务组件在私信合规闭环；严禁在正文、简介或评论留微信号、手机号或“私信领资料”导私域。'
  },
  {
    value: 'local',
    label: '同城门店 / 到店获客',
    hint: '突出城市服务半径、真实服务流程与前后效果，承接到店预约',
    writingRule: '本篇承担「同城门店 / 本地工作室获客」角色：自然交代所在城市或服务场景、真实服务流程细节、适合什么情况的顾客，降低读者到店与预约顾虑，不留电话微信等站外联系方式。',
    complianceNotice: '【同城获客合规提醒】发布时记得挂载门店 POI 定位或专业号站内预约入口；不要在正文或图片里直接印手机号与个人微信号。'
  }
];

export function xhsNoteIntentSpec(value?: string) {
  return XHS_NOTE_INTENTS.find(item => item.value === value) ?? XHS_NOTE_INTENTS[0];
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

/**
 * 典型「AI 味 / 营销号空话」特征词：用于写作阶段反套话约束与编辑区实时预警，帮创作者写出真人呼吸感。
 */
export const XHS_AI_CLICHES: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /家人们谁懂|姐妹们谁懂|宝子们|集美们/, label: '过度网红招呼语（建议删掉直接进场景）' },
  { pattern: /今天给大家分享|今天来聊聊|话不多说|下面一起来看看吧/, label: '报幕式废话开头（前 3 行直接点问题或结论）' },
  { pattern: /干货满满|建议先马后看|不看后悔|吐血整理/, label: '自夸式空洞口号（靠具体数字和步骤自然促收藏）' },
  { pattern: /总而言之|综上所述|由此可见|总的来说/, label: '公文总结套话（换成一句直接的行动提醒）' },
  { pattern: /在当今.{0,8}(?:时代|社会)|快节奏的生活中/, label: '宏大背景铺垫（小红书读者不看背景作文）' },
  { pattern: /赋能|抓手|颗粒度|组合拳|心智占领/, label: '互联网黑话（翻译成日常大白话）' },
  { pattern: /冲就完了|闭眼入不亏/, label: '无依据煽动话术（改成适合谁、不适合谁）' }
];

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
  { id: 'persona', label: 'IP 人设自然融入', source: 'model', hint: '视角、判断与说话方式和人设一致；不是靠自报身份、反复提账号名或硬塞口头禅来体现' },
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

export type XhsCardVariant = 'swiss' | 'memo' | 'bento' | 'editorial' | 'notion' | 'dark' | 'poster' | 'grid' | 'redblack';

export type XhsCardStyleSpec = {
  key: string;
  label: string;
  hint: string;
  variant: XhsCardVariant;
  bg: string;
  sheet: string;
  surface: string;
  ink: string;
  muted: string;
  line: string;
  accent: string;
  soft: string;
  mark: string;
  font: string;
  headingFont: string;
};

const SANS_STACK = '"Segoe UI Variable Text","PingFang SC","HarmonyOS Sans SC","Microsoft YaHei UI","Microsoft YaHei",sans-serif';
const SERIF_STACK = '"Source Han Serif SC","Songti SC","STSong","Noto Serif CJK SC","SimSun",serif';

/**
 * 图文卡片风格（本地 HTML 模板 3.0）：
 * 每套主题对应真实差异化的视觉骨架（variant），彻底告别所有模板共用同一套圆角灰框的廉价同质化：
 * - swiss：杂志实线分栏 + 大号几何序号，无多余内层气泡框；
 * - memo：真实备忘录横线纸文档流 + 荧光笔涂抹，不盖灰底框；
 * - poster：黑黄高反差爆款大字报，粗黑框线 + 反转色条幅；
 * - grid：28px 方格学霸手账纸 + 荧光绿/柠檬黄批注；
 * - redblack：红黑避坑测评榜，深色刊头 + 鲜明结论对比；
 * - editorial：燕麦/杏粉人文书页 + 宋体大标题，温和耐读；
 * - notion / bento / dark：知识库提示块、紧凑模块磁贴与暗夜黑金商业内参。
 * 保留 warm 作为首项默认键以兼容历史笔记数据。
 */
export const XHS_CARD_STYLES: XhsCardStyleSpec[] = [
  {
    key: 'warm', label: '暖调杂志', hint: '暖纸实线分栏 + 焦橙序号，干货清晰饱满', variant: 'swiss',
    bg: '#EFE6DA', sheet: '#FFFDF9', surface: '#F9F2E7', ink: '#221A14', muted: '#655447',
    line: '#D8C8B6', accent: '#D95D24', soft: '#FCE7D8', mark: '#FFD8B5', font: SANS_STACK, headingFont: SANS_STACK
  },
  {
    key: 'poster', label: '黑黄大字报', hint: '高反差粗黑条幅 + 明黄重点，信息流一眼抓人', variant: 'poster',
    bg: '#F2EFE6', sheet: '#FFFDF6', surface: '#FFF9E2', ink: '#141413', muted: '#4A473E',
    line: '#141413', accent: '#D9480F', soft: '#FEF08A', mark: '#FDE047', font: SANS_STACK, headingFont: SANS_STACK
  },
  {
    key: 'memo', label: '原生备忘录', hint: '苹果备忘录横线纸 + 荧光笔批注，天然高收藏', variant: 'memo',
    bg: '#E8E7E3', sheet: '#FFFDF7', surface: '#FAF5E6', ink: '#1C1C1E', muted: '#5C5C60',
    line: '#E5DEC9', accent: '#C88406', soft: '#FEF3C7', mark: '#FDE047', font: SANS_STACK, headingFont: SANS_STACK
  },
  {
    key: 'swiss', label: '苏黎世网格', hint: '瑞士国际主义实线网格 + 朱红大序号，极强秩序感', variant: 'swiss',
    bg: '#E4E1DA', sheet: '#FAF8F4', surface: '#F1EEE7', ink: '#161618', muted: '#525259',
    line: '#18181B', accent: '#D93829', soft: '#FCE8E6', mark: '#FFE17D', font: SANS_STACK, headingFont: SANS_STACK
  },
  {
    key: 'grid', label: '方格手账卡', hint: '28px 学霸方格纸 + 薄荷荧光笔，教程清单超好读', variant: 'grid',
    bg: '#DCE8E1', sheet: '#FCFDFB', surface: '#F2F7F4', ink: '#16261F', muted: '#4B6358',
    line: '#C9DDD1', accent: '#127853', soft: '#D5F4E6', mark: '#BEF264', font: SANS_STACK, headingFont: SANS_STACK
  },
  {
    key: 'redblack', label: '红黑避坑榜', hint: '深炭刊头 + 红绿正反强对比，测评拔草专用', variant: 'redblack',
    bg: '#EAE5E5', sheet: '#FFFFFF', surface: '#F8F6F6', ink: '#18181B', muted: '#52525B',
    line: '#D4D4D8', accent: '#DC2626', soft: '#FEE2E2', mark: '#FECACA', font: SANS_STACK, headingFont: SANS_STACK
  },
  {
    key: 'bento', label: '现代窗口', hint: '桌面窗口顶栏 + 满版 Bento 磁贴，利落科技感', variant: 'bento',
    bg: '#E3E7EE', sheet: '#FFFFFF', surface: '#F5F7FA', ink: '#18181B', muted: '#52525B',
    line: '#DFE3EA', accent: '#EA580C', soft: '#FFEDD5', mark: '#FED7AA', font: SANS_STACK, headingFont: SANS_STACK
  },
  {
    key: 'fresh', label: '森系知识卡', hint: '清爽松绿 + Notion 属性栏与提示块，适合科普养护', variant: 'notion',
    bg: '#DFEFE8', sheet: '#FCFDFC', surface: '#F1F8F4', ink: '#142922', muted: '#48655B',
    line: '#CBE3D7', accent: '#15805D', soft: '#D6F3E6', mark: '#A7F3D0', font: SANS_STACK, headingFont: SANS_STACK
  },
  {
    key: 'cream', label: '人文书摘', hint: '燕麦棉纸 + 宋体大标题，适合个人故事与认知复盘', variant: 'editorial',
    bg: '#E7DDD0', sheet: '#FAF5EC', surface: '#F2EAE0', ink: '#2A2018', muted: '#685747',
    line: '#D6C9B6', accent: '#8F5128', soft: '#EFE1CE', mark: '#F5D6AD', font: SANS_STACK, headingFont: SERIF_STACK
  },
  {
    key: 'morandi', label: '温柔杏粉卡', hint: '低饱和玫瑰杏白 + 衬线标题，居家/身心/好物种草耐看', variant: 'editorial',
    bg: '#EFE3E2', sheet: '#FFFDFC', surface: '#FAF2F1', ink: '#2C1F22', muted: '#6E565B',
    line: '#E6D2D4', accent: '#B84A58', soft: '#FCE7EA', mark: '#FBCFE8', font: SANS_STACK, headingFont: SERIF_STACK
  },
  {
    key: 'tech', label: '蓝紫参数卡', hint: '克莱因蓝紫指标卡，适合 AI 工具、数码与副业拆解', variant: 'bento',
    bg: '#E2E7F7', sheet: '#FFFFFF', surface: '#F4F6FF', ink: '#161B33', muted: '#505878',
    line: '#D6DDF4', accent: '#4338CA', soft: '#E0E7FF', mark: '#C7D2FE', font: SANS_STACK, headingFont: SANS_STACK
  },
  {
    key: 'mono', label: '黑白画报', hint: '极简黑白社论风 + 绯红角标，买手选品高级感', variant: 'swiss',
    bg: '#E4E4E7', sheet: '#FFFFFF', surface: '#F6F6F7', ink: '#111111', muted: '#52525B',
    line: '#27272A', accent: '#E0313B', soft: '#FFE4E6', mark: '#FECDD3', font: SANS_STACK, headingFont: SANS_STACK
  },
  {
    key: 'dark', label: '暗夜黑金', hint: '深曜石底 + 琥珀金高亮，商业拆解与月度复盘吸睛', variant: 'dark',
    bg: '#0B0E14', sheet: '#131822', surface: '#1B2230', ink: '#F3F4F6', muted: '#9CA3AF',
    line: '#2C364A', accent: '#F59E0B', soft: '#36270E', mark: '#78350F', font: SANS_STACK, headingFont: SANS_STACK
  }
];

export function xhsCardStyle(key: string): XhsCardStyleSpec {
  return XHS_CARD_STYLES.find(item => item.key === key) ?? XHS_CARD_STYLES[0];
}

/** 10 种语义分镜母版：按每页承载的信息关系选用不同模块排布。 */
export const XHS_CARD_LAYOUTS: Array<{ key: XhsCardLayout; label: string; hint: string }> = [
  { key: 'roadmap', label: '总览矩阵', hint: '开篇直接给核心分类结论或路线图，不写空话预告' },
  { key: 'keypoints', label: '结构要点', hint: '每条「小标题结论 + 展开细节/数字 + 角标」双层结构' },
  { key: 'steps', label: '步骤链路', hint: 'STEP 1 → 2 → 3 纵向流程轨，讲清操作入口与顺序' },
  { key: 'compare', label: '正反避坑', hint: '❌ 常见误区/踩坑 vs ✅ 正确做法/标准，反差鲜明' },
  { key: 'bento', label: '2×2 宫格', hint: '四宫格满版磁贴，适合多路径对比、工具/货盘盘点' },
  { key: 'metrics', label: '数据看板', hint: '顶部大号核心门槛/指标块 + 下方细则拆解' },
  { key: 'checklist', label: '自查清单', hint: '☑ 实操核对项 + 判断标准，天然促收藏' },
  { key: 'qa', label: '痛点问答', hint: 'Q 高频疑问/卡点 → A 直接给判断标准与解法' },
  { key: 'quote', label: '金句洞察', hint: '大字核心认知金句 + 2–3 条拆解论据，适合故事与观点页' },
  { key: 'summary', label: '一页速查', hint: '条件 → 动作/方案高密度速查表（适合尾页或单张一图流）' }
];

export function xhsCardLayoutLabel(layout?: string): string {
  return XHS_CARD_LAYOUTS.find(item => item.key === layout)?.label ?? '结构要点';
}

/** 1 张为高密度一图流速查卡；4–9 张为多页干货图组。 */
export const XHS_PAGE_COUNTS = [1, 4, 5, 6, 7, 8, 9];

/** 小红书六条正规变现路径（按手头资源对号入座，杜绝私下导流封号）。 */
export const XHS_MONETIZATION_PATHS: Array<{
  key: XhsMonetizationPathKey;
  label: string;
  fit: string;
  threshold: string;
  starter: string;
  caution: string;
}> = [
  {
    key: 'pugongying', label: '蒲公英内容合作（商单）',
    fit: '能持续产出垂直/专业/高审美内容，暂时没有自有货源',
    threshold: '粉丝 ≥1000、满 18 岁实名、无违规、非企业/机构专业号（pgy.xiaohongshu.com）',
    starter: '低粉期先报众测、探店或官方话题活动拿反馈；满千粉后图文/视频分开填报价并补齐人设标签',
    caution: '合作笔记必须在蒲公英报备；严禁水下私接硬广或挂站外链接'
  },
  {
    key: 'buyer', label: '买手带货（橱窗 / 挂车 / 直播）',
    fit: '有选品审美与判断力、愿意维护货盘，靠信任与复购分佣',
    threshold: '专业号 + 满 18 岁实名可 0 粉开橱窗/笔记挂车；粉丝 ≥1000 解锁全场域直播带货',
    starter: '不出镜/时间碎优先做橱窗+挂车，等评论区有人主动问链接时切入最自然',
    caution: '企业直播禁入教育、医械、口腔、医疗机构、医美、保健品、金融等行业；忌盲目跟风选品伤号'
  },
  {
    key: 'personal_sale', label: '个人售卖（闲置 / 搞副业）',
    fit: '轻量技能服务、手作/闲置、未达开店门槛想先在站内闭环收款',
    threshold: '注册 >30 天、近期无违规、免保证金（搜「个人售卖」或「设置-新功能体验」）',
    starter: '用「搞副业」上架标准化技能/小服务，私信谈妥直接在站内完成支付收款',
    caution: '开放类目比正式店铺少，适合验证首单需求，长期规模化仍需升级店铺'
  },
  {
    key: 'qianfan_shop', label: '千帆开店 + 商品笔记',
    fit: '有自有产品/供应链、具备独立发货与售后履约能力',
    threshold: '入驻 >180 天、笔记 >30 篇、粉丝 >1000、无违规 + 专业号认证（个体店目前需企业蓝V；ark.xiaohongshu.com）',
    starter: '看商机中心「机会类目 / 潜力商品」发商品笔记拿流量激励，群聊右侧挂进店入口',
    caution: '电子资源需近 12 个月单自然月流水 >6000 元证明 + 90 天清单；新办个体户建议满 14 天工商同步后再提审'
  },
  {
    key: 'expert_service', label: '专业咨询与知识服务',
    fit: '咨询、设计、教学、职场、技术、法律等高客单专业能力者',
    threshold: '不依赖大粉量，核心门槛是真实案例储备与站内合规承接（个人售卖副业 / 专业号）',
    starter: '用拆解具体案例与诊断过程的干货立专业信任，有读者提问求购后再顺势承接',
    caution: '纯搬运空洞方法论极易被投诉且不可持续；严禁在正文/评论留微信号导私域'
  },
  {
    key: 'local_lead', label: '同城门店 / 本地获客',
    fit: '有线下门店、工作室或固定城市半径内的同城服务',
    threshold: '专业号认证 + 明确同城地理位置锚点',
    starter: '持续发真实服务过程、前后对比案例与到店探店体验，承接预约到店成交',
    caution: '没有本地履约半径不必硬蹭同城流量'
  }
];

export const XHS_PILLAR_ROLES: Record<XhsPillarRole, { label: string; hint: string }> = {
  traffic: { label: '流量拉新', hint: '抓高频痛点扩曝光，吸引潜在人群进场' },
  trust: { label: '专业立信', hint: '硬核干货教程与案例复盘，促收藏与涨粉' },
  convert: { label: '种草转化', hint: '选品测评、服务拆解或蒲公英样片，激发问链接与求购' }
};

export function xhsMonetizationLabel(key?: string): string {
  return XHS_MONETIZATION_PATHS.find(item => item.key === key)?.label ?? '';
}

export function xhsPillarRoleLabel(role?: string): string {
  return role && role in XHS_PILLAR_ROLES ? XHS_PILLAR_ROLES[role as XhsPillarRole].label : '';
}

/** 账号变现阶段解锁罗盘（对照平台真实硬门槛）。 */
export const XHS_MONETIZATION_MILESTONES: Array<{
  key: string;
  stage: string;
  gate: string;
  unlocks: string;
  minNotes: number;
  minFans: number;
}> = [
  { key: 'm1', stage: '阶段 1 · 冷启动测需求', gate: '注册 >30 天、无违规', unlocks: '开通「个人售卖（搞副业/出闲置）」免保证金站内收款；报名蒲公英众测/探店练手', minNotes: 1, minFans: 0 },
  { key: 'm2', stage: '阶段 2 · 0 粉选品带货', gate: '专业号 + 满 18 岁实名 + 评论区出现问链接', unlocks: '开通「买手橱窗」与「笔记挂车」分佣（无需开播、0 粉可申）', minNotes: 5, minFans: 0 },
  { key: 'm3', stage: '阶段 3 · 千粉商业接单', gate: '粉丝 ≥1000 + 实名无违规', unlocks: '开通「蒲公英博主合作」（图文/视频分开填报价 + 补人设标签）与「买手直播带货」', minNotes: 10, minFans: 1000 },
  { key: 'm4', stage: '阶段 4 · 自营店铺闭环', gate: '入驻 >180 天 + 笔记 >30 篇 + 粉丝 ≥1000 + 企业蓝V', unlocks: '开通「千帆店铺 + 商品笔记」，看商机中心拿潜力商品曝光激励', minNotes: 30, minFans: 1000 }
];

/** 网页版创作者中心的图文发布页：应用只负责打开它，上传、填写、点发布都由你自己在页面里完成。 */
export const XHS_PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish?source=official';

/**
 * 生图的安全区：接口出 2:3 竖图，之后补边成 3:4；模型常把标题顶到画布边上、要点排到最底下被挤掉，
 * 所以明确要求四周留白、所有内容完整地放在画面里。
 */
export const XHS_SAFE_AREA = '构图要完整：标题、文字、主体与所有卡片都完整地放在画面内，离四边至少留出画面宽度 8% 的空白；任何文字不要贴边、不要被画面边缘截断，宁可少写一条也不要挤出画面。';

export const XHS_IMAGE_NEGATIVE_RULES = '严禁出现水印、平台 UI 边框、二维码、真实品牌标识（Logo）、畸形手部或多余肢体、文字贴边截断、背景随机乱码假字、廉价赛博霓虹光污染、夸张失真表情或令人不适的画面。';

export type XhsCoverPresetSpec = {
  key: XhsCoverPresetKey;
  label: string;
  hint: string;
  medium: string;
  composition: string;
  paletteLighting: string;
  typography: string;
};

/** 封面结构化视觉预设：把笼统的“清爽小红书风”拆成明确的媒介、构图留白、光影色板与文字排版规范。 */
export const XHS_COVER_PRESETS: XhsCoverPresetSpec[] = [
  {
    key: 'editorial_photo',
    label: '质感生活实拍',
    hint: '自然窗光实景摄影 + 上方干净留白压标题，真实种草感强',
    medium: '高质感生活方式编辑摄影（35mm/50mm 定焦浅景深，真实自然肌理，杜绝塑料感 AI 磨皮）',
    composition: '三分法或桌面俯拍/平视近景，核心器物或人物动作置于中下视觉焦点，画面上半部预留 30%–35% 干净低纹理留白区承载标题',
    paletteLighting: '柔和晴天侧逆窗光或温暖室内漫射光，主色调克制在 2–3 个低饱和协调色系内，阴影干净通透',
    typography: '上半部醒目现代粗黑体主标题 + 胶囊小标签分层排布，与背景形成高明度反差'
  },
  {
    key: 'magazine_poster',
    label: '高定杂志海报',
    hint: '瑞士编辑平面排版 + 强视觉主体居中，适合干货盘点与认知复盘',
    medium: '现代商业杂志封面级平面视觉设计，干净纸张肌理结合单一高精度静物或几何构成',
    composition: '严谨网格对称或左对齐编辑构图，顶部大字号标题统治视觉第一层级，下方主体利落独立、四周留白充裕',
    paletteLighting: '米白/暖灰高级纸感底色 + 深炭黑主字 + 单一高饱和强调色（朱红/克莱因蓝/焦糖橙），均匀无杂乱投影',
    typography: '超大字重无衬线主标题配细线分割或色块高亮条，层级极度清晰，缩略图一眼识别'
  },
  {
    key: 'handdrawn_board',
    label: '温暖手绘白板',
    hint: '粗马克笔白板手绘生活漫画 + 重点色圈画，亲切好懂适合科普教程',
    medium: '手绘白板图解插画（粗黑/深灰马克笔手绘轮廓，温暖极简生活漫画质感，2D 平面高对比）',
    composition: '暖白白板底（#FFFDF9），画面中下部画与主题直接相关的具体人物日常动作或步骤对比，上方留足 35% 干净标题区',
    paletteLighting: '光线均匀明亮无暗角；除黑白灰轮廓外重点色不超过 2 种（暖阳橙 #E67E22、健康绿 #27AE60）',
    typography: '醒目手写感粗黑标题配荧光笔下划线强调，字大清晰、零拥挤'
  },
  {
    key: 'studio_3d',
    label: '轻拟物 3D 静物',
    hint: '磨砂亚克力/柔和黏土微缩桌面道具，适合效率工具、数码与副业工作流',
    medium: '高品质现代工业风 3D 轻拟物静物渲染（柔和哑光黏土与磨砂半透明材质结合，边缘精致圆润）',
    composition: '45 度微距等轴或正面悬浮构图，1 个核心主题微缩模型居中偏下，周围点缀 1–2 个轻量关联小图标道具',
    paletteLighting: '柔和全局光照（Global Illumination）棚拍漫射光，浅灰蓝或奶油白纯净渐变背景，色调轻盈现代',
    typography: '顶部居中或左对齐圆润粗体大标题，搭配精致圆角副标题胶囊'
  },
  {
    key: 'minimal_flat',
    label: '人文纸感插画',
    hint: '柔和扁平肌理插画 + 燕麦暖底，适合故事复盘、阅读与身心疗愈',
    medium: '当代编辑风肌理扁平插画（带有微妙版画颗粒与温暖纸张触感，线条舒展克制）',
    composition: '大面积留白呼吸感构图，人物或生活角落置于一侧，与文字区形成平衡对话关系',
    paletteLighting: '燕麦米、鼠尾草绿、暖陶土棕等柔和自然大地色系，午后温暖柔光氛围',
    typography: '温润人文衬线或中粗黑体主标题，字距舒展清晰'
  },
  {
    key: 'desk_flatlay',
    label: '桌面俯拍合集',
    hint: '整齐陈列好物/工具俯拍 + 序号角标，合集清单与测评爆款',
    medium: '高清晰度工作室俯拍静物摄影（Flat-lay 垂直 90 度俯拍，真实材质细节，干净无杂物）',
    composition: '画面中下部按网格整齐排列 3–5 件主题相关实物道具，上方预留 32% 纯净背景区承载大字标题',
    paletteLighting: '均匀柔和顶光配浅暖木桌面或米灰亚麻底布，色彩统一在暖米、原木与单一强调色内',
    typography: '上方醒目粗黑主标题配数字胶囊，器物旁点缀干净简洁的序号小贴纸（①②③）'
  },
  {
    key: 'bold_collage',
    label: '波普拼贴画报',
    hint: '高反差剪纸色块拼贴 + 粗黑标题条，避坑拔草与观点类超吸睛',
    medium: '现代潮流杂志纸艺拼贴设计（高清实物抠图结合撕纸边缘肌理与几何色块构成）',
    composition: '中心偏下放置高辨识度主题主体，上方醒目横幅色块承载双行大字主标题，视觉重心集中',
    paletteLighting: '暖白纸感底配深炭黑、明黄或朱砂红高对比强调色块，边缘利落无脏污阴影',
    typography: '高反差黑底黄字或白底粗黑框大标题，缩略图一秒抓眼球'
  }
];

export function xhsCoverPreset(key?: string): XhsCoverPresetSpec {
  return XHS_COVER_PRESETS.find(item => item.key === key) ?? XHS_COVER_PRESETS[0];
}

export type XhsInfoPresetSpec = {
  key: XhsInfoPresetKey;
  label: string;
  hint: string;
  layoutSpec: string;
  palette: string;
  iconography: string;
};

/** 生图信息图的结构化视觉预设（不再只有单一紫蓝风格）。 */
export const XHS_INFO_PRESETS: XhsInfoPresetSpec[] = [
  {
    key: 'light_bento',
    label: '轻盈科技 Bento',
    hint: '白底 + 紫蓝主色与青柠绿点缀 + 圆角卡片分区（经典信息图）',
    layoutSpec: '现代 Bento 模块化圆角卡片网格分区，顶部标题栏 + 中部等距信息卡 + 底部重点提示条，留白充足',
    palette: '纯净白底（#FFFFFF）配浅灰蓝卡片底，紫蓝色（#5B5BF0）为主色、青柠绿做重点高亮',
    iconography: '极简线性矢量小图标配合清晰数字序号徽章'
  },
  {
    key: 'swiss_chart',
    label: '苏黎世杂志网格',
    hint: '米白纸底 + 炭黑细线分栏 + 朱红角标，高密度商业杂志知识感',
    layoutSpec: '瑞士国际主义平面网格排版，用 1.5px 实线边框严格划分标题区与要点模块，对齐精准',
    palette: '暖米白纸底（#FAF8F4），深炭黑文字与分割线，朱砂红（#D93829）与暖黄荧光笔做视觉锚点',
    iconography: '几何编号角标（01 / 02 / 03）、对比箭头与结构化标签胶囊'
  },
  {
    key: 'marker_sketchnote',
    label: '马克笔视觉笔记',
    hint: '暖白纸底 + 手绘方框箭头 + 荧光笔圈重点，真人学霸手账感',
    layoutSpec: '清晰结构化视觉笔记（Sketchnote）分区，手绘圆角方框串联各要点，逻辑箭头引导视线',
    palette: '暖白纸张底（#FFFDF9），深灰黑马克笔字迹，柠檬黄与薄荷绿荧光笔涂抹重点词',
    iconography: '简洁手绘小图标（灯泡、对勾、警示三角、星标）点缀条目旁'
  },
  {
    key: 'warm_guide',
    label: '暖调生活图鉴',
    hint: '燕麦暖底 + 森绿与焦糖棕卡片，温和耐看适合健康/居家/清单',
    layoutSpec: '柔和圆角分栏知识图鉴，大字号小标题配合清爽图文行，阅读毫无压迫感',
    palette: '燕麦米暖底（#F8F3E8），深棕墨色正文，森林绿（#2A6F57）与暖橙做分类强调',
    iconography: '温和扁平生活小插画图标与圆润数字标号'
  },
  {
    key: 'dark_dashboard',
    label: '暗夜黑金看板',
    hint: '深曜石底 + 暗色微光卡片 + 琥珀金指标，适合数据拆解与搞钱复盘',
    layoutSpec: '高对比暗色数据仪表盘卡片布局，细微亮边分割各模块，重点数字放大突出',
    palette: '深石墨黑底（#12161F）配暗蓝灰卡片（#1B212E），纯白正文，琥珀金（#F59E0B）与翠绿高亮',
    iconography: '发光质感线性指标图标、进度条与胶囊徽章'
  },
  {
    key: 'versus_board',
    label: '红黑正反对比榜',
    hint: '左右或上下分栏 ❌ 踩坑误区 vs ✅ 正确做法，避坑与测评极高收藏',
    layoutSpec: '鲜明正反双栏对照信息图，上方大标题点明核心判断，下方红绿双色模块逐条对照错误做法与正确方案',
    palette: '干净暖白底（#FAF9F6），误区栏浅玫红底配深红标签，正解栏浅薄荷绿底配深森绿标签，炭黑正文',
    iconography: '醒目叉号与对勾徽章、对比箭头及结论高亮条'
  },
  {
    key: 'step_roadmap',
    label: '实操路径流程图',
    hint: 'STEP 01 → 02 → 03 节点闯关式路线图，手把手教程一眼看懂',
    layoutSpec: '纵向 S 型或阶梯式步骤流程图解，每个节点带清晰编号胶囊、关键动作卡片与避坑小贴士，底部附总结框',
    palette: '清爽米灰底（#F5F7FA）配纯白步骤卡，克莱因蓝（#2563EB）与暖阳橙（#F59E0B）做节点主次强调',
    iconography: '编号步骤徽章、串联引导箭头与极简线性操作图标'
  }
];

export function xhsInfoPreset(key?: string): XhsInfoPresetSpec {
  return XHS_INFO_PRESETS.find(item => item.key === key) ?? XHS_INFO_PRESETS[0];
}

/** 封面的通用画风兜底常量（保持导出兼容）。 */
export const XHS_COVER_STYLE = [
  '画风：小红书常见的清爽质感，主体突出、构图干净、色彩协调，避免拥挤和强刺激色彩。',
  '画面里的中文标题要写对、写清楚、字号够大；不要水印或 logo，不要真实品牌标识，不要夸张或令人不适的画面。',
  XHS_SAFE_AREA
].join('\n');

/** 生图信息图的默认风格兜底常量（保持导出兼容）。 */
export const XHS_INFO_IMAGE_STYLE = [
  '小红书竖版信息图，竖构图。',
  '风格：白底，紫蓝色为主色、青柠绿做点缀强调，圆角卡片分区，线性图标，留白充足，信息层级清楚。',
  '画面里的中文标题与要点要写对、写清楚、字号够大；一张图只讲一个主题，不要堆砌；不要水印或 logo，不要真实品牌标识。',
  XHS_SAFE_AREA
].join('\n');

export const XHS_TAB_LABELS: Record<XhsTab, string> = {
  home: '向导', positioning: '账号定位', hotspot: '热点选题', notes: '笔记创作', audit: '账号诊断', analytics: '笔记复盘', browser: '小红书窗口'
};
