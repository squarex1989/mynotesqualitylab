import crypto from 'node:crypto';
import { db, AMBIENCE_DEFAULTS } from './db.js';
import {
  randomSpeakerConfig,
  normalizeConfig,
  normalizeVoice,
  buildInstructions,
  labelFor,
  speedFor,
} from './voices.js';
import { audioHash, lookupAudio, normalizeModel, DEFAULT_TTS_MODEL } from './tts.js';

// 去掉 0/O/1/I 这些看错就加不进房间的字符
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// 房间名长度：最多 20 个汉字 / 40 个字母。按「全角算 2、半角算 1」折算，上限 40。
// 前端 lib/roomName.ts 里有一份一模一样的实现（服务端是 .js、前端是 .ts，
// 没法直接共用），改规则时两边都要动。
export const TITLE_MAX_WEIGHT = 40;

export function titleWeight(s) {
  let w = 0;
  for (const ch of String(s || '')) {
    // CJK、假名、全角标点都算 2
    w += /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch)
      ? 2
      : 1;
  }
  return w;
}

/** 规整房间名：去首尾空白、压缩空格、按权重截断。空名返回 null。 */
/**
 * 角色音量：0 表示静音，其余取 20–100。
 * 刻意不进音频哈希 —— 它是播放时的增益，不是合成参数，调整应该即时且免费。
 */
export function normalizeVolume(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n >= 100) return 100;
  if (n <= 0) return 0;
  return Math.max(20, Math.min(100, n));
}

export function normalizeTitle(raw) {
  const t = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  let out = '';
  for (const ch of t) {
    if (titleWeight(out + ch) > TITLE_MAX_WEIGHT) break;
    out += ch;
  }
  return out || null;
}

function makeRoomId() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let id = '';
    for (let i = 0; i < 6; i++) {
      id += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
    }
    const exists = db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(id);
    if (!exists) return id;
  }
  throw new Error('Could not allocate a room code, please retry');
}

