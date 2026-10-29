# UI 更新与版本信息实现摘要

## 完成内容

- 将侧栏左上角拆为不可点击的 Sydney 品牌标识，以及右侧独立的“检查更新”提醒按钮，避免把产品标识误作更新入口。
- 品牌区外层继续承担窗口拖拽；更新按钮显式使用 `-webkit-app-region: no-drag`，点击不会影响窗口拖动能力。
- 更新按钮复用 `window.sydney.checkForUpdates()`：检查或下载时显示对应状态、禁用重复点击并旋转图标；发现新版本时突出提示。开发模式或不受支持的平台仍通过 toast 明确说明无法检查更新。
- 新增 `auto-update:status` 渲染进程订阅，将检查中、发现新版本、下载进度、下载完成和失败状态反馈为 toast；下载进度按 10% 节流，避免提示过密。
- 将自动更新状态类型收敛到 `desktop/shared.ts`，由 preload 的 `onAutoUpdateStatus()` 安全暴露给渲染层。
- 新增 `app:getVersion` IPC 和 `window.sydney.getAppVersion()`，版本号始终来自 Electron 的 `app.getVersion()`。
- 设置页新增“关于”导航与卡片，显示 Sydney 的产品说明、当前版本和更新检查方式。
- 当前 `package.json` 版本保持为 `0.1.1`，本次仅调整界面，未递增版本号。

## 验证结果

- `npm run typecheck` 通过。
- `npm run build` 通过。
