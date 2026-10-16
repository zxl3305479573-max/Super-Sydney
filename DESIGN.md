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

- **Window chrome**: no system title bar or menu bar. A 40px custom title bar (drag region) shows the breadcrumb (group / page) on the left and Windows-style minimize / maximize / close on the right; only the content area under it scrolls. Window size, position and maximized state persist across launches.
- **Theme**: light and dark, switched from the sun/moon switch at the top right of the title bar. The new theme spreads as a circle from the switch over the whole window (View Transitions); the choice persists, first launch follows the system. Dark mode only swaps tokens on `:root[data-theme="dark"]` — new components must use tokens, not literal colors.
- **Shell**: full-height left sidebar grouped as 工作记录 / 成长 / 内容, with a pending-count badge on 待确认 and a recording widget (state + pause/resume) pinned at the bottom so capture is controllable from every page.
- **Panels**: one level of framed surface (`.panel`, `.set-card`) with a header (title + one-line purpose + actions on the right), optional footer for secondary actions. No nested cards; inner groups use soft fills instead of borders.
- **Event rows**: time · kind avatar (Claude / Codex / 应用 / 文件 / 手动, each with its own tint) · title (2 lines) · summary (2 lines) · meta chips. Pending rows carry an amber left bar and inline 确认 / 忽略; everything else lives in the ⋯ menu. Rows are keyboard-focusable: A 确认, X 忽略, Enter 详情, Space 勾选.
- **Dialogs**: `Modal` with backdrop, Esc to close, footer actions right-aligned and the destructive action on the left as a two-step ConfirmButton. Used for event details and manual records (never `window.prompt`).
- **Controls**: `Switch` for booleans, `Segmented` for mutually exclusive filters (with counts), chip-style `TagEditor` for app lists, numbers commit on blur/Enter.
- **Feedback**: stacked toasts bottom-right (dark = info, red = error), status pills (amber 待确认, green 已确认, grey 已忽略), source chips with a coloured dot (green running, amber waiting, grey off, red error).
- Border radius 8px (6px for controls, pills fully rounded). Shadows only for floating layers and hover.

## AI Draft Review

The DeepSeek control is opt-in and appears as a single-event action. The review surface keeps the generated nine-field draft inside the event row, labels the model and generation time, and exposes separate actions for applying the summary or deleting the draft. Applying a draft never changes the event status automatically.
