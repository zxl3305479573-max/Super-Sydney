# Sydney 自我总结进化系统

Sydney 是个人 AI 工作成长平台的桌面端 MVP。项目代码位于 `D:\Super-Sydney`；Obsidian 知识库保持独立，首启默认使用旧项目文档记录的 `D:\33054\Documents\persornal\Sydney`，也可以在桌面端“隐私与设置”中选择其他目录。应用会拒绝把项目目录本身用作知识库。

## 首阶段功能

- Electron + React + TypeScript 桌面端。
- SQLite 事件数据和设置保存在 Electron `userData`，不写入项目目录或知识库。
- 显式开始、暂停、继续、停止应用活动记录；默认停止。
- 只采集允许应用的名称、窗口标题和使用时长，敏感窗口和禁止应用会被跳过。
- 支持手动记录、事件确认/忽略/修改/删除。
- 可将当日事件写入知识库的 `02-每日总结/YYYY-MM-DD.md`；只更新 Sydney 标记区块，保留文件其他手工内容。
- 可在隐私设置中显式启用 Codex 桌面端对话采集。只有 Sydney 正在记录时，才会监听 `~/.codex/sessions` 此后新增的用户提示词与 `final_answer` 最终答复。

Codex 对话采集默认关闭，不回填历史，不读取 `archived_sessions`，不保存 analysis、commentary、工具调用、工具输出或终端内容。采集结果只进入本地待确认事件，带有“敏感内容，仅本地”标识；删除 Sydney 事件不会删除 Codex 原会话。Codex 事件不会自动写入日报、工作流或云同步载荷。

## DeepSeek AI 整理

DeepSeek 整理默认关闭，只有用户在设置中打开“允许发送到 DeepSeek”，并在单条待确认事件上点击“AI 整理”时才会发起请求。Codex 事件只发送用户提示词和 Codex 面向用户展示的最终答复；工具调用、终端输出、会话路径和其他本地元数据不会发送。模型结果只作为本地草稿保存，必须人工应用和确认后才进入后续沉淀流程。

在启动桌面端前配置 OpenAI 兼容环境变量：

```powershell
$env:SYDNEY_LLM_BASE_URL = "https://api.deepseek.com/v1"
$env:SYDNEY_LLM_API_KEY = "your-deepseek-api-key"
$env:SYDNEY_LLM_MODEL = "deepseek-chat"
npm start
```

API key 只在 Electron 主进程环境中读取，不写入设置文件、SQLite、Obsidian 或云端。

首阶段不采集键盘输入、屏幕画面、私人聊天和密码；不启用云端同步。AI 整理、文件关联、截图、周报、内容选题和工作流生成属于后续迭代，不能把当前界面中尚未接入的旧版能力当作已交付功能。

## 运行与验证

```powershell
cd D:\Super-Sydney
npm install
npm test
npm run typecheck
npm run build
npm start
```

Node/Python 本地进化脚本仍可单独运行：

```powershell
python .\scripts\evolve.py --vault D:\33054\Documents\persornal\Sydney --dry-run
```
