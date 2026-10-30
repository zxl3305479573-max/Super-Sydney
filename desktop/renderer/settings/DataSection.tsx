import { useEffect, useState } from 'react';
import type { LlmKeyStatus } from '../../shared';
import { readableError } from '../ui';
import { SettingsSection } from './SectionLayout';
import { SettingRow } from './shared';

export function DataSection({ notify }: { notify: (message: string) => void }) {
  const [redfoxKey, setRedfoxKey] = useState('');
  const [redfoxStatus, setRedfoxStatus] = useState<LlmKeyStatus>({ configured: false, masked: '', encryptionAvailable: true });
  const [redfoxTesting, setRedfoxTesting] = useState(false);
  const redfoxFromEnv = redfoxStatus.configured && redfoxStatus.masked.includes('环境变量');
  useEffect(() => { void window.sydney.getRedfoxKeyStatus().then(setRedfoxStatus); }, []);
  const saveRedfoxKey = async () => { setRedfoxStatus(await window.sydney.saveRedfoxKey(redfoxKey.trim())); setRedfoxKey(''); notify('红狐 API Key 已安全保存'); };
  const removeRedfoxKey = async () => { setRedfoxStatus(await window.sydney.deleteRedfoxKey()); notify('已删除程序内保存的红狐 Key'); };
  const testRedfoxKey = async () => {
    setRedfoxTesting(true);
    try { const result = await window.sydney.testRedfoxKey(); notify(`红狐连接正常，近 7 天全站热门共 ${result.total} 条`); }
    catch (error) { notify(`红狐连接失败：${readableError(error)}`); }
    finally { setRedfoxTesting(false); }
  };
  return <SettingsSection title="内容选题 · 热点数据（红狐）" purpose="公众号、小红书和视频模块共用这一个红狐 Key。只在你点搜索或生成选题时把关键词发给红狐；同样的查询 24 小时内走本地缓存。">
    <SettingRow title="红狐 API Key" badge={<span className={`badge ${redfoxStatus.configured ? 'badge-on' : 'badge-off'}`}>{redfoxFromEnv ? '使用环境变量' : redfoxStatus.configured ? `已保存 ${redfoxStatus.masked}` : '未保存'}</span>}
      description={redfoxStatus.encryptionAvailable ? '使用系统安全存储加密，不写入项目、数据库或知识库；未保存时回退到环境变量 REDFOX_API_KEY。获取地址：redfox.hk/settings/api-keys' : '当前系统安全存储不可用，无法保存密钥。'}>
      <div className="key-row">
        <input className="input" type="password" autoComplete="off" placeholder={redfoxStatus.configured ? '输入新 Key 以替换' : 'ak_...'} value={redfoxKey} onChange={event => setRedfoxKey(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && redfoxKey.trim()) void saveRedfoxKey(); }} />
        <button className="button button-primary" disabled={!redfoxKey.trim() || !redfoxStatus.encryptionAvailable} onClick={() => void saveRedfoxKey()}>保存</button>
        <button className="button button-secondary" disabled={redfoxTesting} onClick={() => void testRedfoxKey()}>{redfoxTesting ? '测试中…' : '测试连接'}</button>
        {redfoxStatus.configured && !redfoxFromEnv && <button className="button button-quiet" onClick={() => void removeRedfoxKey()}>删除</button>}
      </div>
    </SettingRow>
  </SettingsSection>;
}
