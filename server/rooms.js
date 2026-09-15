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

/** 上传 transcript。房间一旦 locked 就不再接受新的 transcript。 */
export function setTranscript(roomId, parsed) {
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
      const { voice, config, instructions } = randomSpeakerConfig({ avoidVoices: used });
      used.push(voice);
      insertSpeaker.run(roomId, name, voice, JSON.stringify(config), instructions);
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

export function renameDevice(roomId, deviceId, name) {
  db.prepare('UPDATE devices SET name = ? WHERE room_id = ? AND id = ?').run(
    String(name).slice(0, 40),
    roomId,
    deviceId
  );
}

export function assignSpeaker(roomId, speaker, deviceId) {
  // 收音设备的职责是听，自己出声会污染录音 —— 拒绝把角色分给它
  if (deviceId && getRoom(roomId)?.capture_device === deviceId) {
    throw new Error('The capture device cannot read lines');
  }
  db.prepare('UPDATE speakers SET device_id = ? WHERE room_id = ? AND name = ?').run(
    deviceId || null,
    roomId,
    speaker
  );
}

/** 把角色平均摊到在线设备上。已有的分配如果设备还在线就保留。 */
export function autoAssignDevices(roomId, { force = false } = {}) {
  const room = getRoom(roomId);
  if (!room) return;

  const devices = getDevices(roomId).filter((d) => d.online);
  const pool = devices.length ? devices : getDevices(roomId);
  if (!pool.length) return;

  const speakers = getSpeakers(roomId);
  const onlineIds = new Set(pool.map((d) => d.id));

  // 环境音设备和收音设备如果还有别的机器可用，就别让它们兼职念台词。
  // 收音设备尤其不能 —— 它的职责是听，自己出声会污染录音。
  const free = pool.filter((d) => d.id !== room.ambience_device && d.id !== room.capture_device);
  const targets = free.length ? free : pool.filter((d) => d.id !== room.capture_device);
  if (!targets.length) return; // 只剩收音设备，那就谁都不分

  // 打散一下，避免总是同一台机器拿到第一个角色
  const order = [...targets].sort(() => Math.random() - 0.5);

  let cursor = 0;
  for (const s of speakers) {
    const keep =
      !force &&
      s.device_id &&
      onlineIds.has(s.device_id) &&
      s.device_id !== room.ambience_device &&
      s.device_id !== room.capture_device;
    if (keep) continue;
    const device = order[cursor % order.length];
    cursor++;
    assignSpeaker(roomId, s.name, device.id);
  }
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
  captureDevice: { col: 'capture_device', check: (v) => (v ? String(v) : null) },
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

  // 环境音设备和收音设备都不该同时念台词：把它们身上的角色挪走
  // （前提是还有别的设备可用，否则宁可让它兼职也别让台词没人读）
  for (const key of ['ambienceDevice', 'captureDevice']) {
    if (patch[key] === undefined) continue;
    const room = getRoom(roomId);
    const busy = key === 'ambienceDevice' ? room.ambience_device : room.capture_device;
    if (!busy) continue;
    const others = getDevices(roomId).filter((d) => d.id !== busy && d.id !== room.capture_device);
    if (!others.length) continue;
    const stuck = getSpeakers(roomId).filter((s) => s.device_id === busy);
    stuck.forEach((s, i) => assignSpeaker(roomId, s.name, others[i % others.length].id));
  }
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
      result: r.result ? JSON.parse(r.result) : null,
      state: r.state,
      error: r.error,
      updatedAt: r.updated_at,
    }));
}

/** 存下某个产品的转录文本，状态回到 idle（还没跑分） */
export function putComparisonTranscript(roomId, product, transcript) {
  const text = String(transcript ?? '').trim();
  if (!text) {
    db.prepare('DELETE FROM comparisons WHERE room_id = ? AND product = ?').run(roomId, product);
    return;
  }
  db.prepare(
    `INSERT INTO comparisons (room_id, product, transcript, result, state, error, updated_at)
     VALUES (?, ?, ?, NULL, 'idle', NULL, ?)
     ON CONFLICT(room_id, product) DO UPDATE SET
       transcript = excluded.transcript,
       result = NULL, state = 'idle', error = NULL, updated_at = excluded.updated_at`
  ).run(roomId, product, text, Date.now());
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
      captureDevice: room.capture_device,
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
