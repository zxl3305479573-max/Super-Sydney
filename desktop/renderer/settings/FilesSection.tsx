import type { AppState, Settings } from '../../shared';
import { Icon, Switch } from '../ui';
import { NumberInput, type Patch, SettingRow } from './shared';
import { SettingsSection } from './SectionLayout';

export function FilesSection({ state, settings, onSetting, onChooseFiles }: { state: AppState; settings: Settings; onSetting: (patch: Patch) => Promise<void>; onChooseFiles: () => Promise<void> }) {
  return <SettingsSection title="文件与屏幕" purpose="文件只记录路径和变化类型；屏幕帧本地加密，不上传、不做 OCR。">
    <SettingRow title="监听文件变化" description={settings.inputWatchPaths.length ? '监听下方关联的文件 / 目录。' : '未关联文件时监听知识库的 01-输入 目录。'}
      control={<Switch label="监听文件变化" checked={settings.inputWatchEnabled} onChange={value => void onSetting({ inputWatchEnabled: value })} />}>
      <div className="file-list">
        {settings.inputWatchPaths.map(item => <span key={item} className="file-chip"><Icon name="file" size={13} /><code>{item}</code><button aria-label="移除" onClick={() => void onSetting({ inputWatchPaths: settings.inputWatchPaths.filter(value => value !== item) })}><Icon name="x" size={12} /></button></span>)}
        <button className="button button-secondary button-small" onClick={() => void onChooseFiles()}><Icon name="plus" />关联文件</button>
      </div>
    </SettingRow>
    <SettingRow title="屏幕后台采样" badge={settings.screenCaptureEnabled ? <span className="badge badge-idle">已保存 {state.screenCapture.saved} 帧</span> : undefined}
      description={state.screenCapture.state === 'error' ? state.screenCapture.error : '只在允许的应用前台时截图，AES-GCM 加密保存。'}
      control={<Switch label="屏幕后台采样" checked={settings.screenCaptureEnabled} onChange={value => void onSetting({ screenCaptureEnabled: value })} />} />
    {settings.screenCaptureEnabled && <>
      <SettingRow title="截图间隔" control={<NumberInput value={settings.screenCaptureIntervalSeconds} min={15} suffix="秒" onCommit={value => void onSetting({ screenCaptureIntervalSeconds: value })} />} />
      <SettingRow title="保留时间" description="超过时间的帧自动删除。" control={<NumberInput value={settings.screenRetentionHours} min={1} suffix="小时" onCommit={value => void onSetting({ screenRetentionHours: value })} />} />
    </>}
  </SettingsSection>;
}
