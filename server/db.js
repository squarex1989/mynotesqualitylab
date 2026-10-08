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
  ambience_url_cafe    TEXT,                 -- 每个场景各存一份链接，切换场景不会互相覆盖
  ambience_url_airport TEXT,
  ambience_volume INTEGER NOT NULL DEFAULT 10,
  ambience_device TEXT,
  tts_model     TEXT,                            -- 每个房间可以自己选免费/付费模型
  capture_device TEXT,                           -- 已废弃：收音设备改成按设备记（devices.capture），列留着不再读写
  glossary      TEXT,                            -- 人名/产品名，每行一个；打分时按关键词加权
  gap_ms        INTEGER NOT NULL DEFAULT 450,
  chaos_period_ms INTEGER NOT NULL DEFAULT 20000,
  duck_gain     REAL NOT NULL DEFAULT 0.5,
  status        TEXT NOT NULL DEFAULT 'idle',     -- idle | playing
  owner_id      TEXT                              -- 建房的账号（users.id）；账号体系之前的房间为空
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
  volume       INTEGER NOT NULL DEFAULT 100, -- 播放增益百分比，模拟离麦克风远近；不进音频哈希
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

-- 收音设备上传的各产品转录，以及两个裁判模型的打分。
-- 一个房间 × 一个产品 一行；重新跑分就整行覆盖。
CREATE TABLE IF NOT EXISTS comparisons (
  room_id     TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  product     TEXT NOT NULL,          -- my-notes | granola | otter
  transcript  TEXT NOT NULL,          -- 该产品录出来的文本（可以是空串：只贴了 summary）
  summary     TEXT,                   -- 该产品生成的会议摘要；评估逻辑后补
  result      TEXT,                   -- JSON：两个裁判各自的分数和简报
  state       TEXT NOT NULL DEFAULT 'idle',  -- idle | scoring | done | failed
  error       TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (room_id, product)
);

CREATE TABLE IF NOT EXISTS devices (
  id         TEXT NOT NULL,
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  is_host    INTEGER NOT NULL DEFAULT 0,
  capture    INTEGER NOT NULL DEFAULT 0,   -- 1 = 收音设备：只负责录、贴转录，绝不分配台词
  online     INTEGER NOT NULL DEFAULT 0,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (room_id, id)
);

-- 账号：Google 登录。游客不需要账号就能进房间、被分配角色；建房 / 导入要登录。
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,     -- Google 的 sub
  email       TEXT NOT NULL,
  name        TEXT,
  picture     TEXT,
  created_at  INTEGER NOT NULL,
  last_login  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,     -- 放在 HttpOnly cookie 里
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lines_room ON lines(room_id);
CREATE INDEX IF NOT EXISTS idx_devices_room ON devices(room_id);
`);

// CREATE TABLE IF NOT EXISTS 不会给已存在的表补列，所以新加的列要单独迁移
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((r) => r.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[db] 已给 ${table} 补上 ${column} 列`);
  }
}

addColumnIfMissing('rooms', 'tts_model', 'TEXT');
addColumnIfMissing('rooms', 'ambience_url_cafe', 'TEXT');
addColumnIfMissing('rooms', 'ambience_url_airport', 'TEXT');
addColumnIfMissing('speakers', 'volume', 'INTEGER NOT NULL DEFAULT 100');
addColumnIfMissing('rooms', 'capture_device', 'TEXT');
addColumnIfMissing('rooms', 'glossary', 'TEXT');
addColumnIfMissing('devices', 'capture', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('comparisons', 'summary', 'TEXT');
addColumnIfMissing('rooms', 'owner_id', 'TEXT'); // 建房的账号；老房间为空，登录后用本机的 host token 认领
db.exec('CREATE INDEX IF NOT EXISTS idx_rooms_owner ON rooms(owner_id)');

// 脚本模式（导入 script.json 的房间）：每句话什么时候开口由脚本里的 timing 决定，
// 不再走房间级的「定时抢话」。见 server/script.js。
addColumnIfMissing('rooms', 'script_mode', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('rooms', 'script_meta', 'TEXT'); // script.json 的 meta + speakers，原样留存
addColumnIfMissing('rooms', 'answer_key', 'TEXT'); // answer_key.json，给以后的 summary 评估用
addColumnIfMissing('rooms', 'last_timeline', 'TEXT'); // 最近一次开播的实际时间线（GT 时间戳的来源）
addColumnIfMissing('lines', 'uid', 'TEXT'); // 脚本里的 utterance id（u0001），timing.ref 指向它
addColumnIfMissing('lines', 'kind', "TEXT NOT NULL DEFAULT 'speech'"); // speech | backchannel | nonspeech
addColumnIfMissing('lines', 'tts_text', 'TEXT'); // 送给 TTS 的文本；空则用 content
addColumnIfMissing('lines', 'tts_continuation', 'TEXT'); // 被打断的句子：只合成、不播放的后半句
addColumnIfMissing('lines', 'timing', 'TEXT'); // JSON：{mode:'after'|'during', ref, gap_ms | at_text, delay_ms}
addColumnIfMissing('lines', 'cut_off', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('lines', 'clean', 'TEXT'); // 去掉填充词、重复后的参考文本
// Fish 返回的逐词时间戳（JSON）。NULL = 没要过；{"unavailable":true} = 要过但接口没给
addColumnIfMissing('audio', 'alignment', 'TEXT');

// 场景默认音源。放在这一层是为了让下面的回填和 createRoom 用同一份值。
export const AMBIENCE_DEFAULTS = {
  cafe: 'https://www.youtube.com/watch?v=jfzqpz3h0zU',
  airport: 'https://www.youtube.com/watch?v=LXzFZQC97nc',
};

// 给还没有链接的房间补上默认值。
// ambience_url 是上一版的单一字段，只有升级上来的库才有这一列 —— 新库里没有，
// 所以要先探一下再决定 SQL，否则会报 no such column。
{
  const roomCols = db.prepare(`SELECT name FROM pragma_table_info('rooms')`).all().map((r) => r.name);
  const legacy = roomCols.includes('ambience_url');

  db.prepare(
    legacy
      ? `UPDATE rooms SET ambience_url_cafe = COALESCE(ambience_url, ?) WHERE ambience_url_cafe IS NULL`
      : `UPDATE rooms SET ambience_url_cafe = ? WHERE ambience_url_cafe IS NULL`
  ).run(AMBIENCE_DEFAULTS.cafe);

  db.prepare(`UPDATE rooms SET ambience_url_airport = ? WHERE ambience_url_airport IS NULL`).run(
    AMBIENCE_DEFAULTS.airport
  );
}

// Fish 原生支持 mp3 输出，直接存 mp3 —— 比 WAV 小九倍左右
export function audioPath(hash) {
  return path.join(AUDIO_DIR, `${hash}.mp3`);
}

export function audioExists(hash) {
  return fs.existsSync(audioPath(hash));
}