export function createRoom({ title } = {}) {
  const id = makeRoomId();
  const hostToken = crypto.randomBytes(24).toString('hex');
  db.prepare(
    `INSERT INTO rooms (id, host_token, created_at, title, ambience_url_cafe, ambience_url_airport)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    hostToken,
    Date.now(),
    normalizeTitle(title),
    AMBIENCE_DEFAULTS.cafe,
    AMBIENCE_DEFAULTS.airport
  );
  return { id, hostToken };
}

export function getRoom(id) {
  if (!id) return null;
  return db.prepare('SELECT * FROM rooms WHERE id = ?').get(String(id).toUpperCase()) || null;
}

export function isHostToken(room, token) {
  return Boolean(room && token && token === room.host_token);
}

export function getLines(roomId) {
  return db.prepare('SELECT idx, speaker, content FROM lines WHERE room_id = ? ORDER BY idx').all(roomId);
}

export function getSpeakers(roomId) {
  return db.prepare('SELECT * FROM speakers WHERE room_id = ? ORDER BY rowid').all(roomId);
}

export function getDevices(roomId) {
  return db
    .prepare('SELECT * FROM devices WHERE room_id = ? ORDER BY is_host DESC, last_seen ASC')
    .all(roomId);
}

/* ------------------------------------------------------------------ */
/* transcript                                                          */
/* ------------------------------------------------------------------ */

/**
 * 上传 transcript。房间一旦 locked 就不再接受新的 transcript。
 * plan 是批量导入按要求挑好的配置：voices（说话人 → 音色）、config（如语速）；
 * 不给就随机挑音色。
 */
export function setTranscript(roomId, parsed, plan = {}) {
  const room = getRoom(roomId);
  if (!room) throw new Error('Room not found');
  if (room.locked) throw new Error('This room already has a transcript and it cannot be replaced');
  if (!parsed.lines.length) throw new Error('No lines were parsed');

  const insertLine = db.prepare(
    'INSERT INTO lines (room_id, idx, speaker, content) VALUES (?, ?, ?, ?)'
  );
  const insertSpeaker = db.prepare(
    `INSERT INTO speakers (room_id, name, voice, config, instructions, custom, device_id)
     VALUES (?, ?, ?, ?, ?, 0, NULL)`
  );

  db.exec('BEGIN');
  try {
    parsed.lines.forEach((l, i) => insertLine.run(roomId, i, l.speaker, l.content));

    const used = [];
    for (const name of parsed.speakers) {
      const random = randomSpeakerConfig({ avoidVoices: used });
      const voice = plan.voices?.[name] ? normalizeVoice(plan.voices[name]) : random.voice;
      const config = plan.config ? normalizeConfig({ ...random.config, ...plan.config }) : random.config;
      used.push(voice);
      insertSpeaker.run(roomId, name, voice, JSON.stringify(config), random.instructions);
    }

    db.prepare('UPDATE rooms SET locked = 1 WHERE id = ?').run(roomId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  autoAssignDevices(roomId);
  return getRoom(roomId);
}

/* ------------------------------------------------------------------ */
/* speakers                                                            */
/* ------------------------------------------------------------------ */

/**
 * 改一个角色的设定。返回是否真的变了 —— 没变就不用重跑 TTS。
 * instructions 一旦被手工改过（custom=1），下拉框的变化就不再覆盖它，
 * 除非显式点“重新根据下拉生成”。
 */
export function updateSpeaker(roomId, name, patch) {
  const row = db.prepare('SELECT * FROM speakers WHERE room_id = ? AND name = ?').get(roomId, name);
  if (!row) throw new Error('No such speaker');

  const before = { voice: row.voice, instructions: row.instructions };

  const voice = patch.voice !== undefined ? normalizeVoice(patch.voice) : row.voice;
  const config = patch.config !== undefined
    ? normalizeConfig({ ...JSON.parse(row.config), ...patch.config })
    : JSON.parse(row.config);

  let custom = row.custom;
  let instructions;

  if (patch.instructions !== undefined && patch.instructions !== null) {
    instructions = String(patch.instructions).trim();
    custom = 1;
  } else if (patch.resetInstructions) {
    instructions = buildInstructions(config);
    custom = 0;
  } else if (custom) {
    instructions = row.instructions; // 手写的，保留
  } else {
    instructions = buildInstructions(config);
  }

  const volume =
    patch.volume !== undefined ? normalizeVolume(patch.volume) : normalizeVolume(row.volume);

  db.prepare(
    `UPDATE speakers SET voice = ?, config = ?, instructions = ?, custom = ?, volume = ?
     WHERE room_id = ? AND name = ?`
  ).run(voice, JSON.stringify(config), instructions, custom, volume, roomId, name);

  // 音量变了不算 changed —— 它不进音频哈希，不需要重新合成
  const changed = before.voice !== voice || before.instructions !== instructions;
  return { changed };
}

export function randomizeSpeaker(roomId, name) {
  const used = getSpeakers(roomId)
    .filter((s) => s.name !== name)
    .map((s) => s.voice);
  const { voice, config, instructions } = randomSpeakerConfig({ avoidVoices: used });
  db.prepare(
    'UPDATE speakers SET voice = ?, config = ?, instructions = ?, custom = 0 WHERE room_id = ? AND name = ?'
  ).run(voice, JSON.stringify(config), instructions, roomId, name);
}

export function randomizeAllSpeakers(roomId) {
  const used = [];
  for (const s of getSpeakers(roomId)) {
    const { voice, config, instructions } = randomSpeakerConfig({ avoidVoices: used });
    used.push(voice);
    db.prepare(
      'UPDATE speakers SET voice = ?, config = ?, instructions = ?, custom = 0 WHERE room_id = ? AND name = ?'
    ).run(voice, JSON.stringify(config), instructions, roomId, s.name);
  }
}

/* ------------------------------------------------------------------ */
/* devices / 分配                                                       */
/* ------------------------------------------------------------------ */

/** @returns {boolean} 这台设备是不是刚上线（新设备，或者之前是离线的） */
export function upsertDevice(roomId, { id, name, isHost }) {
  const existing = db.prepare('SELECT * FROM devices WHERE room_id = ? AND id = ?').get(roomId, id);
  if (existing) {
    db.prepare(
      'UPDATE devices SET name = ?, is_host = ?, online = 1, last_seen = ? WHERE room_id = ? AND id = ?'
    ).run(name || existing.name, isHost ? 1 : existing.is_host, Date.now(), roomId, id);
  } else {
    db.prepare(
      'INSERT INTO devices (id, room_id, name, is_host, online, last_seen) VALUES (?, ?, ?, ?, 1, ?)'
    ).run(id, roomId, name || 'Unnamed device', isHost ? 1 : 0, Date.now());
  }
  if (isHost) {
    db.prepare('UPDATE rooms SET host_device = ? WHERE id = ?').run(id, roomId);
  }
  return !existing || !existing.online;
}

/**
 * 把所有设备标成离线。进程启动时调用 —— 在线状态是内存里那些 socket 的投影，
 * 重启之后 DB 里存的那份必然是陈旧的。
 */
export function resetDevicePresence() {
  db.prepare('UPDATE devices SET online = 0').run();
}

export function markDeviceOffline(roomId, deviceId) {
  db.prepare('UPDATE devices SET online = 0, last_seen = ? WHERE room_id = ? AND id = ?').run(
    Date.now(),
    roomId,
    deviceId
  );
}

/**
 * 清掉离线太久的设备 —— 关了网页、锁屏很久没回来、设备就是不再用了。
 *
 * 不是一断线就删：Socket.IO 自己的 ping 超时、切个 App、网络抖一下，都会让
 * `online` 短暂变成 0，几秒到几十秒内几乎总会自己连回来。删得太急会把正在用
 * 的设备从列表里抹掉，反而添乱。所以只清离线超过 thresholdMs 的那些 —— 上线
 * 和下线都会刷新 `last_seen`，所以「现在 - last_seen」就是「离线了多久」。
 *
 * 删除前先把这台设备身上挂的东西摘掉，不留悬空引用：
 *   - 分到它的角色改回未分配（界面上「Read by」会显示 unassigned，不会自动
 *     改派给别的设备 —— 那是下一台设备连上时 autoAssignDevices 该做的事）
 *   - 环境音设备如果是它，清空
 *   - 房主设备指针如果是它，清空（这只是展示用的；房主权限走的是 host_token，
 *     跟这个指针无关，清不清都不影响谁是房主）
 *
 * @returns {string[]} 受影响的 roomId（去重），调用方用来决定给哪些房间广播
 */
export function pruneOfflineDevices(thresholdMs) {
  const cutoff = Date.now() - thresholdMs;
  const stale = db
    .prepare('SELECT room_id, id FROM devices WHERE online = 0 AND last_seen < ?')
    .all(cutoff);
  if (!stale.length) return [];

  const affected = new Set();
  db.exec('BEGIN');
  try {
    for (const { room_id: roomId, id: deviceId } of stale) {
      db.prepare('UPDATE speakers SET device_id = NULL WHERE room_id = ? AND device_id = ?').run(
        roomId,
        deviceId
      );
      db.prepare('UPDATE rooms SET ambience_device = NULL WHERE id = ? AND ambience_device = ?').run(
        roomId,
        deviceId
      );
      db.prepare('UPDATE rooms SET host_device = NULL WHERE id = ? AND host_device = ?').run(
        roomId,
        deviceId
      );
      db.prepare('DELETE FROM devices WHERE room_id = ? AND id = ?').run(roomId, deviceId);
      affected.add(roomId);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return [...affected];
}

export function renameDevice(roomId, deviceId, name) {
  db.prepare('UPDATE devices SET name = ? WHERE room_id = ? AND id = ?').run(
    String(name).slice(0, 40),
    roomId,
    deviceId
  );
}

export function assignSpeaker(roomId, speaker, deviceId) {
  if (deviceId) {
    const d = db.prepare('SELECT capture FROM devices WHERE room_id = ? AND id = ?').get(roomId, deviceId);
    if (d?.capture) throw new Error('That is a capture device — it records, it never reads');
  }
  db.prepare('UPDATE speakers SET device_id = ? WHERE room_id = ? AND name = ?').run(
    deviceId || null,
    roomId,
    speaker
  );
}

// 离线这么久以内的设备仍算「还在」：断线重连、或者刚被房主带进来还没连上
// （moveDevicesToRoom 预先写好的行）。超过就当它不在了，台词分给别人。
const ASSIGN_GRACE_MS = 30 * 1000;

/** 能念台词的设备：在线（或刚离线）且不是收音设备。尽量不用环境音设备。 */
function readerPool(roomId) {
  const room = getRoom(roomId);
  const now = Date.now();
  const present = getDevices(roomId).filter(
    (d) => !d.capture && (d.online || now - d.last_seen < ASSIGN_GRACE_MS)
  );
  // 环境音设备可以兼职念台词，但还有别的机器可用时就别让它兼职
  const free = present.filter((d) => d.id !== room?.ambience_device);
  return free.length ? free : present;
}

/**
 * 把角色平均摊到能念台词的设备上。
 *   - 已有的分配如果设备还在池子里就保留（force 时全部重分）
 *   - 没分配 / 分给了不在池子里的设备的，交给当前最闲的那台
 *   - 最后削峰填谷：最忙和最闲的设备相差超过 1 个角色就挪一个过去 ——
 *     新设备进来时靠这一步分到角色，而不是干坐着
 * 设备比角色多时，有的设备一个角色都分不到，这是正常的。
 */
export function autoAssignDevices(roomId, { force = false } = {}) {
  const pool = readerPool(roomId);
  if (!pool.length) return;

  const speakers = getSpeakers(roomId);
  const load = new Map(pool.map((d) => [d.id, []]));
  const pending = [];

  for (const s of speakers) {
    if (!force && s.device_id && load.has(s.device_id)) load.get(s.device_id).push(s);
    else pending.push(s);
  }

  // 打散一下，避免总是同一台机器拿到第一个角色
  const order = [...pool].sort(() => Math.random() - 0.5).map((d) => d.id);
  const lightest = () => order.reduce((best, id) => (load.get(id).length < load.get(best).length ? id : best));
  const heaviest = () => order.reduce((best, id) => (load.get(id).length > load.get(best).length ? id : best));

  for (const s of pending) load.get(lightest()).push(s);

  for (let guard = 0; guard < speakers.length; guard++) {
    const from = heaviest();
    const to = lightest();
    if (load.get(from).length - load.get(to).length <= 1) break;
    load.get(to).push(load.get(from).pop());
  }

  for (const [deviceId, list] of load) {
    for (const s of list) {
      if (s.device_id !== deviceId) assignSpeaker(roomId, s.name, deviceId);
    }
  }
}

/**
 * 设成 / 取消收音设备。收音设备绝不念台词：设上时把它身上的角色分给别人；
 * 取消时它重新回到朗读池，顺手均衡一下。
 */
export function setDeviceCapture(roomId, deviceId, on) {
  const exists = db.prepare('SELECT 1 FROM devices WHERE room_id = ? AND id = ?').get(roomId, deviceId);
  if (!exists) throw new Error('No such device');
  db.prepare('UPDATE devices SET capture = ? WHERE room_id = ? AND id = ?').run(on ? 1 : 0, roomId, deviceId);
  if (on) {
    db.prepare('UPDATE speakers SET device_id = NULL WHERE room_id = ? AND device_id = ?').run(roomId, deviceId);
  }
  autoAssignDevices(roomId);
}

/**
 * 房主换房间时把设备一起带过去。
 *
 * 在目标房间里预先写好这些设备的行（离线，last_seen=现在），保留它们的角色：
 *   - 收音设备仍是收音设备
 *   - 原房间的环境音设备成为目标房间的环境音设备
 *   - 其余设备按目标房间的角色数重新分配台词（角色少于设备时有的设备没有台词）
 * 预写的行落在 ASSIGN_GRACE_MS 之内，所以第一台连上的设备不会把台词全揽走。
 *
 * @param {string[]} deviceIds 要带走的设备（原房间里在线的那些）
 */
export function moveDevicesToRoom(fromRoomId, toRoomId, deviceIds) {
  const from = getRoom(fromRoomId);
  const to = getRoom(toRoomId);
  if (!from || !to) throw new Error('Room not found');
  const moving = getDevices(fromRoomId).filter((d) => deviceIds.includes(d.id));
  const now = Date.now();

  db.exec('BEGIN');
  try {
    for (const d of moving) {
      db.prepare(
        `INSERT INTO devices (id, room_id, name, is_host, capture, online, last_seen)
         VALUES (?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(room_id, id) DO UPDATE SET
           name = excluded.name, capture = excluded.capture, last_seen = excluded.last_seen`
      ).run(d.id, toRoomId, d.name, d.is_host, d.capture, now);
    }
    if (from.ambience_device && deviceIds.includes(from.ambience_device)) {
      db.prepare('UPDATE rooms SET ambience_device = ? WHERE id = ?').run(from.ambience_device, toRoomId);
    }
    // 收音设备身上不能有台词
    for (const d of moving.filter((m) => m.capture)) {
      db.prepare('UPDATE speakers SET device_id = NULL WHERE room_id = ? AND device_id = ?').run(toRoomId, d.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  autoAssignDevices(toRoomId, { force: true });
  return moving.map((d) => d.id);
}

/* ------------------------------------------------------------------ */
/* 房间设置                                                             */
/* ------------------------------------------------------------------ */

const SETTING_COLUMNS = {
  orderMode: { col: 'order_mode', check: (v) => (['ordered', 'chaotic'].includes(v) ? v : 'ordered') },
  noiseMode: { col: 'noise_mode', check: (v) => (['quiet', 'noisy'].includes(v) ? v : 'quiet') },
  ambienceKind: { col: 'ambience_kind', check: (v) => (['cafe', 'airport'].includes(v) ? v : 'cafe') },
  ambienceUrlCafe: { col: 'ambience_url_cafe', check: (v) => (v ? String(v).slice(0, 500) : null) },
  ambienceUrlAirport: {
    col: 'ambience_url_airport',
    check: (v) => (v ? String(v).slice(0, 500) : null),
  },
  ambienceVolume: {
    col: 'ambience_volume',
    check: (v) => Math.max(0, Math.min(100, Number(v) || 0)),
  },
  ambienceDevice: { col: 'ambience_device', check: (v) => (v ? String(v) : null) },
  ttsModel: { col: 'tts_model', check: (v) => normalizeModel(v) },
  gapMs: { col: 'gap_ms', check: (v) => Math.max(0, Math.min(5000, Number(v) || 0)) },
  chaosPeriodMs: {
    col: 'chaos_period_ms',
    check: (v) => Math.max(3000, Math.min(120000, Number(v) || 20000)),
  },
  duckGain: { col: 'duck_gain', check: (v) => Math.max(0, Math.min(1, Number(v))) },
  title: { col: 'title', check: (v) => normalizeTitle(v) },
};

export function updateRoomSettings(roomId, patch) {
  const sets = [];
  const vals = [];
  for (const [key, spec] of Object.entries(SETTING_COLUMNS)) {
    if (patch[key] === undefined) continue;
    sets.push(`${spec.col} = ?`);
    vals.push(spec.check(patch[key]));
  }
  if (!sets.length) return;
  vals.push(roomId);
  db.prepare(`UPDATE rooms SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  // 环境音设备可以同时念台词，所以这里不再把它身上的角色挪走 ——
  // 只是之后自动分配时会优先用别的设备（见 readerPool）。
}

/** 给房间改名。返回规整后的名字（空名会被存成 null，界面上显示房间号）。 */
export function renameRoom(roomId, title) {
  const clean = normalizeTitle(title);
  db.prepare('UPDATE rooms SET title = ? WHERE id = ?').run(clean, roomId);
  return clean;
}

/**
 * 删掉一个房间。lines / speakers / devices 靠外键 ON DELETE CASCADE 一起走。
 *
 * 音频文件故意不删：它们是按内容寻址的、跨房间共享，别的房间可能正用着同一份。
 * 留着也只是缓存，下次同样的文本 + 音色还能直接命中。
 */
export function deleteRoom(roomId) {
  db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
}

/** 首页那个列表要的轻量信息，不拉台词也不拉角色详情 */
export function roomSummaries(ids) {
  const out = [];
  for (const raw of ids) {
    const room = getRoom(raw);
    if (!room) continue;
    const { n: lineCount } = db
      .prepare('SELECT COUNT(*) AS n FROM lines WHERE room_id = ?')
      .get(room.id);
    const { n: speakerCount } = db
      .prepare('SELECT COUNT(*) AS n FROM speakers WHERE room_id = ?')
      .get(room.id);
    out.push({
      id: room.id,
      title: room.title,
      locked: Boolean(room.locked),
      status: room.status,
      createdAt: room.created_at,
      lineCount,
      speakerCount,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 转录对比                                                            */
/* ------------------------------------------------------------------ */

export function getComparisons(roomId) {
  return db
    .prepare('SELECT * FROM comparisons WHERE room_id = ?')
    .all(roomId)
    .map((r) => ({
      product: r.product,
      transcript: r.transcript,
      summary: r.summary || '',
      result: r.result ? JSON.parse(r.result) : null,
      state: r.state,
      error: r.error,
      updatedAt: r.updated_at,
    }));
}

/**
 * 存下某个产品的转录和 / 或摘要。只改传进来的那个字段。
 * 转录变了 → 打分结果作废、状态回到 idle；只改摘要不影响转录的分数。
 * 两样都空了就整行删掉。
 */
export function putComparison(roomId, product, { transcript, summary } = {}) {
  const row = db
    .prepare('SELECT transcript, summary FROM comparisons WHERE room_id = ? AND product = ?')
    .get(roomId, product);
  const nextTranscript = transcript !== undefined ? String(transcript ?? '').trim() : row?.transcript ?? '';
  const nextSummary = summary !== undefined ? String(summary ?? '').trim() : row?.summary ?? '';

  if (!nextTranscript && !nextSummary) {
    db.prepare('DELETE FROM comparisons WHERE room_id = ? AND product = ?').run(roomId, product);
    return;
  }
  const transcriptChanged = !row || nextTranscript !== row.transcript;
  db.prepare(
    `INSERT INTO comparisons (room_id, product, transcript, summary, result, state, error, updated_at)
     VALUES (?, ?, ?, ?, NULL, 'idle', NULL, ?)
     ON CONFLICT(room_id, product) DO UPDATE SET
       transcript = excluded.transcript,
       summary = excluded.summary,
       updated_at = excluded.updated_at
       ${transcriptChanged ? ", result = NULL, state = 'idle', error = NULL" : ''}`
  ).run(roomId, product, nextTranscript, nextSummary || null, Date.now());
}

/** 兼容旧调用：只存转录 */
export function putComparisonTranscript(roomId, product, transcript) {
  putComparison(roomId, product, { transcript });
}

export function setComparisonState(roomId, product, state, { result, error } = {}) {
  db.prepare(
    `UPDATE comparisons SET state = ?, result = ?, error = ?, updated_at = ?
     WHERE room_id = ? AND product = ?`
  ).run(
    state,
    result ? JSON.stringify(result) : null,
    error || null,
    Date.now(),
    roomId,
    product
  );
}

/** 房间里那份原始 transcript，拼成 `Speaker: 内容` 的纯文本给裁判当真值 */
export function referenceTranscript(roomId) {
  return getLines(roomId)
    .map((l) => `${l.speaker}: ${l.content}`)
    .join('\n');
}

/** 当前场景用哪个链接 */
export function ambienceUrlFor(room) {
  return room.ambience_kind === 'airport' ? room.ambience_url_airport : room.ambience_url_cafe;
}

/** 关键词表：打分时按最高档权重算，也用来在中文里识别专有名词 */
export function setGlossary(roomId, text) {
  const clean = String(text || '').slice(0, 4000);
  db.prepare('UPDATE rooms SET glossary = ? WHERE id = ?').run(clean, roomId);
  return clean;
}

export function setRoomStatus(roomId, status) {
  db.prepare('UPDATE rooms SET status = ? WHERE id = ?').run(status, roomId);
}

/* ------------------------------------------------------------------ */
/* 生成进度 / 状态快照                                                   */
/* ------------------------------------------------------------------ */

/** 每句话当前应该是哪个音频文件（由 speaker 的音色配置决定） */
export function lineTargets(roomId) {
  const model = normalizeModel(getRoom(roomId)?.tts_model);
  const speakers = new Map(
    getSpeakers(roomId).map((s) => [
      s.name,
      { ...s, speed: speedFor(normalizeConfig(JSON.parse(s.config))) },
    ])
  );
  return getLines(roomId).map((line) => {
    const sp = speakers.get(line.speaker);
    const hash = sp
      ? audioHash({ model, voice: sp.voice, instructions: sp.instructions, speed: sp.speed, text: line.content })
      : null;
    return {
      ...line,
      hash,
      model,
      voice: sp?.voice,
      instructions: sp?.instructions,
      speed: sp?.speed,
      deviceId: sp?.device_id,
    };
  });
}

export function generationProgress(roomId) {
  const targets = lineTargets(roomId);
  const mask = targets.map((t) => (t.hash && lookupAudio(t.hash) ? 1 : 0));
  const ready = mask.reduce((a, b) => a + b, 0);
  return { ready, total: targets.length, mask };
}

export function roomState(roomId) {
  const room = getRoom(roomId);
  if (!room) return null;

  const roomModel = normalizeModel(room.tts_model);
  const firstLine = db.prepare(
    'SELECT content FROM lines WHERE room_id = ? AND speaker = ? ORDER BY idx LIMIT 1'
  );

  const speakers = getSpeakers(roomId).map((s) => {
    // 过一遍 normalize：老房间存的 config 里可能还留着已经废弃的维度（比如之前的 gender）
    const config = normalizeConfig(JSON.parse(s.config));
    // 这个角色第一句话的音频（如果已经合成好），用来在界面上试听
    const first = firstLine.get(roomId, s.name);
    const sampleHash = first
      ? audioHash({ model: roomModel, voice: s.voice, instructions: s.instructions, speed: speedFor(config), text: first.content })
      : null;
    return {
      sampleHash: sampleHash && lookupAudio(sampleHash) ? sampleHash : null,
      name: s.name,
      voice: s.voice,
      config,
      configLabels: Object.fromEntries(
        Object.entries(config).map(([k, v]) => [k, labelFor(k, v)])
      ),
      instructions: s.instructions,
      custom: Boolean(s.custom),
      volume: normalizeVolume(s.volume),
      deviceId: s.device_id,
      lineCount: db
        .prepare('SELECT COUNT(*) AS n FROM lines WHERE room_id = ? AND speaker = ?')
        .get(roomId, s.name).n,
    };
  });

  const devices = getDevices(roomId).map((d) => ({
    id: d.id,
    name: d.name,
    isHost: Boolean(d.is_host),
    capture: Boolean(d.capture),
    online: Boolean(d.online),
  }));

  return {
    id: room.id,
    title: room.title,
    locked: Boolean(room.locked),
    status: room.status,
    hostDevice: room.host_device,
    settings: {
      orderMode: room.order_mode,
      noiseMode: room.noise_mode,
      ambienceKind: room.ambience_kind,
      ambienceUrlCafe: room.ambience_url_cafe,
      ambienceUrlAirport: room.ambience_url_airport,
      // 派生字段：当前选中场景对应的那个链接，播放链路只看这个
      ambienceUrl: ambienceUrlFor(room),
      ambienceVolume: room.ambience_volume,
      ambienceDevice: room.ambience_device,
      ttsModel: normalizeModel(room.tts_model),
      glossary: room.glossary || '',
      gapMs: room.gap_ms,
      chaosPeriodMs: room.chaos_period_ms,
      duckGain: room.duck_gain,
    },
    speakers,
    devices,
    lineCount: db.prepare('SELECT COUNT(*) AS n FROM lines WHERE room_id = ?').get(roomId).n,
  };
}
