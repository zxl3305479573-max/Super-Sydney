/**
 * 从 CHANGELOG.md 提取指定版本的发布说明，并支持转换为无尖括号纯文本注入 latest.yml。
 *
 * 关键机制：electron-updater 的 GitHubProvider 先解析 latest.yml；只有当 latest.yml 没有
 * releaseNotes 字段时才会去读 GitHub releases.atom（返回带 <h3><ul><li><code> 的 HTML）。
 * 将分类好的纯文本直接写入 latest.yml，既能让旧版客户端也不显示任何 `<>` 标签，又能与新版结构化弹窗配合。
 */
export function extractChangelogSection(changelog: string, version: string): string {
  const cleanVersion = version.trim().replace(/^v/i, '');
  if (!cleanVersion) return '';
  const escaped = cleanVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = changelog.replace(/\r\n?/g, '\n').split('\n');
  const headerPattern = new RegExp(`^##\\s+\\[?v?${escaped}\\]?(?:\\s+-\\s+.*|\\s*\\(.*\\))?\\s*$`, 'i');

  let start = -1;
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (start === -1) {
      if (headerPattern.test(line)) start = index + 1;
    } else if (/^##\s+/.test(line)) {
      end = index;
      break;
    }
  }
  if (start === -1) return '';
  return lines.slice(start, end).join('\n').trim();
}

export function categorizeCommits(subjects: string[]): string {
  const added: string[] = [];
  const improved: string[] = [];
  const fixed: string[] = [];

  for (const raw of subjects) {
    const line = raw.replace(/[<>]/g, '').trim();
    if (!line || /^chore(?:\([^)]*\))?:\s*bump[-\s]+version/i.test(line)) continue;
    if (/^(fix|修复)/i.test(line) || /修复/.test(line)) {
      fixed.push(line);
    } else if (/^(feat|新增|添加|支持)/i.test(line) || /新增/.test(line)) {
      added.push(line);
    } else {
      improved.push(line);
    }
  }

  const sections: string[] = [];
  if (added.length) sections.push(`### 新增功能\n${added.map(item => `- ${item}`).join('\n')}`);
  if (improved.length) sections.push(`### 优化内容\n${improved.map(item => `- ${item}`).join('\n')}`);
  if (fixed.length) sections.push(`### 修复 Bug\n${fixed.map(item => `- ${item}`).join('\n')}`);
  return sections.join('\n\n');
}

export function buildReleaseNotes(options: {
  version: string;
  changelog?: string;
  tagMessage?: string;
  commitSubjects?: string[];
}): string {
  const cleanVersion = options.version.trim().replace(/^v/i, '');
  const fromChangelog = extractChangelogSection(options.changelog ?? '', cleanVersion);
  if (fromChangelog) return fromChangelog;

  const tagBody = (options.tagMessage ?? '').replace(/\r\n?/g, '\n').trim();
  const nonTitleTagLines = tagBody
    .split('\n')
    .map(line => line.trimEnd())
    .filter((line, idx) => !(idx === 0 && new RegExp(`^sydney\\s+v?${cleanVersion.replace(/\./g, '\\.')}$`, 'i').test(line.trim())));
  const meaningfulTag = nonTitleTagLines.join('\n').trim();
  if (meaningfulTag) return meaningfulTag;

  const grouped = categorizeCommits(options.commitSubjects ?? []);
  if (grouped) return grouped;

  return '### 优化内容\n- 常规体验优化与稳定性提升';
}

/**
 * 将 Markdown 发布说明转换为适合写入 `latest.yml` 及弹窗展示的零 `<>` 纯文本：
 * `### 新增功能` -> `【新增功能】`
 * `- 条目` -> `• 条目`
 * 彻底移除 HTML 标签、Markdown 反引号/粗体符号及任何残留 `<` / `>` 字符。
 */
export function markdownNotesToPlainText(markdown: string): string {
  const lines = markdown
    .replace(/\r\n?/g, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n');

  const out: string[] = [];
  for (const raw of lines) {
    let line = raw.trim();
    if (!line) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      continue;
    }
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      const title = headingMatch[1]
        .replace(/[`*_~]/g, '')
        .replace(/[<>]/g, '')
        .replace(/^【|】$/g, '')
        .trim();
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      out.push(`【${title}】`);
      continue;
    }
    const bulletMatch = line.match(/^(?:[-*•]|\d+\.)\s+(.+)$/);
    if (bulletMatch) {
      line = `• ${bulletMatch[1].trim()}`;
    }
    const cleaned = line
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/[<>]/g, '')
      .trim();
    if (cleaned) out.push(cleaned);
  }

  while (out[0] === '') out.shift();
  while (out[out.length - 1] === '') out.pop();
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * 将纯文本更新说明以 YAML 多行字面量（`releaseNotes: |-`）写入 `latest.yml`，
 * 使得旧版与新版客户端都直接从 `latest.yml` 读取分类纯文本，不再回退读取带 HTML 标签的 Atom Feed。
 */
export function injectReleaseNotesIntoLatestYml(ymlContent: string, plainNotes: string): string {
  const sanitizedNotes = plainNotes.replace(/\r\n?/g, '\n').replace(/[<>]/g, '').trim();
  // 移除已有的 releaseNotes 块（幂等）
  const lines = ymlContent.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  let skippingBlock = false;
  for (const line of lines) {
    if (/^releaseNotes\s*:/.test(line)) {
      skippingBlock = true;
      continue;
    }
    if (skippingBlock) {
      if (line.startsWith('  ') || line.trim() === '') continue;
      skippingBlock = false;
    }
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();

  if (!sanitizedNotes) return `${kept.join('\n')}\n`;

  const indented = sanitizedNotes
    .split('\n')
    .map(line => (line ? `  ${line}` : ''))
    .join('\n');
  return `${kept.join('\n')}\nreleaseNotes: |-\n${indented}\n`;
}
