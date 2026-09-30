# DeepSeek 事件整理草稿设计

## 目标

为 Sydney 桌面端增加一个用户主动触发的 DeepSeek 整理入口，将本地待确认工作事件整理成结构化草稿。首版重点服务 Codex Desktop 事件：只使用已采集的用户提示词和 Codex 最终答复，不扩大采集范围。

本功能不自动确认事件、不自动写入 Obsidian、不自动同步云端。用户仍然是知识沉淀流程的最终确认者。

## 范围

首版包含：

- Electron 主进程中的 DeepSeek OpenAI 兼容客户端。
- 通过安全 IPC 为单条本地事件生成整理草稿。
- DeepSeek 配置读取：`SYDNEY_LLM_BASE_URL`、`SYDNEY_LLM_MODEL`、`SYDNEY_LLM_API_KEY`。
- 默认关闭的“允许发送到 DeepSeek”隐私设置。
- Codex 事件的最小请求内容：提示词和最终答复。
- 结构化草稿的本地保存、查看和人工应用。
- 请求、响应校验和失败提示的自动化测试。

首版不包含：

- 自动日报、周报、公众号选题或工作流生成。
- 自动发送、定时批处理或后台队列。
- API key 写入 settings、SQLite、Obsidian 或云端。
- 将工具调用、终端输出、隐藏推理、会话文件路径发送给模型。
- 自动确认事件、自动写入知识库或自动云同步。

## 架构

### 配置

DeepSeek 使用 OpenAI 兼容的 `/chat/completions` 接口。默认值为：

- `SYDNEY_LLM_BASE_URL=https://api.deepseek.com/v1`
- `SYDNEY_LLM_MODEL=deepseek-chat`

API key 只从 Electron 主进程的环境变量 `SYDNEY_LLM_API_KEY` 读取。环境变量缺失时，IPC 返回可读错误，不发起网络请求。

新增设置 `llmEnabled`，默认值为 `false`。该设置只表达用户是否允许主动调用模型，不代表自动发送或后台采集。

### 主进程服务

新增独立模块 `desktop/services/deepseek.ts`，职责包括：

- 接收已经裁剪后的事件输入和运行时配置。
- 构造系统提示词和用户内容。
- 发起带超时的 `fetch` 请求。
- 校验 HTTP 状态、响应结构和结构化 JSON。
- 返回标准化的 `EventDraft`，不直接操作 SQLite。

主进程 `desktop/main.ts` 负责：

- 读取目标事件及其 Codex 字段。
- 检查事件存在、设置已开启和环境变量完整。
- 对 Codex 事件只组装 `codex_prompt`、`codex_response`。
- 调用 DeepSeek 服务并把草稿写回该事件。
- 通过现有状态广播刷新渲染进程。

渲染进程只通过 preload 暴露的 `draftEvent(id)` 调用，不接触 API key 或网络请求。

### 本地数据

在 `events` 表增加以下字段，并提供兼容旧数据库的迁移：

- `ai_draft_json TEXT NOT NULL DEFAULT ''`
- `ai_draft_model TEXT NOT NULL DEFAULT ''`
- `ai_drafted_at TEXT NOT NULL DEFAULT ''`

原始 `codex_prompt`、`codex_response` 和事件状态保持不变。草稿 JSON 使用固定字段：

- `what_done`
- `why`
- `tools`
- `problems`
- `solution`
- `result`
- `reuse`
- `category`
- `content_candidate`

`category` 只能是现有五类知识分类之一；`content_candidate` 使用布尔值。模型返回的未知字段被忽略，缺失字段使用空字符串或 `false`。

## 用户流程

1. 用户在设置中打开“允许发送到 DeepSeek”。默认关闭。
2. 用户在待确认列表中查看一条事件。
3. 用户点击“AI 整理”。按钮明确显示内容将发送到 DeepSeek。
4. 主进程读取该事件并调用 DeepSeek。
5. 成功后，事件显示“AI 草稿”，可展开查看全部字段。
6. 用户可将草稿中的结果和分类应用到事件摘要，或继续手动修改。
7. 用户仍需单独点击“确认”，确认后才参与既有知识沉淀流程。

如果设置关闭、事件不存在、事件被删除、API key 缺失、网络失败或返回格式错误，原事件保持原状态，界面只显示失败原因。

## 隐私处理

对 `source === 'codex'` 的事件，只发送：

- 用户主动输入的提示词。
- Codex 面向用户展示的最终答复。

不发送：工具调用、工具输出、终端输出、隐藏推理、会话文件路径、source session id、数据库路径和其他本地元数据。

请求前不读取新的文件、不截图、不访问 Obsidian 知识库。DeepSeek 响应只保存到本地 SQLite 草稿字段。

## 错误处理

- API key、模型或 base URL 缺失：返回配置错误。
- 非 2xx 响应：返回包含状态码的通用错误，不暴露完整响应密文。
- 请求超时：默认 30 秒，返回超时提示。
- 响应无法解析为 JSON：返回格式错误。
- 结构化字段不符合约定：拒绝保存草稿并保留原事件。
- 任意失败：不改变 `status`，不写入 Obsidian，不触发云端同步。

## 测试策略

新增纯函数和 IPC 相关测试，覆盖：

- 默认关闭 `llmEnabled`。
- Codex 请求只包含提示词和最终答复。
- API key 缺失时不会调用 fetch。
- 成功响应被解析为标准 `EventDraft`。
- 非 2xx、超时、非法 JSON、缺失字段均返回错误且不保存草稿。
- 草稿保存后仍为 `pending`，并可读取和应用摘要/分类。
- 既有全部测试、类型检查和 Electron 构建继续通过。

## 验收标准

- 用户配置 DeepSeek 环境变量并开启隐私开关后，可以从单条待确认 Codex 事件生成草稿。
- 未开启开关、未配置 key 或请求失败时，不会产生网络请求或改变事件状态。
- 草稿在本地可见、可应用、可删除，不会自动写入 Obsidian 或云端。
- `npm test`、`npm run typecheck`、`npm run build` 全部通过。
