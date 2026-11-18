import type {
  VideoAssetBundle,
  VideoImageMode,
  VideoProject,
  VideoRenderOptions,
  VideoShot,
  VideoTemplate,
  VideoWorkflow
} from '../../shared';
import { isPreviewFresh } from '../../services/video-pipeline';
import { VIDEO_IMAGE_PROMPT_DEFAULTS } from '../../services/video-image-prompts';
import { VIDEO_TEMPLATES, imageCoverage, shotImage } from '../../services/video-production';

export function VisualsStep({
  project,
  shots,
  workflow,
  template,
  imageMode,
  footer,
  storyboardImagePromptRule,
  shotImagePromptTemplate,
  coverImagePromptTemplate,
  assetBundle,
  busy,
  onTemplate,
  onImageMode,
  onFooter,
  onPromptTemplates,
  onCaptureProduct,
  onGenerateImages,
  onRenderPreview,
  onSave,
  onNextStep
}: {
  project: VideoProject;
  shots: VideoShot[];
  workflow: VideoWorkflow;
  template: VideoTemplate;
  imageMode: VideoImageMode;
  footer: string;
  storyboardImagePromptRule: string;
  shotImagePromptTemplate: string;
  coverImagePromptTemplate: string;
  assetBundle: VideoAssetBundle | null;
  busy: string;
  onTemplate: (value: VideoTemplate) => void;
  onImageMode: (value: VideoImageMode) => void;
  onFooter: (value: string) => void;
  onPromptTemplates: (patch: Partial<Pick<VideoRenderOptions, 'storyboardImagePromptRule' | 'shotImagePromptTemplate' | 'coverImagePromptTemplate'>>) => void;
  onCaptureProduct: () => void;
  onGenerateImages: (force: boolean) => void;
  onRenderPreview: () => void;
  onSave: () => void;
  onNextStep: () => void;
}) {
  const locked = Boolean(busy);
  const isProduct = workflow === 'product-demo';
  const aiImages = imageMode === 'ai';
  const effectiveProject: VideoProject = {
    ...project,
    options: {
      ...project.options,
      template,
      imageMode,
      footer,
      storyboardImagePromptRule,
      shotImagePromptTemplate,
      coverImagePromptTemplate
    }
  };
  const coverage = imageCoverage(effectiveProject, shots);
  const previews = assetBundle?.preview ?? [];
  const previewFresh = isPreviewFresh(effectiveProject);

  return (
    <section className="flow-panel">
      <header className="flow-panel-head">
        <div>
          <h3>画面模板与视觉素材</h3>
          <p>
            {isProduct
              ? '官网截图会按镜头轮播展示并叠加品牌 Logo；渲染前先生成关键帧预览核对文字与安全区。'
              : '选择配色模板与画面形式（0 成本纯文字重点卡 / 逐镜 AI 配图），先出关键帧预览确认版式再合成成片。'}
          </p>
        </div>
      </header>

      <div className="flow-sub-head">
        <h4>画面基底模板<small>修改模板后预览与成片会自动标记为待更新</small></h4>
      </div>
      <div className="video-template-grid" role="radiogroup" aria-label="画面配色模板">
        {VIDEO_TEMPLATES.map(item => (
          <button
            type="button"
            key={item.value}
            role="radio"
            aria-checked={template === item.value}
            disabled={locked}
            className={`video-template-card video-template-${item.value} ${template === item.value ? 'is-active' : ''}`}
            onClick={() => onTemplate(item.value)}
          >
            <span className="video-template-swatch" aria-hidden="true"><i /><b /></span>
            <div>
              <strong>{item.label}</strong>
              <small>{item.hint}</small>
            </div>
          </button>
        ))}
      </div>

      <div className="native-task-fields">
        <label className="native-field-wide">
          <span>画面底部固定说明（可选，例如账号名或「健康科普 · 不替代诊疗」，最多 40 字）</span>
          <input
            disabled={locked}
            maxLength={40}
            value={footer}
            onChange={event => onFooter(event.target.value)}
            placeholder="留空时不展示页脚"
          />
        </label>
      </div>

      {!isProduct ? (
        <>
          <div className="flow-sub-head">
            <h4>镜头画面来源</h4>
          </div>
          <div className="choice-row" role="radiogroup" aria-label="配图方式">
            <button
              type="button"
              role="radio"
              aria-checked={!aiImages}
              className={`choice ${aiImages ? '' : 'is-active'}`}
              disabled={locked}
              onClick={() => onImageMode('none')}
            >
              纯文字大字卡片（0 成本 · 极速合成）
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={aiImages}
              className={`choice ${aiImages ? 'is-active' : ''}`}
              disabled={locked}
              onClick={() => onImageMode('ai')}
            >
              逐镜 AI 配图（每镜 1 张 · 使用设置中的图片模型）
            </button>
          </div>

          {aiImages && (
            <>
              <div className="flow-sub-head">
                <h4>
                  逐镜 AI 配图
                  <small>
                    已就绪 {coverage.ready}/{coverage.needed} 张
                    {coverage.stale > 0 ? `（${coverage.stale} 张提示词已变化）` : ''}
                  </small>
                </h4>
                <div className="flow-inline-actions">
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={locked || !shots.length}
                    onClick={() => onGenerateImages(false)}
                  >
                    {busy === 'images' ? '生成配图中…' : coverage.ready ? '补齐缺失 / 已改配图' : '生成全部镜头配图'}
                  </button>
                  {project.assets.images.length > 0 && (
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={locked}
                      onClick={() => {
                        if (window.confirm('全部重新生成配图会按镜头数重新调用图片模型计费，确定继续？')) {
                          onGenerateImages(true);
                        }
                      }}
                    >
                      全部重绘
                    </button>
                  )}
                </div>
              </div>

              {shots.length > 0 && (
                <div className="video-shot-images">
                  {shots.map((shot, pos) => {
                    const thumb = assetBundle?.shotImages[pos];
                    const recorded = shotImage(effectiveProject, shot);
                    return (
                      <figure key={`${shot.index}-${pos}`}>
                        {thumb ? (
                          <img src={thumb} alt={`第 ${shot.index} 镜配图`} />
                        ) : (
                          <div className="flow-image-missing">{recorded ? '文件已移除' : '待生成'}</div>
                        )}
                        <figcaption>
                          <strong>第 {shot.index} 镜</strong>
                          <span>{shot.imagePrompt || shot.visual || shot.caption}</span>
                        </figcaption>
                      </figure>
                    );
                  })}
                </div>
              )}
            </>
          )}

          <details className="flow-secondary-tools">
            <summary>
              <span>生图提示词模板（高级）</span>
              <small>按当前视频独立保存，支持 &#123;title&#125; / &#123;subject&#125; / &#123;context&#125; 占位符</small>
            </summary>
            <div className="video-prompt-fields">
              <label>
                <span>分镜 image_prompt 拆解规则</span>
                <textarea
                  className="flow-draft"
                  style={{ minHeight: 84 }}
                  disabled={locked}
                  value={storyboardImagePromptRule}
                  onChange={event => onPromptTemplates({ storyboardImagePromptRule: event.target.value })}
                />
              </label>
              <label>
                <span>逐镜 AI 配图最终模板</span>
                <textarea
                  className="flow-draft"
                  style={{ minHeight: 84 }}
                  disabled={locked}
                  value={shotImagePromptTemplate}
                  onChange={event => onPromptTemplates({ shotImagePromptTemplate: event.target.value })}
                />
              </label>
              <label>
                <span>AI 主封面提示词模板</span>
                <textarea
                  className="flow-draft"
                  style={{ minHeight: 84 }}
                  disabled={locked}
                  value={coverImagePromptTemplate}
                  onChange={event => onPromptTemplates({ coverImagePromptTemplate: event.target.value })}
                />
              </label>
            </div>
            <div className="flow-inline-actions">
              <button
                type="button"
                className="button button-quiet button-small"
                disabled={locked}
                onClick={() => onPromptTemplates({ ...VIDEO_IMAGE_PROMPT_DEFAULTS })}
              >
                恢复默认提示词模板
              </button>
            </div>
          </details>
        </>
      ) : (
        <div className="flow-inline-actions">
          <button type="button" className="button button-secondary" disabled={locked} onClick={onCaptureProduct}>
            {busy === 'capture' ? '抓取官网中…' : '重新抓取官网截图与品牌色'}
          </button>
          <span className="video-step-stat">已保存 {project.options.productScreenshots.length} 张官网视口截图</span>
        </div>
      )}

      <div className="flow-sub-head">
        <h4>
          关键帧版式预览（本地免费）
          <small>
            {previews.length
              ? previewFresh ? `共 ${previews.length} 帧 · 与当前设置同步` : '画面或文案已修改，建议重新生成预览核对排版'
              : '渲染成片前先用几秒钟看一眼每镜排版是否拥挤'}
          </small>
        </h4>
        <button
          type="button"
          className="button button-secondary"
          disabled={locked || !shots.length}
          onClick={onRenderPreview}
        >
          {busy === 'preview' ? '渲染预览中…' : previews.length ? '刷新关键帧预览' : '生成关键帧预览'}
        </button>
      </div>

      {previews.length ? (
        <div className={`video-frame-grid video-workbench-preview-grid ${previewFresh ? '' : 'is-stale'}`}>
          {previews.map((thumbnail, index) => (
            <figure key={`${index}-${thumbnail.slice(-16)}`}>
              {thumbnail ? <img src={thumbnail} alt={`第 ${index + 1} 镜关键帧`} /> : <div className="flow-image-missing">预览缺失</div>}
              <figcaption>第 {index + 1} 镜</figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <p className="flow-empty">还没有关键帧预览。点击「生成关键帧预览」即可按目标平台安全区生成每镜静帧。</p>
      )}

      <div className="flow-inline-actions">
        <button type="button" className="button button-secondary" disabled={locked} onClick={onSave}>
          {busy === 'save' ? '保存中…' : '保存画面设置'}
        </button>
        <button type="button" className="button button-quiet" disabled={locked} onClick={onNextStep}>
          下一步：成片验收 →
        </button>
      </div>
    </section>
  );
}
