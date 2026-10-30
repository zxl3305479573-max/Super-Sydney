import { useEffect, useState } from 'react';
import type { CloudSyncStatus, LlmKeyStatus, Settings } from '../../shared';
import { Switch, readableError } from '../ui';
import { keyBadge, type Patch, SettingRow, syncTime } from './shared';
import { SettingsSection } from './SectionLayout';

/** 云同步：把已确认事件批量上传到自建同步 API。 */
export function CloudSection({ settings, onSetting, notify }: { settings: Settings; onSetting: (patch: Patch) => Promise<void>; notify: (message: string) => void }) {
  const [status, setStatus] = useState<CloudSyncStatus | null>(null);
  const [keyStatus, setKeyStatus] = useState<LlmKeyStatus>({ configured: false, masked: '', encryptionAvailable: true });
  const [password, setPassword] = useState('');
  const [url, setUrl] = useState(settings.cloudSyncUrl);
  const [username, setUsername] = useState(settings.cloudSyncUsername);
  const [running, setRunning] = useState(false);
  const reload = () => { void window.sydney.getCloudSyncStatus().then(setStatus); };
  useEffect(() => { reload(); void window.sydney.getCloudSyncKeyStatus().then(setKeyStatus); }, []);
  useEffect(() => { setUrl(settings.cloudSyncUrl); setUsername(settings.cloudSyncUsername); }, [settings.cloudSyncUrl, settings.cloudSyncUsername]);

  const toggle = async (value: boolean) => { await onSetting({ cloudSyncEnabled: value }); reload(); };
  const saveKey = async () => { setKeyStatus(await window.sydney.saveCloudSyncKey(password.trim())); setPassword(''); notify('云同步密码已安全保存'); };
  const deleteKey = async () => { setKeyStatus(await window.sydney.deleteCloudSyncKey()); notify('已删除本机保存的云同步密码'); };
  const sync = async () => {
    setRunning(true);
    try {
      const next = await window.sydney.runCloudSync();
      setStatus(next);
      notify(next.error || (next.pending ? `已同步，仍有 ${next.pending} 条待上传` : '已同步，队列已清空'));
    } catch (error) { notify(readableError(error)); }
    finally { setRunning(false); }
  };
  const commitUrl = () => { const value = url.trim(); if (value && value !== settings.cloudSyncUrl) void onSetting({ cloudSyncUrl: value }); else setUrl(settings.cloudSyncUrl); };
  const commitUsername = () => { const value = username.trim(); if (value !== settings.cloudSyncUsername) void onSetting({ cloudSyncUsername: value }); else setUsername(settings.cloudSyncUsername); };

  const enabled = settings.cloudSyncEnabled;
  const pending = status?.pending ?? 0;
  return <SettingsSection id="set-cloud" title="云同步" purpose="把已确认的事件按隐私规则上传到你自己的同步服务，用于跨设备汇总。密码用系统安全存储加密，只留在本机主进程。"
    action={enabled ? <button className="button button-primary" disabled={running} onClick={() => void sync()}>{running ? '同步中…' : '立即同步'}</button> : undefined}>
    <SettingRow title="开启云同步" badge={enabled ? <span className="badge badge-on">已开启</span> : <span className="badge badge-off">未开启</span>}
      description="关闭后不再上传；已在队列里的记录会保留，重新开启后继续同步。"
      control={<Switch label="开启云同步" checked={enabled} onChange={value => void toggle(value)} />} />
    {enabled && <>
      <SettingRow title="同步地址" description="你的同步 API 根地址，应用会请求其下的 /sync。" control={<input className="input" value={url} onChange={event => setUrl(event.target.value)} onBlur={commitUrl} onKeyDown={event => { if (event.key === 'Enter') commitUrl(); }} placeholder="https://zxlup.xin/sync-api/" />} />
      <SettingRow title="用户名" description="HTTP Basic Auth 的用户名。" control={<input className="input" value={username} onChange={event => setUsername(event.target.value)} onBlur={commitUsername} onKeyDown={event => { if (event.key === 'Enter') commitUsername(); }} />} />
      <SettingRow title="密码" badge={keyBadge(keyStatus)}
        description={keyStatus.encryptionAvailable ? '使用系统安全存储加密，不写入项目、数据库或知识库；留空表示使用空密码。' : '当前系统安全存储不可用，无法保存密码。'}>
        <div className="key-row">
          <input className="input" type="password" autoComplete="off" placeholder={keyStatus.configured ? '输入新密码以替换' : '留空表示空密码'} value={password} onChange={event => setPassword(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && password.trim()) void saveKey(); }} />
          <button className="button button-primary" disabled={!password.trim() || !keyStatus.encryptionAvailable} onClick={() => void saveKey()}>保存</button>
          {keyStatus.configured && <button className="button button-quiet" onClick={() => void deleteKey()}>删除</button>}
        </div>
      </SettingRow>
      <SettingRow title="隐私" description="默认只上传摘要、分类、时长、时间；截图路径永不上传。以下两项默认关闭，需要时才打开。" />
      <SettingRow title="上传窗口标题" description="窗口标题可能包含正在处理的文件名或聊天对象，默认关闭。"
        control={<Switch label="上传窗口标题" checked={settings.cloudSyncIncludeWindowTitle} onChange={value => void onSetting({ cloudSyncIncludeWindowTitle: value })} />} />
      <SettingRow title="上传文件路径" description="文件路径会暴露本机目录结构，默认关闭。"
        control={<Switch label="上传文件路径" checked={settings.cloudSyncIncludeFilePath} onChange={value => void onSetting({ cloudSyncIncludeFilePath: value })} />} />
      <SettingRow title="同步状态" description={status?.error || `上次同步：${syncTime(status?.lastSyncAt ?? '')} · 待上传 ${pending} 条`} />
    </>}
  </SettingsSection>;
}
