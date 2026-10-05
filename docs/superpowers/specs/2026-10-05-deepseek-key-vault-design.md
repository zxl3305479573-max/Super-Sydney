# DeepSeek API Key 程序内管理设计

## 目标

在 Sydney 桌面端设置页管理 DeepSeek API Key，免去每次通过启动终端环境变量配置密钥。密钥可新增、替换和删除；界面仅展示是否已配置和掩码状态。

## 安全边界

- API Key 只由 Electron 主进程处理，不写入 renderer 状态、settings.json、SQLite、Obsidian、项目文件或日志。
- 使用 Electron `safeStorage` 加密，密文存于 Electron `userData` 目录中的专用文件。
- 保存密钥时先确认 `safeStorage.isEncryptionAvailable()`；不可用时拒绝保存，不降级为明文。
- IPC 只接受新密钥字符串，读取状态只返回 `configured` 和掩码，不提供读取明文的接口。
- DeepSeek 请求时由主进程解密。程序内密钥优先于 `SYDNEY_LLM_API_KEY`；程序内密钥删除后可回退到环境变量。
- 网络请求、错误和日志不包含密钥内容。
- 本功能不配置或更改 DeepSeek Base URL 和模型名称。

## 用户流程

1. 设置页显示密钥状态：未配置、已配置（掩码）或系统加密不可用。
2. 用户在密码输入框粘贴新 key，点击保存/替换。
3. preload 经有限的安全 IPC 将 key 交给主进程；主进程验证非空并通过 `safeStorage` 加密落盘。
4. 保存成功后清空输入框并刷新掩码状态。不得将输入值回传给 renderer。
5. 用户可删除程序内保存的 key；删除后 DeepSeek 调用可使用启动环境变量作为后备。
6. DeepSeek 整理仍需用户主动开启隐私开关并点击单条事件的“AI 整理”。

## 模块边界

- 新增 `desktop/services/secret-store.ts`，封装安全存储文件读写、加密可用性检查、保存、读取、状态掩码和删除。
- `desktop/main.ts` 初始化 `userData` 后注入秘密存储；增加 `llm-key:status`、`llm-key:save`、`llm-key:delete` IPC；发起整理请求时调用秘密存储读取 API Key。
- `desktop/preload.ts` 暴露 `getLlmKeyStatus`、`saveLlmKey`、`deleteLlmKey`，不暴露任意文件或 IPC 能力。
- `desktop/shared.ts` 定义仅含状态和掩码的 `LlmKeyStatus` 以及对应 API 类型。
- `desktop/renderer/App.tsx` 设置页提供密码输入、保存/替换、删除和状态展示；输入只存在于组件内存，保存或失败后清空。

## 错误处理

- safeStorage 不可用：阻止写入并显示系统凭据加密不可用，不保存明文。
- 空 key：在主进程拒绝。
- 密文文件丢失或损坏：状态按未配置处理，并允许重新保存；读取错误不输出密文或解密值。
- 密钥保存失败：保留现有密钥文件，提示失败。
- 删除失败：保留状态并提示失败。
- API Key 缺失：DeepSeek 请求返回原有配置错误，不改变事件状态。

## 测试和验收

- 用可注入 fake `safeStorage` 和临时目录测试保存后只存在密文、读取仅限主进程、掩码、替换、删除、加密不可用和损坏文件行为。
- 测试环境变量后备和程序内 key 优先规则。
- 验证 IPC/renderer 的状态类型不包含明文密钥。
- `npm test`、`npm run typecheck`、`npm run build` 通过。
- Windows Electron 启动后可保存新生成的 DeepSeek key；重启后状态仍为已配置；UI 不回显明文。

## 不在本次范围

- 切换 Base URL 或模型。
- 管理多个 provider 或多个 key。
- 导出、同步、备份密钥。
- 明文存储或自制加密回退方案。
