import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { VideoPlatform } from '../shared.ts';
import { createVideoProject, getVideoProject, listVideoProjects, migrateVideoTables, updateVideoProject, videoProjectFromRow } from '../services/video-store.ts';

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

test('脏数据回退：未知平台按通用，非法时长按 60 秒', () => {
  const project = videoProjectFromRow({ id: 1, platform: 'weird', duration_seconds: -5 });
  assert.equal(project.platform, 'general');
  assert.equal(project.durationSeconds, 60);
  assert.equal(project.status, 'idea');
});
