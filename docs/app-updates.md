# 应用内更新

Windows 安装版支持检查、下载、安装并重启更新。应用启动 10 秒后检查 GitHub 的正式版本，运行期间每 4 小时再检查一次；只接受比当前版本更新的正式版本。

发现新版本时弹出更新窗口，左上角 Logo 旁持续显示「发现更新」。关闭弹窗后仍可点击该入口查看更新。点击「立即更新」下载，下载进度同步显示在弹窗和 Logo 旁；下载期间可以关闭弹窗继续工作。下载完成后提示「重启并更新」，点击后静默安装并重新打开应用。不会因普通退出或发现更新自动安装。

更新窗口打开时会隐藏嵌入网页，避免网页遮挡更新窗口。侧边栏收起时保留图标入口；窄窗口下标题栏也提供更新入口。网络失败时显示错误并支持重试；检查和下载通过 Electron 更新专用网络会话，默认使用系统代理，也可用 `SYDNEY_UPDATE_PROXY`、`HTTPS_PROXY` 或 `HTTP_PROXY` 指定代理；下载文件由 electron-updater 校验完整性。

开发模式与便携版会显示原因，不执行安装替换。首次使用该功能需要安装 v0.1.5 或之后的安装版；更早、未包含更新逻辑的应用仍需手动安装一次。

## 发布新版本

1. 同时修改 `package.json` 与 `package-lock.json` 的应用版本。
2. 运行 `npm run typecheck`、`node --experimental-strip-types --test desktop/test/app-updater.test.ts` 和 `npm run dist`。
3. 提交代码，推送与版本一致的标签，例如应用版本为 `0.1.5` 时使用标签 `v0.1.5`。
4. `.github/workflows/release.yml` 在 Windows 上构建，并将安装包、便携版、安装包的 `.blockmap` 和 `latest.yml` 一起上传到 GitHub 正式 Release。

本地 `npm run dist` 只构建，不发布。应用只读取正式 Release；仅推送代码或创建未发布的草稿 Release 不会触发客户端更新提示。不要把更新清单和安装包拆到不同 Release，也不要修改同一版本的安装包内容，修订后应递增版本号。

自动更新使用 `electron-builder.yml` 中的 GitHub 发布源，不向客户端写入 GitHub Token。发布流程使用 GitHub Actions 临时提供的仓库令牌。
