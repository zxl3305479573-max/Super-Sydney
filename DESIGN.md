# Sydney Visual System

## Direction

工作台采用深松绿固定导航与浅雾绿内容区形成稳定分区；白色表面承载任务和编辑器，低饱和松绿用于主要操作。绿色和琥珀色分别表达已确认与待确认状态。不同模块按主要工作流组织布局，而不是复用同一张卡片页面。

## Colors

- `--bg`: `oklch(0.958 0.012 155)`
- `--surface`: `oklch(0.995 0.003 145)`
- `--surface-raised`: `oklch(0.93 0.018 155)`
- `--ink`: `oklch(0.22 0.025 170)`
- `--muted`: `oklch(0.49 0.02 170)`
- `--primary`: `oklch(0.48 0.12 164)`
- `--success`: `oklch(0.52 0.13 150)`
- `--warning`: `oklch(0.68 0.14 75)`
- `--danger`: `oklch(0.56 0.17 28)`

## Typography

Use system sans for Chinese UI and `ui-monospace` for event metadata. Body text is 14px or larger, headings use weight and spacing rather than oversized display type.

## Components

- **Window chrome**: no system title bar or menu bar. A 40px custom title bar (drag region) shows the breadcrumb (group / page) on the left and Windows-style minimize / maximize / close on the right; only the content area under it scrolls. Window size, position and maximized state persist across launches.
- **Theme**: light and dark, switched from the sun/moon switch at the top right of the title bar. The new theme spreads as a circle from the switch over the whole window (View Transitions); the choice persists, first launch follows the system. Dark mode only swaps tokens on `:root[data-theme="dark"]` — new components must use tokens, not literal colors.
- **Shell**: full-height deep-green sidebar grouped by work area, with a pending-count badge on 待确认 and a recording widget (state + pause/resume) pinned at the bottom so capture is controllable from every page. The mist-green workspace separates page hierarchy from white task surfaces.
- **Panels**: one level of framed surface (`.panel`, `.set-card`) with a header (title + one-line purpose + actions on the right), optional footer for secondary actions. No nested cards; inner groups use soft fills instead of borders.
- **Event rows**: time · kind avatar (Claude / Codex / 应用 / 文件 / 手动, each with its own tint) · title (2 lines) · summary (2 lines) · meta chips. Pending rows carry an amber left bar and inline 确认 / 忽略; everything else lives in the ⋯ menu. Rows are keyboard-focusable: A 确认, X 忽略, Enter 详情, Space 勾选.
- **Dialogs**: `Modal` with backdrop, Esc to close, footer actions right-aligned and the destructive action on the left as a two-step ConfirmButton. Used for event details and manual records (never `window.prompt`).
- **Controls**: `Switch` for booleans, `Segmented` for mutually exclusive filters (with counts), chip-style `TagEditor` for app lists, numbers commit on blur/Enter.
- **Feedback**: stacked toasts bottom-right (dark = info, red = error), status pills (amber 待确认, green 已确认, grey 已忽略), source chips with a coloured dot (green running, amber waiting, grey off, red error).
- Module layouts: work records pair capture health and metrics above a dense timeline; writing modules pair task lists with an editor; video production separates project rail, editor, and delivery inspector; operational modules put the primary action and current state in adjacent working areas.
- Border radius 8px (6px for controls, pills fully rounded). Shadows stay subtle and are reserved for framed work surfaces, floating layers, and hover.

## AI Draft Review

The DeepSeek control is opt-in and appears as a single-event action. The review surface keeps the generated nine-field draft inside the event row, labels the model and generation time, and exposes separate actions for applying the summary or deleting the draft. Applying a draft never changes the event status automatically.
