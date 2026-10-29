import { ImagePromptField, type AiProps } from './fields';
import type { ProfileRow } from './types';

export function ImageSection({ active, patchActive, aiProps, optimizeImage }: {
  active: ProfileRow;
  patchActive: (patch: Partial<ProfileRow>) => void;
  aiProps: (fieldKey: string, run: () => void, adopt: (note: string) => void) => AiProps;
  optimizeImage: () => void;
}) {
  return <div className="ww-group">
    <div className="ww-group-head"><h3>配图风格模板</h3><small>这份资料的封面与正文配图；具体方向可在「具体方向」里单独覆盖</small></div>
    <ImagePromptField value={active.imagePrompt} inherited="" collapsible={false}
      onChange={imagePrompt => patchActive({ imagePrompt })}
      {...aiProps(`img:${active.key}`, () => optimizeImage(), imagePrompt => patchActive({ imagePrompt }))} />
  </div>;
}
