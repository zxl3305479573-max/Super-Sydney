/**
 * Markdown → 微信兼容 HTML。
 *
 * 两个硬约束：
 * 1. 微信编辑器会剥离 <style>，所有样式必须内联。
 * 2. 正文来自模型/用户输入，必须先转义，再叠加我们自己的标签，避免注入。
 *
 * 排版按主题渲染：默认 elder-clear（18px 正文、高行高、近黑文字、少装饰），
 * 其余主题只换样式令牌，不改解析逻辑。
 */

export type ArticleThemeName = 'elder-clear' | 'clean' | 'classic' | 'magazine' | 'warm';

export type ArticleTheme = {
  name: ArticleThemeName;
  label: string;
  description: string;
  wrap: string;
  body: string;
  h1: string;
  h2: string;
  h3: string;
  list: string;
  quote: string;
  quoteBox: string;
  strong: string;
  code: string;
  hr: string;
  image: string;
  caption: string;
  footer: string;
};

/**
 * 内置排版主题。
 *
 * 都遵守同一条底线：正文不小 16px、行高不低于 1.7、正文接近纯黑，
 * 面向中老年读者时不牺牲可读性去换装饰。
 */
export const ARTICLE_THEMES: ArticleTheme[] = [
  {
    name: 'elder-clear',
    label: '中老年友好',
    description: '18px 正文、高行高、高对比，少装饰（默认）',
    wrap: 'font-size:18px;line-height:1.9;color:#1a1a1a;',
    body: 'font-size:18px;line-height:1.9;color:#1a1a1a;margin:0 0 16px 0;',
    h1: 'font-size:26px;line-height:1.45;font-weight:700;color:#1a1a1a;margin:28px 0 18px 0;padding:0 0 12px 0;border-bottom:3px solid #0f6b52;',
    h2: 'font-size:22px;line-height:1.5;font-weight:700;color:#0f6b52;margin:30px 0 14px 0;padding:6px 0 6px 12px;border-left:5px solid #0f6b52;',
    h3: 'font-size:19px;line-height:1.5;font-weight:700;color:#1a1a1a;margin:24px 0 10px 0;',
    list: 'font-size:18px;line-height:1.9;color:#1a1a1a;margin:0 0 8px 0;',
    quote: 'font-size:17px;line-height:1.85;color:#1a1a1a;margin:0;',
    quoteBox: 'border-left:5px solid #0f6b52;background:#f2f7f5;margin:0 0 16px 0;padding:12px 16px;',
    strong: 'font-weight:700;color:#0f6b52;',
    code: 'font-size:16px;background:#f2f7f5;color:#0f6b52;padding:2px 5px;border-radius:4px;',
    hr: 'border:none;border-top:2px solid #e2e2e2;margin:26px 0;',
    image: 'margin:0 0 8px 0;text-align:center;',
    caption: 'font-size:14px;line-height:1.7;color:#7a7a7a;text-align:center;margin:0 0 20px 0;',
    footer: 'font-size:13px;line-height:1.7;color:#7a7a7a;margin:26px 0 0 0;padding-top:12px;border-top:1px solid #e2e2e2;'
  },
  {
    name: 'clean',
    label: '简洁资讯',
    description: '17px 正文、蓝色点睛、标题下划线，适合知识科普',
    wrap: 'font-size:17px;line-height:1.85;color:#222222;',
    body: 'font-size:17px;line-height:1.85;color:#222222;margin:0 0 16px 0;',
    h1: 'font-size:25px;line-height:1.45;font-weight:700;color:#222222;margin:28px 0 18px 0;padding:0 0 10px 0;border-bottom:2px solid #1f6feb;',
    h2: 'font-size:21px;line-height:1.5;font-weight:700;color:#1f6feb;margin:30px 0 14px 0;',
    h3: 'font-size:18px;line-height:1.5;font-weight:700;color:#222222;margin:24px 0 10px 0;',
    list: 'font-size:17px;line-height:1.85;color:#222222;margin:0 0 8px 0;',
    quote: 'font-size:16px;line-height:1.8;color:#333333;margin:0;',
    quoteBox: 'border-left:3px solid #1f6feb;background:#f4f8ff;margin:0 0 16px 0;padding:12px 16px;',
    strong: 'font-weight:700;color:#1f6feb;',
    code: 'font-size:15px;background:#f2f5fa;color:#1f6feb;padding:2px 5px;border-radius:4px;',
    hr: 'border:none;border-top:1px solid #dfe4ec;margin:24px 0;',
    image: 'margin:0 0 8px 0;text-align:center;',
    caption: 'font-size:13px;line-height:1.7;color:#8a8f98;text-align:center;margin:0 0 20px 0;',
    footer: 'font-size:13px;line-height:1.7;color:#8a8f98;margin:24px 0 0 0;padding-top:12px;border-top:1px solid #dfe4ec;'
  },
  {
    name: 'classic',
    label: '书卷',
    description: '17px 正文、衬线字体、居中标题，适合人文与叙事',
    wrap: 'font-size:17px;line-height:1.9;color:#2b2118;font-family:Georgia,"Songti SC","Noto Serif SC",serif;',
    body: 'font-size:17px;line-height:1.9;color:#2b2118;margin:0 0 16px 0;',
    h1: 'font-size:25px;line-height:1.5;font-weight:700;color:#2b2118;text-align:center;margin:28px 0 20px 0;',
    h2: 'font-size:21px;line-height:1.5;font-weight:700;color:#8c5a2b;margin:30px 0 14px 0;',
    h3: 'font-size:18px;line-height:1.5;font-weight:700;color:#2b2118;margin:22px 0 10px 0;',
    list: 'font-size:17px;line-height:1.9;color:#2b2118;margin:0 0 8px 0;',
    quote: 'font-size:16px;line-height:1.85;color:#4a3a2a;margin:0;',
    quoteBox: 'border-top:1px solid #e0d5c6;border-bottom:1px solid #e0d5c6;background:#faf6f0;margin:0 0 18px 0;padding:14px 16px;',
    strong: 'font-weight:700;color:#8c5a2b;',
    code: 'font-size:15px;background:#f6efe6;color:#8c5a2b;padding:2px 5px;border-radius:3px;',
    hr: 'border:none;border-top:1px solid #e0d5c6;margin:26px 0;',
    image: 'margin:0 0 8px 0;text-align:center;',
    caption: 'font-size:13px;line-height:1.7;color:#8d7c69;text-align:center;margin:0 0 20px 0;',
    footer: 'font-size:13px;line-height:1.7;color:#8d7c69;margin:26px 0 0 0;padding-top:12px;border-top:1px solid #e0d5c6;'
  },
  {
    name: 'magazine',
    label: '杂志',
    description: '17px 正文、色块小标题、强对比重点，适合观点与盘点',
    wrap: 'font-size:17px;line-height:1.8;color:#141414;',
    body: 'font-size:17px;line-height:1.8;color:#141414;margin:0 0 16px 0;',
    h1: 'font-size:27px;line-height:1.4;font-weight:800;color:#141414;margin:26px 0 18px 0;letter-spacing:-0.5px;',
    h2: 'font-size:20px;line-height:1.5;font-weight:700;color:#ffffff;background:#141414;display:inline-block;margin:30px 0 14px 0;padding:6px 12px;',
    h3: 'font-size:18px;line-height:1.5;font-weight:700;color:#d94f2b;margin:22px 0 10px 0;',
    list: 'font-size:17px;line-height:1.8;color:#141414;margin:0 0 8px 0;',
    quote: 'font-size:17px;line-height:1.8;color:#141414;margin:0;',
    quoteBox: 'border-left:6px solid #d94f2b;background:#fdf3f0;margin:0 0 18px 0;padding:14px 16px;',
    strong: 'font-weight:800;color:#d94f2b;',
    code: 'font-size:15px;background:#f2f2f2;color:#141414;padding:2px 5px;border-radius:3px;',
    hr: 'border:none;border-top:3px solid #141414;margin:26px 0;',
    image: 'margin:0 0 8px 0;text-align:center;',
    caption: 'font-size:13px;line-height:1.7;color:#8c8c8c;text-align:center;margin:0 0 20px 0;',
    footer: 'font-size:13px;line-height:1.7;color:#8c8c8c;margin:26px 0 0 0;padding-top:12px;border-top:2px solid #141414;'
  },
  {
    name: 'warm',
    label: '温暖亲和',
    description: '18px 正文、暖橙配色、圆角引用，适合生活与情感话题',
    wrap: 'font-size:18px;line-height:1.9;color:#2f2a26;',
    body: 'font-size:18px;line-height:1.9;color:#2f2a26;margin:0 0 16px 0;',
    h1: 'font-size:25px;line-height:1.45;font-weight:700;color:#2f2a26;margin:28px 0 18px 0;',
    h2: 'font-size:21px;line-height:1.5;font-weight:700;color:#c85f2a;margin:30px 0 14px 0;padding:0 0 8px 0;border-bottom:2px dashed #f0d5c4;',
    h3: 'font-size:19px;line-height:1.5;font-weight:700;color:#2f2a26;margin:24px 0 10px 0;',
    list: 'font-size:18px;line-height:1.9;color:#2f2a26;margin:0 0 8px 0;',
    quote: 'font-size:17px;line-height:1.85;color:#5a4a40;margin:0;',
    quoteBox: 'border-radius:12px;background:#fdf1e8;margin:0 0 18px 0;padding:14px 16px;',
    strong: 'font-weight:700;color:#c85f2a;',
    code: 'font-size:16px;background:#fdf1e8;color:#c85f2a;padding:2px 6px;border-radius:6px;',
    hr: 'border:none;border-top:2px dashed #f0d5c4;margin:26px 0;',
    image: 'margin:0 0 8px 0;text-align:center;',
    caption: 'font-size:14px;line-height:1.7;color:#9a8578;text-align:center;margin:0 0 20px 0;',
    footer: 'font-size:13px;line-height:1.7;color:#9a8578;margin:26px 0 0 0;padding-top:12px;border-top:1px solid #f0d5c4;'
  }
];

