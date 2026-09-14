import crypto from 'node:crypto';
import { db } from './db.js';
import {
  randomSpeakerConfig,
  normalizeConfig,
  normalizeVoice,
  buildInstructions,
  labelFor,
} from './voices.js';
import { audioHash, lookupAudio } from './tts.js';

// 去掉 0/O/1/I 这些看错就加不进房间的字符
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeRoomId() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let id = '';
    for (let i = 0; i < 6; i++) {
      id += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
    }
    const exists = db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(id);
    if (!exists) return id;
  }
  throw new Error('生成房间号失败，请重试');
}

export function createRoom({ title } = {}) {
  const id = makeRoomId();
  const hostToken = crypto.randomBytes(24).toString('hex');
  db.prepare(
    'INSERT INTO rooms (id, host_token, created_at, title) VALUES (?, ?, ?, ?)'
  ).run(id, hostToken, Date.now(), title || null);
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
  if (!room) throw new Error('房间不存在');
  if (room.locked) throw new Error('这个房间已经有 transcript 了，不能替换');
  if (!parsed.lines.length) throw new Error('没有解析出台词');

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
  if (!row) throw new Error('角色不存在');

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

  db.prepare(
    'UPDATE speakers SET voice = ?, config = ?, instructions = ?, custom = ? WHERE room_id = ? AND name = ?'
  ).run(voice, JSON.stringify(config), instructions, custom, roomId, name);

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
    ).run(id, roomId, name || '未命名设备', isHost ? 1 : 0, Date.now());
  }
  if (isHost) {
    db.prepare('UPDATE rooms SET host_device = ? WHERE id = ?').run(id, roomId);
  }
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

  // 环境音设备如果还有别的机器可用，就别让它兼职念台词
  const nonAmbience = pool.filter((d) => d.id !== room.ambience_device);
  const targets = nonAmbience.length ? nonAmbience : pool;

  // 打散一下，避免总是同一台机器拿到第一个角色
  const order = [...targets].sort(() => Math.random() - 0.5);

  let cursor = 0;
  for (const s of speakers) {
    if (!force && s.device_id && onlineIds.has(s.device_id) && s.device_id !== room.ambience_device) {
      continue;
    }
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
  ambienceUrl: { col: 'ambience_url', check: (v) => (v ? String(v).slice(0, 500) : null) },
  ambienceVolume: {
    col: 'ambience_volume',
    check: (v) => Math.max(0, Math.min(100, Number(v) || 0)),
  },
  ambienceDevice: { col: 'ambience_device', check: (v) => (v ? String(v) : null) },
  gapMs: { col: 'gap_ms', check: (v) => Math.max(0, Math.min(5000, Number(v) || 0)) },
  chaosPeriodMs: {
    col: 'chaos_period_ms',
    check: (v) => Math.max(3000, Math.min(120000, Number(v) || 20000)),
  },
  duckGain: { col: 'duck_gain', check: (v) => Math.max(0, Math.min(1, Number(v))) },
  title: { col: 'title', check: (v) => (v ? String(v).slice(0, 80) : null) },
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

  // 环境音设备不该同时念台词：把它身上的角色挪走（前提是还有别的设备）
  if (patch.ambienceDevice !== undefined) {
    const room = getRoom(roomId);
    const others = getDevices(roomId).filter((d) => d.id !== room.ambience_device);
    if (room.ambience_device && others.length) {
      const stuck = getSpeakers(roomId).filter((s) => s.device_id === room.ambience_device);
      stuck.forEach((s, i) => assignSpeaker(roomId, s.name, others[i % others.length].id));
    }
  }
}

export function setRoomStatus(roomId, status) {
  db.prepare('UPDATE rooms SET status = ? WHERE id = ?').run(status, roomId);
}

/* ------------------------------------------------------------------ */
/* 生成进度 / 状态快照                                                   */
/* ------------------------------------------------------------------ */

/** 每句话当前应该是哪个音频文件（由 speaker 的音色配置决定） */
export function lineTargets(roomId) {
  const speakers = new Map(getSpeakers(roomId).map((s) => [s.name, s]));
  return getLines(roomId).map((line) => {
    const sp = speakers.get(line.speaker);
    const hash = sp
      ? audioHash({ voice: sp.voice, instructions: sp.instructions, text: line.content })
      : null;
    return { ...line, hash, voice: sp?.voice, instructions: sp?.instructions, deviceId: sp?.device_id };
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

  const firstLine = db.prepare(
    'SELECT content FROM lines WHERE room_id = ? AND speaker = ? ORDER BY idx LIMIT 1'
  );

  const speakers = getSpeakers(roomId).map((s) => {
    // 过一遍 normalize：老房间存的 config 里可能还留着已经废弃的维度（比如之前的 gender）
    const config = normalizeConfig(JSON.parse(s.config));
    // 这个角色第一句话的音频（如果已经合成好），用来在界面上试听
    const first = firstLine.get(roomId, s.name);
    const sampleHash = first
      ? audioHash({ voice: s.voice, instructions: s.instructions, text: first.content })
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
      ambienceUrl: room.ambience_url,
      ambienceVolume: room.ambience_volume,
      ambienceDevice: room.ambience_device,
      gapMs: room.gap_ms,
      chaosPeriodMs: room.chaos_period_ms,
      duckGain: room.duck_gain,
    },
    speakers,
    devices,
    lineCount: db.prepare('SELECT COUNT(*) AS n FROM lines WHERE room_id = ?').get(roomId).n,
  };
}
