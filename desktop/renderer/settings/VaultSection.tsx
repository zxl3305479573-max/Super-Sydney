import { Icon } from '../ui';
import { SettingRow } from './shared';
import { SettingsSection } from './SectionLayout';

export function VaultSection({ vaultPath, notify }: { vaultPath: string; notify: (message: string) => void }) {
  const chooseVault = async () => { const next = await window.sydney.chooseVault(); if (next) notify(`知识库已切换到 ${next}`); };
  return <SettingsSection title="知识库" purpose="确认后的事件、日报、周报和进化记录写入这个 Obsidian 目录。"
    action={<button className="button button-primary" onClick={() => void chooseVault()}><Icon name="folder" />更换目录</button>}>
    <SettingRow title="Obsidian 知识库目录" description={<code className="path">{vaultPath || '未设置'}</code>}
      control={<button className="button button-quiet" onClick={() => void window.sydney.openVault()}>打开</button>} />
  </SettingsSection>;
}