export const DEFAULT_ARTICLE_THEME: ArticleThemeName = 'elder-clear';

export function getArticleTheme(name?: string): ArticleTheme {
  return ARTICLE_THEMES.find(theme => theme.name === name)
    ?? ARTICLE_THEMES.find(theme => theme.name === DEFAULT_ARTICLE_THEME)!;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}

/** 在已转义的文本上叠加行内标记。 */
function inline(escaped: string, theme: ArticleTheme): string {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, (_match, text: string) => `<strong style="${theme.strong}">${text}</strong>`)
    .replace(/`([^`]+)`/g, (_match, text: string) => `<code style="${theme.code}">${text}</code>`);
}

/** 去掉 Markdown 标记，得到纯文本（用于摘要）。 */
export function toPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}\d+[.)]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 微信摘要按 UTF-8 字节限制，按字符累加避免截断多字节字符。 */
export function makeDigest(markdown: string, maxBytes = 120): string {
  const plain = toPlainText(markdown);
  let out = '';
  let bytes = 0;
  for (const char of plain) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out.trim();
}

/** 微信标题上限按字符计。 */
export function normalizeTitle(value: string, maxChars = 64): string {
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length > maxChars ? single.slice(0, maxChars) : single;
}

export type RenderOptions = {
  theme?: string;
  aigcFooter?: string;
  /** 把 Markdown 里的图片地址换成可嵌入的地址（本地文件转 data URI、或微信上传后的 URL）。 */
  resolveImage?: (source: string) => string;
};

export function renderWeChatHtml(markdown: string, options: RenderOptions = {}): string {
  const theme = getArticleTheme(options.theme);
  const blocks: string[] = [];
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];
  let listType: 'ul' | 'ol' | null = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p style="${theme.body}">${inline(escapeHtml(paragraph.join('\n')), theme).replace(/\n/g, '<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!listType) return;
    blocks.push(`</${listType}>`);
    listType = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushParagraph(); flushList(); continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph(); flushList();
      const level = Math.min(heading[1].length, 3);
      const style = level === 1 ? theme.h1 : level === 2 ? theme.h2 : theme.h3;
      blocks.push(`<h${level} style="${style}">${inline(escapeHtml(heading[2].trim()), theme)}</h${level}>`);
      continue;
    }
    // 只认 Markdown 图片语法；原始 <img> 仍走转义分支，避免注入。
    const image = line.match(/^!\[([^\]]*)\]\(\s*(?:<([^>]*)>|([^)]*))\s*\)\s*$/);
    if (image) {
      flushParagraph(); flushList();
      const caption = image[1].trim();
      const source = (image[2] ?? image[3] ?? '').trim();
      const resolved = source ? options.resolveImage?.(source) ?? source : '';
      if (resolved) {
        blocks.push(`<p style="${theme.image}"><img src="${escapeHtml(resolved)}" alt="${escapeHtml(caption)}" style="max-width:100%;height:auto;display:block;margin:0 auto;border-radius:6px;"></p>`);
        if (caption) blocks.push(`<p style="${theme.caption}">${escapeHtml(caption)}</p>`);
      }
      continue;
    }
    if (/^\s{0,3}([-*_])\s*\1\s*\1\s*$/.test(line)) {
      flushParagraph(); flushList();
      blocks.push(`<hr style="${theme.hr}">`);
      continue;
    }
    const unordered = line.match(/^\s{0,3}[-*+]\s+(.*)$/);
    const ordered = line.match(/^\s{0,3}\d+[.)]\s+(.*)$/);
    if (unordered || ordered) {
      flushParagraph();
      const wanted = unordered ? 'ul' : 'ol';
      if (listType !== wanted) { flushList(); blocks.push(`<${wanted} style="padding-left:24px;margin:0 0 16px 0;">`); listType = wanted; }
      blocks.push(`<li style="${theme.list}">${inline(escapeHtml((unordered ?? ordered)![1]), theme)}</li>`);
      continue;
    }
    const quote = line.match(/^\s{0,3}>\s?(.*)$/);
    if (quote) {
      flushParagraph(); flushList();
      blocks.push(`<blockquote style="${theme.quoteBox}"><p style="${theme.quote}">${inline(escapeHtml(quote[1]), theme)}</p></blockquote>`);
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  flushList();

  const footer = options.aigcFooter
    ? `<p style="${theme.footer}">${escapeHtml(options.aigcFooter)}</p>`
    : '';
  return `<section style="${theme.wrap}">${blocks.join('')}${footer}</section>`;
}

export const DEFAULT_AIGC_FOOTER = '本文为健康科普，不能替代医生的诊断和处方；内容含 AI 辅助生成，请人工核对。';
