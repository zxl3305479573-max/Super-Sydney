/**
 * 从 CHANGELOG.md 提取指定版本的发布说明；缺失时回退到 Git 附注标签正文或提交摘要，
 * 避免 GitHub Actions 在无 PR 仓库中使用 `--generate-notes` 只生成一行 `Full Changelog` 链接。
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

  const subjects = (options.commitSubjects ?? [])
    .map(subject => subject.trim())
    .filter(Boolean)
    .filter(subject => !/^chore(?:\([^)]*\))?:\s*bump[-\s]+version/i.test(subject));
  if (subjects.length > 0) {
    return [
      `### Sydney v${cleanVersion} 更新内容`,
      '',
      ...subjects.map(item => `- ${item}`)
    ].join('\n');
  }

  return `### Sydney v${cleanVersion} 更新内容\n\n- 常规体验优化与问题修复`;
}
