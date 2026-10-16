import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { VideoPlatform } from '../shared.ts';
import { createVideoProject, deleteVideoProject, getVideoProject, listVideoProjects, migrateVideoTables, updateVideoProject, videoProjectFromRow } from '../services/video-store.ts';

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrateVideoTables(db);
  return db;
}

test('新建视频任务校验平台并去掉选题两端空白', () => {
  const db = database();
  const project = createVideoProject(db, 'douyin', '  护膝  ');
  assert.equal(project.platform, 'douyin');
  assert.equal(project.topic, '护膝');
  assert.equal(project.durationSeconds, 60);
  assert.throws(() => createVideoProject(db, 'tiktok' as VideoPlatform, ''), /未知的视频平台/);
  assert.throws(() => getVideoProject(db, 999), /视频任务不存在/);
});

test('updateVideoProject 只写白名单字段', () => {
  const db = database();
  const created = createVideoProject(db, 'general', '');
  const updated = updateVideoProject(db, created.id, { script: '口播', durationSeconds: 90, bogus: 1 } as never);
  assert.equal(updated.script, '口播');
  assert.equal(updated.durationSeconds, 90);
  assert.equal(listVideoProjects(db).length, 1);
});

test('成片选项与素材账本以 JSON 存取，旧库补列后按默认值读出', () => {
  const db = new DatabaseSync(':memory:');
  // 模拟 2026-10-14 之前的库：没有 options_json / assets_json 两列。
  db.exec(`CREATE TABLE video_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL DEFAULT 'general', topic TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
    audience TEXT NOT NULL DEFAULT '', duration_seconds INTEGER NOT NULL DEFAULT 60, status TEXT NOT NULL DEFAULT 'idea',
    topics_json TEXT NOT NULL DEFAULT '', script TEXT NOT NULL DEFAULT '', storyboard_json TEXT NOT NULL DEFAULT '',
    cover_path TEXT NOT NULL DEFAULT '', export_path TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );`);
  db.prepare("INSERT INTO video_projects (created_at, updated_at) VALUES ('t', 't')").run();
  migrateVideoTables(db);
  const legacy = getVideoProject(db, 1);
  assert.equal(legacy.options.voiceMode, 'tts');
  assert.deepEqual(legacy.assets.audio, []);
  const updated = updateVideoProject(db, 1, {
    options: { ...legacy.options, template: 'night', bgmPath: 'D:/音乐/轻音乐.mp3' },
    assets: { ...legacy.assets, voiceProfile: 'p', audio: [{ key: 'k', path: 'a.wav', seconds: 2.5 }] }
  });
  assert.equal(updated.options.template, 'night');
  assert.equal(updated.options.bgmPath, 'D:/音乐/轻音乐.mp3');
  assert.deepEqual(updated.assets.audio, [{ key: 'k', path: 'a.wav', seconds: 2.5 }]);
  // 迁移可以重复跑。
  migrateVideoTables(db);
  assert.equal(getVideoProject(db, 1).options.template, 'night');
});

test('脏数据回退：未知平台按通用，非法时长按 60 秒', () => {
  const project = videoProjectFromRow({ id: 1, platform: 'weird', duration_seconds: -5 });
  assert.equal(project.platform, 'general');
  assert.equal(project.durationSeconds, 60);
  assert.equal(project.status, 'idea');
});

test('删除视频任务只删这一条，删不存在的会报错', () => {
  const db = database();
  const keep = createVideoProject(db, 'douyin', '留下');
  const gone = createVideoProject(db, 'douyin', '删掉');
  deleteVideoProject(db, gone.id);
  assert.deepEqual(listVideoProjects(db).map(item => item.id), [keep.id]);
  assert.throws(() => deleteVideoProject(db, gone.id), /视频任务不存在/);
});
