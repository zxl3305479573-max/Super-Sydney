# Sydney Visual System

## Direction

工作台服务于白天长时间切换编码、学习与写作的个人使用场景：明亮中性背景减少视觉负担，深蓝用于主要操作与当前导航，绿色和琥珀色分别表达已确认与待确认状态。

## Colors

- `--bg`: `oklch(0.975 0.003 260)`
- `--surface`: `oklch(1 0 0)`
- `--surface-raised`: `oklch(0.955 0.006 260)`
- `--ink`: `oklch(0.245 0.018 260)`
- `--muted`: `oklch(0.49 0.018 260)`
- `--primary`: `oklch(0.49 0.16 263)`
- `--success`: `oklch(0.47 0.13 155)`
- `--warning`: `oklch(0.52 0.12 70)`
- `--danger`: `oklch(0.53 0.17 25)`

## Typography

Use system sans for Chinese UI and `ui-monospace` for event metadata. Body text is 14px or larger, headings use weight and spacing rather than oversized display type.

## Components

Use a persistent left navigation, a compact top status bar, full-width work surfaces, small framed event rows, and modal dialogs only for destructive or sensitive actions. Border radius is 8px or less. Avoid nested cards and decorative gradients.

## Interaction

Primary controls have a clear verb and object. Every capture state has a visible status and a pause control. Lists support keyboard focus. Motion is limited to short opacity/translate transitions and respects `prefers-reduced-motion`.
