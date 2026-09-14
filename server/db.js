import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
export const AUDIO_DIR = path.join(DATA_DIR, 'audio');

const DB_PATH = path.join(DATA_DIR, 'readroom.db');
const MARKER_PATH = path.join(DATA_DIR, '.first-boot');

// DATA_DIR 没挂上持久卷时不会报错 —— mkdir 会在容器的临时层上把目录建出来，
// 服务照样跑，只是每次重部署静默丢掉全部音频。所以这里记录一下这块盘是不是
// 空的、第一次用是什么时候，让启动日志能把这种情况说出来。
const dbExisted = fs.existsSync(DB_PATH);

fs.mkdirSync(AUDIO_DIR, { recursive: true });

let firstBootAt = null;
try {
  firstBootAt = fs.readFileSync(MARKER_PATH, 'utf8').trim();
} catch {
  firstBootAt = new Date().toISOString();
  try {
    fs.writeFileSync(MARKER_PATH, firstBootAt);
  } catch {
    /* 盘是只读的话就算了，不影响运行 */
  }
}

/** 给启动日志用：这块盘上到底有没有上次留下的东西 */
export function storageInfo() {
  let audioCount = 0;
  try {
    audioCount = fs.readdirSync(AUDIO_DIR).filter((f) => f.endsWith('.mp3')).length;
  } catch {
    /* 读不到就算 0 */
  }
  return { dir: DATA_DIR, dbExisted, audioCount, firstBootAt };
}

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS rooms (
  id            TEXT PRIMARY KEY,
  host_token    TEXT NOT NULL,
  host_device   TEXT,
  created_at    INTEGER NOT NULL,
  locked        INTEGER NOT NULL DEFAULT 0,   -- transcript 上传后置 1，此后不可替换/删除
  title         TEXT,
  order_mode    TEXT NOT NULL DEFAULT 'ordered',  -- ordered | chaotic
  noise_mode    TEXT NOT NULL DEFAULT 'quiet',    -- quiet | noisy
  ambience_kind TEXT NOT NULL DEFAULT 'cafe',     -- cafe | airport
  ambience_url  TEXT,
  ambience_volume INTEGER NOT NULL DEFAULT 25,
  ambience_device TEXT,
  gap_ms        INTEGER NOT NULL DEFAULT 450,
  chaos_period_ms INTEGER NOT NULL DEFAULT 20000,
  duck_gain     REAL NOT NULL DEFAULT 0.5,
  status        TEXT NOT NULL DEFAULT 'idle'      -- idle | playing
);

CREATE TABLE IF NOT EXISTS lines (
  room_id  TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  idx      INTEGER NOT NULL,
  speaker  TEXT NOT NULL,
  content  TEXT NOT NULL,
  PRIMARY KEY (room_id, idx)
);

CREATE TABLE IF NOT EXISTS speakers (
  room_id      TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  voice        TEXT NOT NULL,
  config       TEXT NOT NULL,      -- JSON: {gender, age, tone, accent, pace, emotion, quirk}
  instructions TEXT NOT NULL,
  custom       INTEGER NOT NULL DEFAULT 0,  -- 1 = instructions 被手工改过，不再随下拉自动重写
  device_id    TEXT,               -- 分配到的设备
  PRIMARY KEY (room_id, name)
);

-- 全局音频缓存。key = sha256(model | voice | instructions | text)
-- 跨房间共享：同一句话 + 同一音色配置，永远只 TTS 一次。
CREATE TABLE IF NOT EXISTS audio (
  hash        TEXT PRIMARY KEY,
  duration_ms INTEGER NOT NULL,
  bytes       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id         TEXT NOT NULL,
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  is_host    INTEGER NOT NULL DEFAULT 0,
  online     INTEGER NOT NULL DEFAULT 0,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (room_id, id)
);

CREATE INDEX IF NOT EXISTS idx_lines_room ON lines(room_id);
CREATE INDEX IF NOT EXISTS idx_devices_room ON devices(room_id);
`);

// Fish 原生支持 mp3 输出，直接存 mp3 —— 比 WAV 小九倍左右
export function audioPath(hash) {
  return path.join(AUDIO_DIR, `${hash}.mp3`);
}

export function audioExists(hash) {
  return fs.existsSync(audioPath(hash));
}
