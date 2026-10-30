import type { Settings } from '../../shared';
import { Switch, TagEditor } from '../ui';
import { NumberInput, type Patch, SettingRow } from './shared';
import { SettingsSection } from './SectionLayout';

export function ActivitySection({ settings, onSetting }: { settings: Settings; onSetting: (patch: Patch) => Promise<void> }) {
  return <SettingsSection title="活动记录" purpose="只记录应用名称、窗口标题和使用时长，不记录键盘输入。">
    <SettingRow title="先全部保存，再人工确认" description="不在允许名单里的非敏感窗口也会进入待确认列表，由你决定保留或删除。密码、支付与私人聊天始终跳过。"
      control={<Switch label="先全部保存" checked={settings.captureAllPending} onChange={value => void onSetting({ captureAllPending: value })} />} />
    <SettingRow title="采样间隔" description="下次开始记录时生效，最短 10 秒。" control={<NumberInput value={settings.captureIntervalSeconds} min={10} suffix="秒" onCommit={value => void onSetting({ captureIntervalSeconds: value })} />} />
    <SettingRow title="允许采集的应用" description="按应用名包含匹配；回车或逗号添加。">
      <TagEditor values={settings.allowedApps} placeholder="例如 Code、Obsidian" onChange={values => void onSetting({ allowedApps: values })} />
    </SettingRow>
    <SettingRow title="禁止采集的应用 / 关键词" description="应用名或窗口标题包含这些词时直接跳过。">
      <TagEditor tone="danger" values={settings.blockedApps} placeholder="例如 1Password、微信" onChange={values => void onSetting({ blockedApps: values })} />
    </SettingRow>
  </SettingsSection>;
}
