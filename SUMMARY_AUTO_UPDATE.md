# 自动更新实现摘要

## 改动文件

- `package.json`：在运行时依赖中追加 `electron-updater`。
- `package-lock.json`：同步根包的 `electron-updater` 依赖声明；请在可访问 npm 的环境执行 `npm install` 以写入完整解析记录。
- `electron-builder.yml`：配置 GitHub Releases 发布源（`zxl3305479573-max/Super-Sydney`），并为 NSIS 启用差分更新包。
- `desktop/auto-update.ts`：新增更新管理器，支持启动延迟检查、手动 IPC 检查、用户确认下载、下载进度、下载错误和重启安装。
- `desktop/main.ts`：主进程就绪后注册更新 IPC 并启动延迟检查。
- `desktop/preload.ts`、`desktop/shared.ts`：向渲染进程暴露 `window.sydney.checkForUpdates()`。
- `docs/desktop-auto-update.md`：记录版本、`latest.yml`、发版资产和验证流程。

## 本地验证

1. 在可访问 npm registry 的环境执行 `npm install`，确保安装 `electron-updater`。
2. 执行 `npm run typecheck`。
3. 执行 `npm run dist`，检查 `release/` 是否包含 `Sydney-Setup-<version>-x64.exe`、其 `.blockmap` 与 `latest.yml`。
4. 开发模式执行 `npm run dev`：不会检查更新；调用 `window.sydney.checkForUpdates()` 应返回 `supported: false`。
5. 完整升级验证需要安装一个旧 NSIS 版本，并在 GitHub Releases 发布更高版本的同组资产后启动旧版本。

## 发版 checklist

- [ ] 递增 `package.json` 中的 `version`。
- [ ] `npm ci`、`npm run typecheck`、`npm run dist` 通过。
- [ ] 创建并推送 `v<version>` tag，创建正式 GitHub Release。
- [ ] 上传本次构建的 Setup EXE、对应 `.blockmap` 和 `latest.yml`。
- [ ] 用已安装的旧 NSIS 版本验证下载、重启和版本升级。

本次未执行 `git push`。
