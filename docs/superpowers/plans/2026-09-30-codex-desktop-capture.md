# Codex Desktop Conversation Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture only new Codex Desktop user prompts and final answers as local pending Sydney events while the user has explicitly enabled capture and started recording.

**Architecture:** A typed Electron-main adapter tails only `~/.codex/sessions` JSONL files, identifies desktop sessions using first-record metadata, and processes only appended user `input_text` and assistant `final_answer/output_text` records. The adapter writes paired messages to local SQLite; renderer controls opt-in and review through the typed preload API. Pause/stop resets file offsets to current EOF; Codex events are excluded from automatic Obsidian outputs and any legacy cloud-sync query.

**Tech Stack:** Electron, TypeScript, React, Node fs, SQLite, node:test.

---

## File Map

- Create `desktop/services/codex-session.ts` for strict record parsing, text block filtering, pairing decisions, and byte-safe partial JSONL line handling.
- Create `desktop/services/codex-session-adapter.ts` for session discovery, originator metadata validation, EOF bootstrap, active incremental reads, pause/stop lifecycle, and error status.
- Create `desktop/test/codex-session.test.ts` and `desktop/test/codex-session-adapter.test.ts` for privacy, filtering, pairing, byte offsets, partial lines, no-backfill, pause/resume, and deduplication.
- Modify `desktop/main.ts` to add a Codex opt-in setting, SQLite source metadata/text columns, migration for existing local DBs, adapter lifecycle, event pairing, and daily-summary exclusion.
- Modify `desktop/shared.ts`, `desktop/preload.ts`, and `desktop/renderer/App.tsx` to expose adapter status and an explicit opt-in control with sensitive-content warning.
- Modify `desktop/main.js` only to exclude `source='codex'` rows from its legacy cloud sync and Obsidian summary queries.
- Modify `00-系统/README.md` to document Codex Desktop-only capture and privacy boundaries.

## Tasks

### Task 1: Parse supported Codex Desktop records only

- [x] Write tests using synthetic records for user `input_text`, assistant `final_answer/output_text`, and ignored analysis, commentary, tool calls, tool output, metadata, malformed JSON, and Codex CLI metadata.
- [x] Run `node --experimental-strip-types --test desktop/test/codex-session.test.ts` and verify failure because the parser module does not exist.
- [x] Implement pure functions `parseCodexRecord(line)` and `extractCodexMessage(record)` that return only `{id, role, text}` for allowed message types and `null` otherwise.
- [x] Re-run the focused test; expected result is all parser/privacy cases passing.

### Task 2: Tail appended bytes without historical backfill

- [x] Write tests for UTF-8 byte-offset slicing, partial trailing JSONL line buffering, duplicate IDs, bootstrap-to-EOF, newly-created-session processing, and stop/start skipping bytes written while stopped.
- [x] Run the focused adapter tests and confirm they fail before implementation.
- [x] Implement a tail state that advances by buffer byte length, emits only complete newline-terminated records, and discards partial carry when resetting to EOF.
- [x] Implement adapter start by attaching observation before baselining eligible existing files; read only line one for `originator: Codex Desktop`, then set its offset to file size.
- [x] Implement processing of files created after start from byte zero, requiring valid first-line desktop metadata before any message record is accepted.
- [x] Implement `pause/stop` by closing watchers/timers and clearing readers; next `start` re-discovers existing files at EOF.
- [x] Re-run focused tests and confirm no pre-start or paused bytes are emitted, while new prompt/final records are emitted once.

### Task 3: Persist paired local events and add explicit UI control

- [x] Add tests for opt-in default false, only running+enabled allows processing, prompt creates a pending event, matching final answer updates it, and source metadata distinguishes Codex events.
- [x] Run those tests and confirm failure before adding the service wiring.
- [x] Add backward-compatible SQLite columns `source`, `source_session_id`, `source_message_id`, `codex_prompt`, and `codex_response`; migrate existing app databases using checked `PRAGMA table_info` before `ALTER TABLE`.
- [x] On each user prompt, insert a pending `kind='codex'` event; on a final answer, update the newest unanswered pending event from the same session. Never create a response-only event.
- [x] Wire a default-off `codexCaptureEnabled` setting, renderer checkbox, and visible adapter status through typed IPC; start the adapter only when this setting and Sydney recording are both active.
- [x] Keep Codex content out of daily summaries and add `source <> 'codex'` to legacy sync/summary queries.
- [x] Run all tests, typecheck, and production build; launch the desktop app and verify the default switch is off and enabling it does not populate past messages.

## Completion Checks

- `npm test`, `npm run typecheck`, and `npm run build` all exit zero.
- Existing Codex messages before an opt-in/start boundary never enter SQLite.
- Only Codex Desktop user prompts and displayed final answers are persisted as local pending content.
- No tool output, history, keyboard data, screenshots, network request, or Obsidian write is produced by this adapter.
- Disabling, pausing, stopping, or restarting the app never causes a catch-up import.
