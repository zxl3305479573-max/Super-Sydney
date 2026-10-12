/**
 * 配图风格模板：封面与正文配图提示词里"画风 + 禁忌"那部分。
 *
 * 提示词的其余部分（用途、内容方向、文章主题、配合的段落）由程序拼，保证图和文章对得上；
 * 风格部分交给用户在「内容方向」里按方向维护——健康科普要温暖写实、不出现医疗符号，
 * 科技方向可能要扁平插画、避免品牌 logo，这些不该写死在代码里。
 * 渲染层也引用这里的默认模板做输入框占位，所以保持纯函数、无 Node 依赖。
 */

/** 不分领域的通用默认：新建的公众号资料没写模板时用它。 */
export const DEFAULT_IMAGE_STYLE = [
  '面向{读者}：写实、自然光、画面干净、主体明确，避免拥挤和强刺激色彩。',
  '画面里不要出现任何文字、字母、数字、水印或 logo；不要夸张，不要令人不适的画面。'
].join('\n');

/**
 * 旧版内置默认，是按最初那份健康科普资料写的（含医疗相关禁忌）。
 * 升级到按资料隔离时写进那份资料自己的配图模板，保持它的出图效果不变，又不会传染给新资料。
 */
export const LEGACY_IMAGE_STYLE = [
  '面向{读者}：温暖写实、自然光、画面干净、主体明确，避免拥挤和强刺激色彩。',
  '画面里不要出现任何文字、字母、数字、水印、logo、器械或医疗符号；不要夸张，不要令人不适的画面，不要用画面暗示任何效果承诺。'
].join('\n');

/** 具体方向的模板优先，留空沿用方向的，方向也留空用内置默认。 */
export function resolveImageStyle(direction: { imagePrompt?: string } | null | undefined, subdirection?: { imagePrompt?: string } | null): string {
  return subdirection?.imagePrompt?.trim() || direction?.imagePrompt?.trim() || DEFAULT_IMAGE_STYLE;
}

/**
 * 填入占位符。目前只有 {读者}：账号没配读者定位时，"面向{读者}："整段去掉，
 * 其余位置退化成"读者"，避免提示词里残留花括号。
 */
export function renderImageStyle(template: string, audience: string): string {
  const who = audience.trim();
  const text = who ? template : template.replace(/面向\{读者\}[：:，,]\s*/g, '');
  return text.replace(/\{读者\}/g, who || '读者').trim();
}

/**
 * 可一键套用的配图风格预设。套用只是把文字填进模板输入框，用户可以继续改，保存后才生效。
 * 每个预设都保留「不要出现任何文字」这一行：生图模型画字会出错，这条与风格无关。
 */
export const IMAGE_STYLE_PRESETS: Array<{ key: string; label: string; hint: string; template: string }> = [
  {
    key: 'whiteboard',
    label: '手绘白板（适老）',
    hint: '马克笔手绘白板图解：暖白底、粗线条、少颜色、具体的人和日常动作、大留白，适合中老年科普',
    template: [
      '面向{读者}：手绘白板图解，像用粗马克笔在白板上画的生活小漫画（clear whiteboard hand-drawn illustration, thick marker doodle style, warm minimalism, rough sketchy lines, cheerful and trustworthy atmosphere）。',
      '背景用暖白纸张质感或微米黄白板底（#FFFDF9），光线柔和均匀；不要纯黑背景、霓虹夜景或复杂纹理。',
      '粗黑或深灰马克笔轮廓；除黑白灰外重点色不超过 2 种，从暖阳光橙（#E67E22）、柔和健康绿（#27AE60）、警示正红（#E74C3C）里选。',
      '画与这段内容直接相关的具体现实人物（例如提菜篮的阿姨、戴老花镜的长辈），表情直观（微笑点头、疑惑挠头、坚决摆手），动作和吃饭、吃药、揉膝盖、看水壶这类日常动作绑定。',
      '2D 平面、高对比、一眼看懂，一张图只讲一件事；在上方或右侧留出至少 35% 的干净留白，不要拥挤。',
      '画面里不要出现任何文字、字母、数字、水印或 logo；不要英文艺术字、复杂折线图、抽象齿轮或雷达图。'
    ].join('\n')
  },
  {
    key: 'default',
    label: '通用写实',
    hint: '内置默认：写实、自然光、画面干净',
    template: DEFAULT_IMAGE_STYLE
  }
];
