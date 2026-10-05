# DeepSeek 密钥安全管理实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Sydney 设置页提供 DeepSeek API Key 的加密保存、替换、删除和掩码状态管理。

**Architecture:** Electron 主进程通过独立 `secret-store` 使用 `safeStorage` 管理加密文件；renderer 只通过有限 IPC 提交新 key 和读取状态。DeepSeek 请求优先使用程序内解密 key，删除后回退到环境变量。

**Tech Stack:** Electron `safeStorage`、Node 文件 API、React、TypeScript、Node 内置测试。

---

### Task 1: 安全存储服务和测试

**Files:**
- Create: `desktop/services/secret-store.ts`
- Create: `desktop/test/secret-store.test.ts`

- [ ] 写入失败测试：fake `safeStorage` 不可用时拒绝保存；保存时只写入密文；状态返回 `configured`、掩码和加密可用性；替换、删除和损坏文件覆盖。
- [ ] 实现 `SecretStore`，构造参数为目录、`safeStorage` 适配器和文件名；导出 `getStatus()`、`save(value)`、`read()`、`remove()`；密文以专用文件保存，写入使用临时文件再 rename，状态读取不返回明文。
- [ ] 测试程序内 key 优先于环境变量的解析函数 `resolveLlmApiKey(stored, env)`。
- [ ] 运行 `node --experimental-strip-types --test desktop/test/secret-store.test.ts`，确认通过。
- [ ] 提交：`新增 DeepSeek 安全密钥存储服务`。

### Task 2: 类型、主进程 IPC 和 DeepSeek 请求接入

**Files:**
- Modify: `desktop/shared.ts`
- Modify: `desktop/main.ts`
- Modify: `desktop/preload.ts`
- Modify: `desktop/services/deepseek.ts`
- Create: `desktop/test/llm-key-resolution.test.ts`

- [ ] 增加 `LlmKeyStatus` 和 `SydneyApi` 的 `getLlmKeyStatus`、`saveLlmKey`、`deleteLlmKey` 类型。
- [ ] 在 Electron `userData` 初始化后创建 `SecretStore`；注册 `llm-key:status`、`llm-key:save`、`llm-key:delete`，只返回状态，保存参数不回传。
- [ ] DeepSeek 整理请求使用 `secretStore.read()`，为空时回退 `process.env.SYDNEY_LLM_API_KEY`，不改变现有模型/Base URL配置。
- [ ] preload 只暴露三个密钥方法，不暴露任意 IPC 或文件接口。
- [ ] 测试 stored key 优先、stored key 删除后 env fallback、无 key 返回配置错误。
- [ ] 运行 `npm test` 和 `npm run typecheck`，通过后提交：`接入 DeepSeek 密钥 IPC 和请求优先级`。

### Task 3: 设置页 UI

**Files:**
- Modify: `desktop/renderer/App.tsx`
- Modify: `desktop/styles.css`

- [ ] 设置加载时调用 `getLlmKeyStatus()`，只保存状态和临时输入值。
- [ ] 增加密码输入框、保存/替换按钮、删除按钮、掩码状态和 safeStorage 不可用提示。
- [ ] 保存成功后清空输入并刷新状态；失败时清空输入并显示错误。
- [ ] 删除前使用浏览器确认对话框；删除后刷新状态。
- [ ] 样式保持现有白色主题，密钥输入不在事件列表或 toast 中显示。
- [ ] 运行 `npm run typecheck` 和 `npm run build`，提交：`增加 DeepSeek 密钥管理界面`。

### Task 4: 文档、回归验证和 Windows 冒烟测试

**Files:**
- Modify: `00-系统/README.md`
- Test: `desktop/test/`

- [ ] 文档说明程序内配置优先、safeStorage 加密、删除后环境变量回退，提醒旧 key 暴露后应撤销。
- [ ] 运行 `npm test`、`npm run typecheck`、`npm run build`。
- [ ] 使用 `npm start` 启动 Windows Electron，确认设置页只显示掩码，不回显 key；关闭应用后检查状态仍为已配置。
- [ ] 提交：`补充 DeepSeek 密钥管理文档和验证`。

## 自检

- 覆盖了 safeStorage 可用性、密文落盘、主进程读取、IPC 隔离、环境变量回退、UI 管理和回归验证。
- 不涉及 Base URL、模型切换、多 provider、导出或明文回退。
