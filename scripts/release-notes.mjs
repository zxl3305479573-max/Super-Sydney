import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  buildReleaseNotes,
  injectReleaseNotesIntoLatestYml,
  markdownNotesToPlainText
} from '../desktop/services/release-notes.ts';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let versionArg = '';
let outFile = '';
let injectYmlFile = '';

for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--out' && args[i + 1]) {
    outFile = args[i + 1];
    i += 1;
  } else if (args[i] === '--inject-yml' && args[i + 1]) {
    injectYmlFile = args[i + 1];
    i += 1;
  } else if (!versionArg && !args[i].startsWith('--')) {
    versionArg = args[i];
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = (versionArg || pkg.version || '').trim().replace(/^v/i, '');
if (!version) {
  throw new Error('缺少版本号参数');
}

const changelogPath = path.join(root, 'CHANGELOG.md');
const changelog = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';

function tryGit(gitArgs) {
  try {
    return execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const tagName = `v${version}`;
const tagMessage = tryGit(['tag', '-l', '--format=%(contents)', tagName]);
const tags = tryGit(['tag', '--sort=-v:refname'])
  .split(/\r?\n/)
  .map(t => t.trim())
  .filter(t => /^v\d+\.\d+\.\d+/.test(t));
const currentIdx = tags.indexOf(tagName);
const prevTag = currentIdx >= 0 ? tags[currentIdx + 1] : tags[0];
const logRange = prevTag ? `${prevTag}..${tagName}` : tagName;
const rawLog = tryGit(['log', '--no-merges', '--format=%s', logRange]) || tryGit(['log', '-n', '10', '--no-merges', '--format=%s']);
const commitSubjects = rawLog ? rawLog.split(/\r?\n/).filter(Boolean) : [];

const markdownNotes = buildReleaseNotes({ version, changelog, tagMessage, commitSubjects });
const plainNotes = markdownNotesToPlainText(markdownNotes);

if (/[<>]/.test(plainNotes)) {
  throw new Error('生成的纯文本更新说明仍包含尖括号 <>，已中止发布');
}

if (outFile) {
  const target = path.resolve(root, outFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${markdownNotes}\n`, 'utf8');
}

if (injectYmlFile) {
  const ymlPath = path.resolve(root, injectYmlFile);
  if (!fs.existsSync(ymlPath)) {
    throw new Error(`找不到更新清单文件：${ymlPath}`);
  }
  const currentYml = fs.readFileSync(ymlPath, 'utf8');
  const nextYml = injectReleaseNotesIntoLatestYml(currentYml, plainNotes);
  const parsed = yaml.load(nextYml);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.releaseNotes !== 'string' || !parsed.releaseNotes.trim()) {
    throw new Error('注入 releaseNotes 后 latest.yml 校验失败');
  }
  if (/[<>]/.test(parsed.releaseNotes)) {
    throw new Error('latest.yml 中的 releaseNotes 包含尖括号 <>');
  }
  fs.writeFileSync(ymlPath, nextYml, 'utf8');
}

if (!outFile && !injectYmlFile) {
  process.stdout.write(`${plainNotes}\n`);
}
