import type { ContentCategory } from '../shared';

/**
 * 内容类别的唯一来源。
 *
 * 任务表存的是 `nutrition` 这类值，而 style.yaml 的 `default_topic` 存的是中文类别名，
 * 两边必须用同一份列表才能对上，所以不在这里各写一份。
 */
export const CONTENT_CATEGORIES: Array<{ value: ContentCategory; label: string }> = [
  { value: 'nutrition', label: '饮食营养与蔬果利弊' },
  { value: 'wellbeing', label: '身心健康与作息' },
  { value: 'family', label: '长辈晚辈关系处理' },
  { value: 'general', label: '综合健康科普' }
];

export const CONTENT_CATEGORY_LABELS: string[] = CONTENT_CATEGORIES.map(item => item.label);

export function categoryLabel(value: ContentCategory): string {
  return CONTENT_CATEGORIES.find(item => item.value === value)?.label ?? value;
}

/** `default_topic` 存的是中文类别名，要反查回下拉框的值。 */
export function categoryValueOf(label: string): ContentCategory | null {
  return CONTENT_CATEGORIES.find(item => item.label === label)?.value ?? null;
}
