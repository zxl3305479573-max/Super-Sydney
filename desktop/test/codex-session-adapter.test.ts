import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexSessionAdapter, JsonlByteTail, shouldRunCodexCapture } from '../services/codex-session-adapter.ts';

const meta = JSON.stringify({ type: 'session_meta', payload: { originator: 'Codex Desktop', session_id: 'session-1', cwd: 'D:/work' } });
const user = JSON.stringify({ type: 'response_item', payload: { type: 'message', id: 'user-1', role: 'user', content: [{ type: 'input_text', text: '你好 Sydney' }] } });
const answer = JSON.stringify({ type: 'response_item', payload: { type: 'message', id: 'assistant-1', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '你好' }] } });

test('tails only complete UTF-8 JSONL records and retains an incomplete line', () => {
  const tail = new JsonlByteTail();
  const first = Buffer.from(`${JSON.stringify({ text: '你好' })}\n{"next":`, 'utf8');
  assert.deepEqual(tail.append(first), [JSON.stringify({ text: '你好' })]);
  assert.deepEqual(tail.append(Buffer.from('true}\n', 'utf8')), ['{"next":true}']);
  assert.equal(tail.offset, first.length + Buffer.byteLength('true}\n'));
});

test('capture runs only when explicit opt-in and recording are both active', () => {
  assert.equal(shouldRunCodexCapture(false, true, false), false);
  assert.equal(shouldRunCodexCapture(true, false, false), false);
  assert.equal(shouldRunCodexCapture(true, true, true), false);
  assert.equal(shouldRunCodexCapture(true, true, false), true);
});

test('bootstraps old session at EOF and only emits appended Codex Desktop messages once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-codex-'));
  const session = path.join(root, 'active.jsonl');
  const emitted: string[] = [];
  fs.writeFileSync(session, `${meta}\n${user}\n`, 'utf8');
  const adapter = new CodexSessionAdapter(root, message => emitted.push(message.text), undefined, 60_000);
  try {
    adapter.start();
    adapter.scanOnce();
    assert.deepEqual(emitted, []);
    fs.appendFileSync(session, `${answer}\n${answer}\n`, 'utf8');
    adapter.scanOnce();
    assert.deepEqual(emitted, ['你好']);
  } finally {
    adapter.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('discovers a newly created desktop session but ignores another originator', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-codex-'));
  const emitted: string[] = [];
  const adapter = new CodexSessionAdapter(root, message => emitted.push(message.text), undefined, 60_000);
  try {
    adapter.start();
    const newSession = path.join(root, 'new.jsonl');
    fs.writeFileSync(newSession, `${meta}\n${user}\n`, 'utf8');
    adapter.scanOnce();
    assert.deepEqual(emitted, ['你好 Sydney']);
    const cliMeta = JSON.stringify({ type: 'session_meta', payload: { originator: 'Codex CLI' } });
    fs.writeFileSync(path.join(root, 'cli.jsonl'), `${cliMeta}\n${user}\n`, 'utf8');
    adapter.scanOnce();
    assert.deepEqual(emitted, ['你好 Sydney']);
  } finally {
    adapter.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restart baselines to EOF and skips content written while stopped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-codex-'));
  const session = path.join(root, 'active.jsonl');
  const emitted: string[] = [];
  fs.writeFileSync(session, `${meta}\n`, 'utf8');
  const adapter = new CodexSessionAdapter(root, message => emitted.push(message.text), undefined, 60_000);
  try {
    adapter.start();
    fs.appendFileSync(session, `${user}\n`, 'utf8');
    adapter.scanOnce();
    assert.deepEqual(emitted, ['你好 Sydney']);
    adapter.stop();
    fs.appendFileSync(session, `${answer}\n`, 'utf8');
    adapter.start();
    adapter.scanOnce();
    assert.deepEqual(emitted, ['你好 Sydney']);
    fs.appendFileSync(session, `${user.replace('user-1', 'user-2')}\n`, 'utf8');
    adapter.scanOnce();
    assert.deepEqual(emitted, ['你好 Sydney', '你好 Sydney']);
  } finally {
    adapter.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
