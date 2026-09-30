# DeepSeek 事件整理草稿实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Electron + React + TypeScript 桌面端中接入 DeepSeek，为单条待确认事件生成仅保存在本地的结构化 AI 整理草稿。

**Architecture:** Electron 主进程通过独立的 `deepseek.ts` 服务调用 OpenAI 兼容的 DeepSeek API；React 只通过 preload IPC 触发整理。SQLite 保存草稿 JSON、模型和时间，原始 Codex 提示词/最终答复不变，且默认关闭外发开关。

**Tech Stack:** Electron 44、TypeScript、React 19、Node `fetch`、`node:sqlite`、Node 内置测试运行器。

---

## 文件职责

- `desktop/services/deepseek.ts`：DeepSeek 请求、超时、响应解析和 `EventDraft` 标准化，不依赖 SQLite。
- `desktop/services/ai-draft-store.ts`：AI 草稿字段迁移、保存、读取、应用和清除。
- `desktop/shared.ts`：共享事件草稿、设置和 IPC 类型。
- `desktop/services/app-settings.ts`：`llmEnabled` 默认值和旧配置合并。
- `desktop/main.ts`：注册 AI IPC，读取最小事件输入，调用服务并更新本地数据库。
- `desktop/preload.ts`：只暴露 `draftEvent`、`applyDraft`、`clearDraft` 三个安全方法。
- `desktop/renderer/App.tsx`：设置开关、AI 整理按钮、草稿查看/应用/删除交互。
- `desktop/test/deepseek.test.ts`：DeepSeek 服务的请求和错误测试。
- `desktop/test/ai-draft-store.test.ts`：草稿迁移和本地状态测试。

### Task 1: 定义共享类型和默认设置

**Files:**
- Modify: `desktop/shared.ts`
- Modify: `desktop/services/app-settings.ts`
- Test: `desktop/test/app-settings.test.ts`

- [ ] **Step 1: Write the failing settings/type test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, mergeSettings } from '../services/app-settings.ts';

