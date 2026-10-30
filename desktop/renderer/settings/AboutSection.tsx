import { useEffect, useState } from 'react';
import { readableError } from '../ui';
import { SettingsSection } from './SectionLayout';
import { SettingRow } from './shared';

export function AboutSection({ notify }: { notify: (message: string) => void }) {
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => { void window.sydney.getAppVersion().then(setAppVersion).catch(() => setAppVersion('未知')); }, []);
  return <SettingsSection title="关于 Sydney" purpose="个人工作 OS：把工作记录、内容创作与知识沉淀放在同一个本地优先的工作台。"
    action={<button className="button button-primary" onClick={() => void window.sydney.checkForUpdates().then(status => notify(status.supported ? (status.message || `状态：${status.phase}`) : '当前环境不支持自动更新')).catch(error => notify(readableError(error)))}>检查更新</button>}>
    <SettingRow title="当前版本" description={<code className="path">v{appVersion ?? '读取中…'}</code>} />
    <SettingRow title="更新" description="已安装的 Windows 正式版会在启动后检查更新；也可点侧栏「更新提醒」或上方按钮。开发模式不会发起更新检查。" />
  </SettingsSection>;
}
