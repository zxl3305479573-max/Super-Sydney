# Sydney React + TypeScript MVP Implementation Plan

> **For agentic workers:** Execute inline in this session, task-by-task, with tests before production changes.

**Goal:** Deliver the first local-first MVP slice with a React renderer, TypeScript Electron services, and an Obsidian vault configured independently from the app repository.

**Architecture:** Keep Electron as the desktop shell. Build the renderer with React and Vite; keep event storage, capture policy, settings, and vault writes in the Electron main process written in TypeScript, exposed only through a typed preload bridge. Store app data in Electron `userData`; persist an explicit vault path whose initial default is the existing legacy path referenced by the project README (`D:\33054\Documents\persornal\Sydney`), and allow the user to choose another directory.

**Tech Stack:** Electron, React, TypeScript, electron-vite, Node SQLite, node:test.

---

## Scope

This implementation covers phase one only: start/pause/stop recording, manual records, current-app/window-duration sampling, allow/block lists, local event review/edit/delete, sensitive-window filtering, and daily Markdown summary writing. Screen sampling, file watching, cloud sync, weekly summaries, content ideation, and workflow generation remain opt-in/existing later-phase capabilities and must not become prerequisites for the MVP.

## File Map

- Create `electron.vite.config.ts` for Electron main/preload and React renderer builds.
- Create `desktop/main.ts` and `desktop/preload.ts` as typed Electron entry points; retire old JS entry points after replacement is verified.
- Create `desktop/renderer/main.tsx`, `desktop/renderer/App.tsx`, `desktop/renderer/types.ts`, and `desktop/renderer/index.html` for React UI.
- Create `desktop/services/vault-path.ts` for pure, tested vault path resolution and validation.
- Create `desktop/test/vault-path.test.js` to prove the app-data path and vault path remain separate and configured vault paths are preserved.
- Update `package.json`, `package-lock.json`, `tsconfig.json`, and `.gitignore` for the typed build and test workflow.
- Update `00-系统/README.md` to document the project path, separate vault path, and current MVP behavior without relocating user notes.

## Tasks

### Task 1: Separate vault resolution from application storage

- [ ] Add failing tests for retaining an explicit vault path, using the existing legacy location as first-run default, and resolving local app data independently from the repository path.
- [ ] Run `npm test` and confirm these tests fail for the missing resolver.
- [ ] Implement the smallest typed resolver and wire settings/database/capture paths to Electron `userData` while Markdown writes and input reads target only the configured vault.
- [ ] Run focused tests and confirm the repository is never selected as the vault when the legacy path exists.

### Task 2: Set up React + TypeScript Electron build

- [ ] Add build dependencies/configuration and verify a production build fails first because React entry points are absent.
- [ ] Create the React entry and typed preload API; preserve the existing visual system and core event/review/settings actions.
- [ ] Compile main/preload/renderer and verify the packaged Electron entry resolves to generated output.

### Task 3: Complete and verify phase-one event workflow

- [ ] Add tests for duration aggregation and pending/approved/rejected event transitions.
- [ ] Ensure active-window sampling counts only allowed, non-sensitive app intervals and records no keystrokes/screenshots by default.
- [ ] Connect manual record, review/edit/delete, filters, allow/block settings, and daily summary UI to the typed IPC API.
- [ ] Run all Node tests, TypeScript checks, and production build; report Electron GUI launch separately if the current environment cannot provide a normal interactive Windows desktop.

## Completion Checks

- `npm test` exits zero.
- `npm run typecheck` exits zero.
- `npm run build` exits zero.
- Default application database/settings/captures resolve under Electron `userData`; daily Markdown writes resolve only beneath the configured external vault.
- No existing Obsidian note is moved, overwritten during setup, or read unless needed by the explicitly invoked summary workflow.
