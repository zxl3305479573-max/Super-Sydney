# Grokbot → Codex 桥接

桥接服务运行在本机，接收 Grokbot 的 HTTP 任务，使用受支持的 `codex app-server` 协议启动 Codex turn，并提供轮询结果或固定回调地址。

## 启动

PowerShell：

```powershell
$env:GROK_CODEX_BRIDGE_TOKEN = "换成一段随机长令牌"
$env:GROK_CODEX_WORKSPACE = "D:\Super-Sydney"
$env:GROK_CODEX_APPROVAL_POLICY = "on-request"
$env:GROK_CODEX_SANDBOX = "workspace-write"
npm run bridge
```

默认只监听 `127.0.0.1:8787`。如需让 Grokbot 从其他机器访问，必须显式设置监听地址，并在反向代理层加 HTTPS、IP 白名单和限流；不要直接把端口暴露到公网。

默认不会自动批准 Codex 的命令或文件修改请求。确认桥接服务所在机器、工作目录和 Grokbot 请求均可信后，才可设置 `GROK_CODEX_AUTO_APPROVE=1`。

## Grokbot 请求

提交任务：

```http
POST /v1/tasks
Authorization: Bearer <GROK_CODEX_BRIDGE_TOKEN>
Content-Type: application/json

{
  "task": "检查当前项目的模型预设功能，修复测试失败并给出总结",
  "cwd": "D:\\Super-Sydney",
  "model": "gpt-5.6-sol"
}
```

服务返回 `202` 和 `taskId`（字段为 `id`）：

```http
GET /v1/tasks/<id>
Authorization: Bearer <GROK_CODEX_BRIDGE_TOKEN>
```

任务完成后，返回 `status: completed`、`threadId` 和 `output`。如果 Grokbot 支持 webhook，可设置 `GROK_CODEX_CALLBACK_URL`，桥会把相同任务对象 POST 回该地址；可选用 `GROK_CODEX_CALLBACK_TOKEN` 作为回调 Bearer token。

同一 `threadId` 可继续之前的 Codex 会话。取消任务：

```http
POST /v1/tasks/<id>?action=cancel
Authorization: Bearer <GROK_CODEX_BRIDGE_TOKEN>
```

## 当前边界

这是通过 Codex app-server 驱动本机 Codex harness 的桥，不是修改 Codex 桌面端内部文件，也不会伪造桌面端会话。每次任务都在允许的工作目录下启动一个 app-server 进程；允许目录由 `GROK_CODEX_ALLOWED_ROOTS`（用分号分隔）或 `GROK_CODEX_WORKSPACE` 控制。
