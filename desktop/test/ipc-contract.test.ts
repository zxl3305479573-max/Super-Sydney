import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// IPC 契约：主进程注册的 handler 与 preload 暴露的 invoke 必须一一对应，参数个数一致。
// 不启动 Electron，直接静态扫描源码；拆分 main.ts 时用它防止漏挂通道或改错参数顺序。

const desktopDir = path.resolve(import.meta.dirname, '..');

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if ('([{<'.includes(char)) depth += 1;
    if (')]}>'.includes(char)) depth -= 1;
    if (char === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += char;
  }
  if (current.trim()) parts.push(current);
  return parts.map(part => part.trim()).filter(Boolean);
}

function mainSources(): string[] {
  const files = [path.join(desktopDir, 'main.ts')];
  const ipcDir = path.join(desktopDir, 'ipc');
  if (fs.existsSync(ipcDir)) {
    for (const name of fs.readdirSync(ipcDir)) if (name.endsWith('.ts')) files.push(path.join(ipcDir, name));
  }
  return files.map(file => fs.readFileSync(file, 'utf8'));
}

function handlerArity(): Map<string, number> {
  const result = new Map<string, number>();
  const pattern = /ipcMain\.handle\('([^']+)',\s*(?:async\s*)?\(([^)]*)\)/g;
  for (const source of mainSources()) {
    for (const match of source.matchAll(pattern)) {
      assert.ok(!result.has(match[1]), `重复注册的通道：${match[1]}`);
      const params = splitTopLevel(match[2]);
      result.set(match[1], Math.max(0, params.length - 1));
    }
  }
  return result;
}

function preloadArity(): Map<string, number> {
  const source = fs.readFileSync(path.join(desktopDir, 'preload.ts'), 'utf8');
  const result = new Map<string, number>();
  for (const match of source.matchAll(/ipcRenderer\.invoke\('([^']+)'((?:,[^)]*)?)\)/g)) {
    result.set(match[1], splitTopLevel(match[2].replace(/^,/, '')).length);
  }
  return result;
}

test('every preload invoke has a main-process handler with the same arity', () => {
  const handlers = handlerArity();
  const invokes = preloadArity();
  assert.ok(handlers.size > 0 && invokes.size > 0, '扫描结果为空，正则可能已失效');
  assert.deepEqual([...invokes.keys()].sort(), [...handlers.keys()].sort());
  for (const [channel, count] of invokes) {
    assert.equal(handlers.get(channel), count, `${channel} 参数个数不一致：preload ${count}，handler ${handlers.get(channel)}`);
  }
});

test('video publisher IPC contract exposes view controls and batch publishing', () => {
  const handlers = handlerArity();
  const invokes = preloadArity();
  const expected: Record<string, number> = {
    'video-publish:view:state': 1,
    'video-publish:view:open': 1,
    'video-publish:view:close': 0,
    'video-publish:view:bounds': 1,
    'video-publish:view:navigate': 2,
    'video-publish:view:go': 2,
    'video-publish:view:external': 1,
    'video-publish:run': 3
  };
  for (const [channel, arity] of Object.entries(expected)) {
    assert.equal(handlers.get(channel), arity, `${channel} 主进程参数数量不符合发布契约`);
    assert.equal(invokes.get(channel), arity, `${channel} preload 参数数量不符合发布契约`);
  }
});

test('app update IPC is exposed only through the main renderer contract', () => {
  const handlers = handlerArity();
  const invokes = preloadArity();
  const expected: Record<string, number> = {
    'app-update:state': 0,
    'app-update:check': 0,
    'app-update:download': 0,
    'app-update:install': 0
  };
  for (const [channel, arity] of Object.entries(expected)) {
    assert.equal(handlers.get(channel), arity, `${channel} 主进程参数数量不符合更新契约`);
    assert.equal(invokes.get(channel), arity, `${channel} preload 参数数量不符合更新契约`);
  }
  const preload = fs.readFileSync(path.join(desktopDir, 'preload.ts'), 'utf8');
  assert.match(preload, /onAppUpdateChanged:\s*callback\s*=>\s*\{[\s\S]*?ipcRenderer\.on\('app-update:changed'/);
  assert.match(preload, /onAppUpdateChanged:[\s\S]*?return\s*\(\)\s*=>\s*ipcRenderer\.removeListener\('app-update:changed'/);
});
