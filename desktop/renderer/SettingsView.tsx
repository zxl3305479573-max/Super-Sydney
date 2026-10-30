import { useEffect, useState } from 'react';
import type { AppState, AppTheme, WindowChromeState } from '../shared';
import { IpLibraryCard } from './IpLibrary';
import { TitleBar } from './TitleBar';
import { Icon, type IconName } from './ui';
import { AboutSection } from './settings/AboutSection';
import { ActivitySection } from './settings/ActivitySection';
import { AiCaptureSection } from './settings/AiCaptureSection';
import { CloudSection } from './settings/CloudSection';
import { DataSection } from './settings/DataSection';
import { FilesSection } from './settings/FilesSection';
import { ModelsSection } from './settings/ModelsSection';
import { type Patch } from './settings/shared';
import { VaultSection } from './settings/VaultSection';

const SECTIONS: Array<{ id: string; label: string; icon: IconName }> = [
  { id: 'vault', label: '知识库', icon: 'book' },
  { id: 'activity', label: '活动记录', icon: 'window' },
  { id: 'ai', label: 'AI 对话采集', icon: 'bot' },
  { id: 'files', label: '文件与屏幕', icon: 'folder' },
  { id: 'cloud', label: '云同步', icon: 'cloud' },
  { id: 'models', label: '模型', icon: 'key' },
  { id: 'ip', label: 'IP 形象', icon: 'user' },
  { id: 'data', label: '选题数据', icon: 'chart' },
  { id: 'about', label: '关于', icon: 'spark' }
];

export function SettingsView({ open, onClose, state, onSetting, onChooseFiles, notify, chrome, theme, onToggleTheme }: {
  open: boolean; onClose: () => void; state: AppState; onSetting: (patch: Patch) => Promise<void>; onChooseFiles: () => Promise<void>; notify: (message: string) => void;
  chrome: WindowChromeState; theme: AppTheme; onToggleTheme: (origin: { x: number; y: number }) => void;
}) {
  const settings = state.settings;
  const [active, setActive] = useState('vault');
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  return <div className="settings-shell" hidden={!open}>
    <TitleBar crumbs={['系统', '隐私与设置']} chrome={chrome} scrolled={false} theme={theme} onToggleTheme={onToggleTheme} />
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分区">
        {SECTIONS.map(section => <button key={section.id} className={active === section.id ? 'is-active' : ''} aria-current={active === section.id ? 'page' : undefined} onClick={() => setActive(section.id)}><Icon name={section.icon} size={15} />{section.label}</button>)}
      </nav>

      <main className="settings-page">
        <header className="settings-page-head">
          <div><p>系统设置</p><h1>{SECTIONS.find(section => section.id === active)?.label}</h1></div>
          <button className="button button-secondary" onClick={onClose}><Icon name="x" size={16} />返回工作台</button>
        </header>
        <div className="settings-body">
          {active === 'vault' && <VaultSection vaultPath={settings.vaultPath} notify={notify} />}
          {active === 'activity' && <ActivitySection settings={settings} onSetting={onSetting} />}
          {active === 'ai' && <AiCaptureSection state={state} settings={settings} onSetting={onSetting} />}
          {active === 'files' && <FilesSection state={state} settings={settings} onSetting={onSetting} onChooseFiles={onChooseFiles} />}
          {active === 'cloud' && <CloudSection settings={settings} onSetting={onSetting} notify={notify} />}
          {active === 'models' && <ModelsSection enabled={settings.llmEnabled} onToggle={value => void onSetting({ llmEnabled: value })} notify={notify} />}
          {active === 'ip' && <IpLibraryCard notify={notify} />}
          {active === 'data' && <DataSection notify={notify} />}
          {active === 'about' && <AboutSection notify={notify} />}
        </div>
      </main>
    </div>
  </div>;
}
