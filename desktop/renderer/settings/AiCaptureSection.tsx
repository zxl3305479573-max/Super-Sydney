import type { AppState, Settings } from '../../shared';
import { LinesEditor, Switch } from '../ui';
import { statusBadge, type Patch, SettingRow } from './shared';
import { SettingsSection } from './SectionLayout';

export function AiCaptureSection({ state, settings, onSetting }: { state: AppState; settings: Settings; onSetting: (patch: Patch) => Promise<void> }) {
  return <SettingsSection title="AI 对话采集" purpose="只采集你输入的提示词和每轮最终答复；工具只记名称与改动的文件路径，不保存工具输出、思考过程和历史会话。">
    <SettingRow title="Codex 对话" badge={statusBadge(state.codexCapture)} description="监听 ~/.codex/sessions 中新增的会话。"
      control={<Switch label="Codex 对话" checked={settings.codexCaptureEnabled} onChange={value => void onSetting({ codexCaptureEnabled: value })} />} />
    <SettingRow title="包含 Codex CLI 与 IDE 插件" description="默认只采集 Codex 桌面端；开启后也采集终端 codex 与 VS Code 插件。"
      control={<Switch label="包含 Codex CLI" disabled={!settings.codexCaptureEnabled} checked={settings.codexIncludeCli} onChange={value => void onSetting({ codexIncludeCli: value })} />} />
    <SettingRow title="Claude Code 对话" badge={statusBadge(state.claudeCapture)} description="监听 ~/.claude/projects（含斜杠命令）；跳过工具结果、子代理和 ! 终端命令。"
      control={<Switch label="Claude Code 对话" checked={settings.claudeCaptureEnabled} onChange={value => void onSetting({ claudeCaptureEnabled: value })} />} />
    {settings.claudeCaptureEnabled && <SettingRow title="额外的 Claude 会话目录" description="每行一个目录，例如另一个 CLAUDE_CONFIG_DIR 下的 projects；失焦后保存。">
      <LinesEditor values={settings.claudeExtraRoots} placeholder="D:\\other-claude\\projects" onChange={values => void onSetting({ claudeExtraRoots: values })} />
    </SettingRow>}
  </SettingsSection>;
}
