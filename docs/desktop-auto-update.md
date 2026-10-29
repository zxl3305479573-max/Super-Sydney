# Windows 桌面端自动更新

Sydney 使用 `electron-updater` 从 GitHub Releases 检查 Windows 的 NSIS 安装包更新。应用启动 10 秒后自动检查；发现新版本时由用户确认下载，下载完成后可立即重启安装，或在下次正常退出时安装。开发模式和未打包的运行不会访问 GitHub Releases。

渲染进程也可以调用 `window.sydney.checkForUpdates()` 触发手动检查，便于以后在设置页增加“检查更新”按钮。

## `version` 与 `latest.yml`

`package.json` 的 `version` 是已安装应用的版本号，也是构建时 electron-builder 写入 `latest.yml` 的新版本号。`electron-updater` 下载 Release 中的 `latest.yml`，用其中的 `version` 与本机版本作 SemVer 比较；只有 Release 里的版本更高才会提示更新。

不要手工编辑 `latest.yml`。它必须和同一次构建生成的安装包及 `.blockmap` 保持一致，其中的 `path`、`sha512`、`size` 用来定位并校验安装包。

## 发版步骤

1. 在 `package.json` 将 `version` 改为比线上稳定版更高的合法 SemVer，例如 `0.1.1`。
2. 安装依赖并构建：`npm ci`，然后执行 `npm run dist`。该命令先执行 `npm run build`，再用 electron-builder 生成 Windows 安装包；它不会上传或发布远程内容。
3. 检查 `release/` 目录。为 NSIS 自动更新至少保留同一构建产生的以下文件：

   - `Sydney-Setup-<version>-x64.exe`
   - `Sydney-Setup-<version>-x64.exe.blockmap`
   - `latest.yml`

   `Sydney-Portable-<version>-x64.exe` 是给用户手动下载的便携版，不是本自动更新链路的必需资产。若构建生成它的 `.blockmap`，可一并上传供完整性保留。
4. 提交并推送代码后，创建与版本一致的 Git tag，例如 `v0.1.1`；在 GitHub 仓库创建对应的 **正式 Release**（不是 Draft）。
5. 把第 3 步的三个 NSIS 资产上传到该 Release。不要混用不同构建或不同版本生成的 `latest.yml`、Setup EXE 和 blockmap。
6. 发布 Release 后，确认其是仓库中最新的正式 Release，并且资产名称与 `latest.yml` 的 `path` 一致。

## 验证方式

1. 先安装一个较低版本的 `Sydney-Setup-<old>-x64.exe`，不要使用 portable 版验证自动更新。
2. 按上述流程发布更高版本，并确认 GitHub Release 包含 Setup EXE、其 `.blockmap` 和 `latest.yml`。
3. 启动旧版 Sydney，等待约 10 秒；应出现“发现新版本”对话框。选择下载后，下载完成会出现重启安装对话框。
4. 选择“立即重启安装”，再次打开应用后检查“关于”或 `app.getVersion()` 是否为新版本。也可选择“稍后”，正常退出应用后再启动，确认安装已完成。
5. 以 `npm run dev` 或 `npm start` 运行时，不应触发网络检查、下载或错误弹窗；`window.sydney.checkForUpdates()` 会返回 `supported: false`。

## 发版检查清单

- [ ] `package.json` 的 `version` 已递增，且 Git tag 与版本一致。
- [ ] `npm ci`、`npm run typecheck`、`npm run dist` 已在可联网的发版环境完成。
- [ ] Release 是正式发布状态，且包含 Setup EXE、对应 EXE 的 `.blockmap` 和 `latest.yml`。
- [ ] `latest.yml` 来自本次构建，`version`、`path`、`sha512` 均未手改。
- [ ] 已用已安装的旧 NSIS 版本完成一次升级验证。
