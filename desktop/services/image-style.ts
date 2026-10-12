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
