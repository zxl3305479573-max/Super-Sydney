import { useEffect, useState } from 'react';
import type { ModelConfigDraft, ModelConfigView, ModelPresetKind, ModelPresetView } from '../../shared';
import ModelPresetBar from '../ModelPresetBar';
import { Switch, readableError } from '../ui';
import { keyBadge, SettingRow } from './shared';
import { SettingsSection } from './SectionLayout';

const IMAGE_PROVIDERS = ['openai', 'doubao', 'dashscope', 'jimeng', 'minimax', 'gemini', 'openrouter', 'replicate', 'azure_openai', 'sub2api'];

const draftFromView = (view: ModelConfigView): ModelConfigDraft => ({
  writer: { baseUrl: view.writer.baseUrl, model: view.writer.model, apiKey: '' },
  image: { provider: view.image.provider, model: view.image.model, baseUrl: view.image.baseUrl, apiKey: '', estimatedCost: view.image.estimatedCost }
});

/** 统一模型配置：全应用一个内容模型、一个图片模型，公众号、视频、小红书、AI 整理与经验卡片都用它。 */
export function ModelsSection({ enabled, onToggle, notify }: { enabled: boolean; onToggle: (value: boolean) => void; notify: (message: string) => void }) {
  const [view, setView] = useState<ModelConfigView | null>(null);
  const [draft, setDraft] = useState<ModelConfigDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const load = (next: ModelConfigView) => { setView(next); setDraft(draftFromView(next)); };
  useEffect(() => { void window.sydney.getModelConfig().then(load).catch(error => notify(readableError(error))); }, [notify]);
  if (!view || !draft) return null;

  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFromView(view));
  const run = async (action: () => Promise<ModelConfigView>, message: string) => {
    setBusy(true);
    try { load(await action()); notify(message); } catch (error) { notify(readableError(error)); } finally { setBusy(false); }
  };
  const patchWriter = (patch: Partial<ModelConfigDraft['writer']>) => setDraft({ ...draft, writer: { ...draft.writer, ...patch } });
  const patchImage = (patch: Partial<ModelConfigDraft['image']>) => setDraft({ ...draft, image: { ...draft.image, ...patch } });
  const applyPreset = (preset: ModelPresetView) => {
    if (dirty && !window.confirm('表单里有未保存的修改，切换预设会丢掉这些修改。继续？')) return;
    void run(() => window.sydney.applyModelPreset(preset.id), `已切换到「${preset.name}」，所有模块之后都用这套模型`);
  };
  const savePreset = (kind: ModelPresetKind, name: string) => {
    const values = kind === 'writer' ? { ...draft.writer } : { ...draft.image };
    void run(() => window.sydney.saveModelPreset({ kind, name, ...values }), `已存为预设「${name || values.model}」`);
  };
  const deletePreset = (preset: ModelPresetView) => {
    if (!window.confirm(`删除预设「${preset.name}」？当前在用的配置不受影响。`)) return;
    void run(() => window.sydney.deleteModelPreset(preset.id), `已删除预设「${preset.name}」`);
  };
  const presetBar = (kind: ModelPresetKind) => <ModelPresetBar kind={kind} presets={view.presets.filter(item => item.kind === kind)}
    activeId={view.activePresets[kind]} defaultName={kind === 'writer' ? draft.writer.model : draft.image.model} busy={busy}
    onApply={applyPreset} onSave={name => savePreset(kind, name)} onDelete={deletePreset} />;
  const test = async () => {
    setTesting(true);
    try { const result = await window.sydney.testContentModel(); notify(`内容模型连接正常（${result.model}）`); }
    catch (error) { notify(`连接失败：${readableError(error)}`); }
    finally { setTesting(false); }
  };

  return <SettingsSection id="set-models" title="模型" purpose="全应用统一的内容模型与图片模型：公众号、视频、小红书、AI 整理与经验卡片都用这里的配置，各模块不再单独设置。"
    action={<button className="button button-primary" disabled={busy || !dirty} onClick={() => void run(() => window.sydney.saveModelConfig(draft), '模型配置已保存，所有模块立即生效')}>{busy ? '保存中…' : '保存'}</button>}
    toolbar={<span className="module-toolbar-note">{dirty ? '有未保存的修改' : '配置写入本机 ~/.wewrite/config.yaml，内容模型 key 在系统安全存储'}</span>}>
    <SettingRow title="允许调用内容模型" description="关闭后所有模块的 AI 写作、整理、检测按钮都不可用。只在你点击时发送对应内容。"
      control={<Switch label="允许调用内容模型" checked={enabled} onChange={onToggle} />} />
    <SettingRow title="内容模型" badge={keyBadge(view.writer.key)} description="OpenAI 兼容的 chat/completions 接口；key 使用系统安全存储加密，未保存时回退到环境变量。">
      {presetBar('writer')}
      <div className="ww-grid">
        <label className="ww-input"><span>接口地址</span><input value={draft.writer.baseUrl} onChange={event => patchWriter({ baseUrl: event.target.value })} placeholder="https://api.deepseek.com/v1" /></label>
        <label className="ww-input"><span>模型</span><input value={draft.writer.model} onChange={event => patchWriter({ model: event.target.value })} placeholder="deepseek-chat" /></label>
        <label className="ww-input ww-wide"><span>API Key</span><input type="password" autoComplete="off" value={draft.writer.apiKey} onChange={event => patchWriter({ apiKey: event.target.value })} placeholder={view.writer.key.configured ? `已配置 ${view.writer.key.masked}，留空保留` : 'sk-...'} /></label>
      </div>
      <button className="button button-quiet" disabled={testing || dirty} title={dirty ? '先保存再测试' : '用当前在用的内容模型发一条最小请求'} onClick={() => void test()}>{testing ? '测试中…' : '测试连接'}</button>
    </SettingRow>
    <SettingRow title="图片模型" badge={<span className={`badge ${view.image.apiKeyMasked ? 'badge-on' : 'badge-off'}`}>{view.image.apiKeyMasked ? `已保存 ${view.image.apiKeyMasked}` : '未保存'}</span>}
      description="OpenAI 兼容的 images/generations 接口，用于封面、配图与信息图（按张计费）。">
      {presetBar('image')}
      <div className="ww-grid ww-grid-three">
        <label className="ww-input"><span>Provider</span>
          <select value={draft.image.provider} onChange={event => patchImage({ provider: event.target.value })}>
            <option value="">未选择</option>
            {IMAGE_PROVIDERS.map(item => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label className="ww-input"><span>模型</span><input value={draft.image.model} onChange={event => patchImage({ model: event.target.value })} placeholder="gpt-image-2" /></label>
        <label className="ww-input"><span>预估单价</span><input value={draft.image.estimatedCost} onChange={event => patchImage({ estimatedCost: event.target.value })} placeholder="0.04" /></label>
        <label className="ww-input ww-wide"><span>接口地址</span><input value={draft.image.baseUrl} onChange={event => patchImage({ baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" /></label>
        <label className="ww-input ww-wide"><span>API Key</span><input type="password" autoComplete="off" value={draft.image.apiKey} onChange={event => patchImage({ apiKey: event.target.value })} placeholder={view.image.apiKeyMasked ? `已配置 ${view.image.apiKeyMasked}，留空保留` : '输入图片服务 API Key'} /></label>
      </div>
    </SettingRow>
    <div className="set-model-actions">
      <button className="button button-secondary" disabled={busy || !dirty} onClick={() => setDraft(draftFromView(view))}>放弃修改</button>
    </div>
  </SettingsSection>;
}