test('LLM sending is disabled by default and survives settings merge', () => {
  assert.equal(defaultSettings('D:/Vault', 'D:/Project').llmEnabled, false);
  assert.equal(mergeSettings({ llmEnabled: true }, 'D:/Vault', 'D:/Project').llmEnabled, true);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --experimental-strip-types --test desktop/test/app-settings.test.ts`

Expected: FAIL because `Settings` and `defaultSettings` do not yet define `llmEnabled`.

- [ ] **Step 3: Add shared `EventDraft` and AI fields**

In `desktop/shared.ts`, add:

```ts
export type EventDraft = {
  what_done: string;
  why: string;
  tools: string;
  problems: string;
  solution: string;
  result: string;
  reuse: string;
  category: string;
  content_candidate: boolean;
};
```

Add `ai_draft_json`, `ai_draft_model`, and `ai_drafted_at` to `WorkEvent`; add `llmEnabled: boolean` to `Settings`. Extend `SydneyApi` with:

```ts
draftEvent(id: number): Promise<EventDraft>;
applyDraft(id: number): Promise<void>;
clearDraft(id: number): Promise<void>;
```

- [ ] **Step 4: Add the default and merge setting**

Set `llmEnabled: false` in `defaultSettings`. `mergeSettings` already spreads persisted values over defaults, so existing settings files inherit the safe default.

- [ ] **Step 5: Run the focused test and typecheck**

Run: `node --experimental-strip-types --test desktop/test/app-settings.test.ts` and `npm run typecheck`.

Expected: PASS and no TypeScript errors.

- [ ] **Step 6: Commit the type/settings boundary**

```powershell
git add desktop/shared.ts desktop/services/app-settings.ts desktop/test/app-settings.test.ts
git commit -m "定义 DeepSeek 草稿类型和隐私开关" -m "- 增加事件草稿字段和 IPC 类型" -m "- 默认关闭向 DeepSeek 发送内容"
```

### Task 2: Implement and test the DeepSeek client

**Files:**
- Create: `desktop/services/deepseek.ts`
- Test: `desktop/test/deepseek.test.ts`

- [ ] **Step 1: Write failing client tests**

Create tests with an injected `fetch` mock covering successful parsing, request minimization, missing key, non-2xx response, and malformed JSON:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { requestEventDraft, type DeepSeekInput } from '../services/deepseek.ts';

const input: DeepSeekInput = { prompt: '实现登录', response: '已完成登录流程' };
const draft = { what_done: '实现登录', why: '完成用户认证', tools: 'Codex', problems: '', solution: '增加认证流程', result: '登录可用', reuse: '沉淀为认证模板', category: '工作项目', content_candidate: true };

test('sends only prompt and final response and normalizes the JSON result', async () => {
  let body = '';
  const result = await requestEventDraft(input, { apiKey: 'key', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }, async (_url, init) => {
    body = String(init?.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(draft) } }] }), { status: 200 });
  });
  assert.deepEqual(result, draft);
  assert.match(body, /实现登录/);
  assert.match(body, /已完成登录流程/);
  assert.doesNotMatch(body, /session|path|tool_output/i);
});

test('rejects before fetch when API key is missing', async () => {
  let called = false;
  await assert.rejects(() => requestEventDraft(input, { apiKey: '', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }, async () => { called = true; return new Response('{}'); }), /API key/);
  assert.equal(called, false);
});

test('reports HTTP and response-format failures', async () => {
  const config = { apiKey: 'key', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' };
  await assert.rejects(() => requestEventDraft(input, config, async () => new Response('failure', { status: 401 })), /401/);
  await assert.rejects(() => requestEventDraft(input, config, async () => new Response('{"choices":[{"message":{"content":"not json"}}]}', { status: 200 })), /JSON/);
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `node --experimental-strip-types --test desktop/test/deepseek.test.ts`

Expected: FAIL because `desktop/services/deepseek.ts` does not exist.

- [ ] **Step 3: Implement the minimal client**

Export `DeepSeekConfig`, `DeepSeekInput`, `EventDraft`, and `requestEventDraft(input, config, fetchImpl = fetch)`. Validate `apiKey`, `baseUrl`, and `model`; call `${baseUrl.replace(/\/$/, '')}/chat/completions` with a 30-second `AbortController`; send a system prompt that requires the nine snake_case fields and the five existing categories. Parse `choices[0].message.content`, strip an optional Markdown JSON fence, require an object, fill missing string fields with `''`, coerce `content_candidate` to a boolean, and use `个人成长` for an invalid category. Throw errors containing only configuration, HTTP status, timeout, or format information.

- [ ] **Step 4: Run the client tests**

Run: `node --experimental-strip-types --test desktop/test/deepseek.test.ts`

Expected: all DeepSeek client tests PASS.

- [ ] **Step 5: Commit the isolated client**

```powershell
git add desktop/services/deepseek.ts desktop/test/deepseek.test.ts
git commit -m "接入 DeepSeek 结构化整理客户端" -m "- 增加 OpenAI 兼容请求和超时处理" -m "- 校验并标准化九字段事件草稿"
```

### Task 3: Add local AI draft storage and migrations

**Files:**
- Create: `desktop/services/ai-draft-store.ts`
- Test: `desktop/test/ai-draft-store.test.ts`
- Modify: `desktop/main.ts`

- [ ] **Step 1: Write failing storage tests**

Use an in-memory `events` table matching the existing base schema. Test migration columns, saving a draft, applying it to `summary`/`category`, and clearing it without changing `status`.

```ts
test('stores, applies, and clears a draft without approving the event', () => {
  const db = database();
  const id = Number(db.prepare("INSERT INTO events (created_at, kind, status) VALUES ('2026-09-30T00:00:00Z', 'codex', 'pending')").run().lastInsertRowid);
  saveAiDraft(db, id, draft, 'deepseek-chat', '2026-09-30T01:00:00Z');
  let row = db.prepare('SELECT * FROM events WHERE id=?').get(id) as Record<string, unknown>;
  assert.equal(JSON.parse(String(row.ai_draft_json)).what_done, '实现登录');
  assert.equal(row.status, 'pending');
  applyAiDraft(db, id);
  row = db.prepare('SELECT * FROM events WHERE id=?').get(id) as Record<string, unknown>;
  assert.equal(row.summary, '已完成登录流程');
  assert.equal(row.category, '工作项目');
  clearAiDraft(db, id);
  row = db.prepare('SELECT * FROM events WHERE id=?').get(id) as Record<string, unknown>;
  assert.equal(row.ai_draft_json, '');
  assert.equal(row.status, 'pending');
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --experimental-strip-types --test desktop/test/ai-draft-store.test.ts`

Expected: FAIL because the storage module and migration do not exist.

- [ ] **Step 3: Implement the storage module**

Export `migrateAiDraftColumns(db)`, `saveAiDraft(db, id, draft, model, draftedAt)`, `applyAiDraft(db, id)`, and `clearAiDraft(db, id)`. Add missing columns with `ALTER TABLE`; save JSON with `JSON.stringify`; when applying, set `summary` to `result || what_done` and `category` only when it is one of `工作项目`, `AI 工具`, `提效方案`, `内容资产`, or `个人成长`; never update `status`.

- [ ] **Step 4: Call the migration during Electron startup**

Import `migrateAiDraftColumns` in `desktop/main.ts` and call it immediately after `migrateCodexEventColumns(db)` so existing user databases receive the new columns before state queries.

- [ ] **Step 5: Run storage tests and typecheck**

Run: `node --experimental-strip-types --test desktop/test/ai-draft-store.test.ts` and `npm run typecheck`.

Expected: PASS with no type errors.

- [ ] **Step 6: Commit local persistence**

```powershell
git add desktop/services/ai-draft-store.ts desktop/test/ai-draft-store.test.ts desktop/main.ts
git commit -m "增加 AI 草稿本地存储和数据库迁移" -m "- 保存模型、生成时间和结构化 JSON" -m "- 支持人工应用或清除草稿且不改变事件状态"
```

### Task 4: Wire DeepSeek through main process and preload IPC

**Files:**
- Modify: `desktop/main.ts`
- Modify: `desktop/preload.ts`
- Modify: `desktop/shared.ts`

- [ ] **Step 1: Add the IPC behavior tests at the service boundary**

Keep network and database concerns separately testable by adding a small `buildDeepSeekInput(event)` function in `main.ts` or a new `desktop/services/ai-draft-input.ts`. Test that a Codex event returns only `{ prompt: codex_prompt, response: codex_response }`, while no session id, path, or other metadata appears in the serialized input.

- [ ] **Step 2: Implement the IPC handlers**

Register:

```ts
ipcMain.handle('event:draft', async (_event, id: number) => { /* validate setting, read event, call requestEventDraft, saveAiDraft, broadcast */ });
ipcMain.handle('event:draft:apply', (_event, id: number) => { applyAiDraft(db, id); broadcast(); });
ipcMain.handle('event:draft:clear', (_event, id: number) => { clearAiDraft(db, id); broadcast(); });
```

`event:draft` must reject when `llmEnabled` is false, the event is missing, the event is not `pending`, or `SYDNEY_LLM_API_KEY` is absent. Use defaults for base URL/model when their environment variables are absent. For Codex events pass only prompt/response; for other events pass the manual note and window title. Save the returned model and an ISO timestamp, then return the draft.

- [ ] **Step 3: Expose only typed preload methods**

Add `draftEvent`, `applyDraft`, and `clearDraft` to the context bridge with `ipcRenderer.invoke`. Do not expose `fetch`, environment values, database handles, or arbitrary IPC channels.

- [ ] **Step 4: Run typecheck and existing tests**

Run: `npm run typecheck` and `npm test`.

Expected: all existing tests and new service/storage tests PASS.

- [ ] **Step 5: Commit the IPC boundary**

```powershell
git add desktop/main.ts desktop/preload.ts desktop/shared.ts
git commit -m "通过安全 IPC 接入 DeepSeek 整理流程" -m "- 增加待确认事件整理、应用和清除接口" -m "- 限制 Codex 外发内容为提示词和最终答复"
```

### Task 5: Add the React settings and draft review UI

**Files:**
- Modify: `desktop/renderer/App.tsx`
- Modify: `desktop/styles.css`

- [ ] **Step 1: Add the settings toggle**

In the settings view, add a checkbox bound to `state.settings.llmEnabled`. Save through `window.sydney.saveSettings({ llmEnabled: checked })`; show text that only a user-clicked AI整理 request sends the current event to DeepSeek and that the setting is off by default.

- [ ] **Step 2: Add event actions and draft details**

Extend `EventRow` props with `onDraft`, `onApplyDraft`, and `onClearDraft`. For pending events show `AI 整理`; when `event.ai_draft_json` is non-empty, parse it defensively and render an expandable details block with all nine fields, model, and timestamp. Add buttons `应用到摘要` and `删除草稿`; neither button changes the event status automatically.

- [ ] **Step 3: Add loading/error feedback**

In `App`, keep a `draftingId` state to disable the active button while waiting. Catch rejected IPC calls and show the returned message in the existing toast. On success refresh state and show `AI 草稿已保存`.

- [ ] **Step 4: Add restrained white-theme styling**

Reuse existing white variables and add only focused styles for `.ai-draft`, `.ai-draft-grid`, `.ai-draft-actions`, and a disabled AI button. Keep the event row width stable and ensure long prompt/response text wraps inside the details block.

- [ ] **Step 5: Run build and tests**

Run: `npm test`, `npm run typecheck`, and `npm run build`.

Expected: all tests PASS, TypeScript emits no errors, and electron-vite produces `out/main/main.js` and renderer assets.

- [ ] **Step 6: Commit the UI**

```powershell
git add desktop/renderer/App.tsx desktop/styles.css
git commit -m "增加 DeepSeek 草稿审核界面" -m "- 增加隐私开关和单条事件 AI 整理按钮" -m "- 支持查看、应用和删除本地草稿"
```

### Task 6: Document configuration and perform end-to-end verification

**Files:**
- Modify: `00-系统/README.md`
- Modify: `DESIGN.md`
- Test: `desktop/test/` existing suite

- [ ] **Step 1: Document the Windows configuration**

Add the exact PowerShell setup:

```powershell
$env:SYDNEY_LLM_BASE_URL = "https://api.deepseek.com/v1"
$env:SYDNEY_LLM_API_KEY = "your-deepseek-api-key"
$env:SYDNEY_LLM_MODEL = "deepseek-chat"
npm start
```

Document that the UI toggle remains off until the user enables it, and that only a manually triggered single-event request can send Codex prompt/final answer content.

- [ ] **Step 2: Run the complete verification suite**

Run:

```powershell
npm test
npm run typecheck
npm run build
```

Expected: all tests PASS, typecheck exits 0, and build exits 0.

- [ ] **Step 3: Verify the real Electron startup without making a network request**

Run `npm start` with `SYDNEY_LLM_API_KEY` unset, confirm the window opens, the AI toggle is off, and existing capture/review flows still work. Close Electron after the smoke check.

- [ ] **Step 4: Commit documentation and verification notes**

```powershell
git add 00-系统/README.md DESIGN.md
git commit -m "补充 DeepSeek 配置和隐私边界文档" -m "- 增加 Windows 环境变量和启动示例" -m "- 记录单条事件主动发送与本地草稿规则"
```

## Self-review checklist

- Spec coverage: configuration, explicit opt-in, minimal Codex payload, local JSON draft, manual application, failure behavior, tests, and build acceptance each have a task.
- Placeholder scan: no `TBD`, `TODO`, or unspecified implementation step is used; commands and file paths are explicit.
- Type consistency: `EventDraft`, `llmEnabled`, `ai_draft_*`, `draftEvent`, `applyDraft`, and `clearDraft` are introduced in Task 1 and reused unchanged in later tasks.
