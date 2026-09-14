import { Server } from 'socket.io';
import {
  getRoom,
  isHostToken,
  roomState,
  getLines,
  getSpeakers,
  upsertDevice,
  markDeviceOffline,
  renameDevice,
  updateSpeaker,
  randomizeSpeaker,
  randomizeAllSpeakers,
  assignSpeaker,
  autoAssignDevices,
  updateRoomSettings,
  setRoomStatus,
  lineTargets,
  generationProgress,
} from './rooms.js';
import { ensureGeneration, jobStatus, genEvents } from './generate.js';
import { buildSchedule } from './schedule.js';
import { lookupAudio } from './tts.js';

const PREPARE_TIMEOUT_MS = 15000; // 等设备预加载的上限
const GO_LEAD_MS = 1200; // 所有设备就绪后再留这么久做最后对齐

/** roomId -> { items, totalMs, pending:Set, timer, started } */
const sessions = new Map();

/** `${roomId}:${deviceId}` -> 这台设备有没有解锁过 AudioContext（只存内存，重启即忘） */
const audioReady = new Map();

function snapshot(roomId) {
  const state = roomState(roomId);
  if (!state) return null;
  state.devices = state.devices.map((d) => ({
    ...d,
    audioReady: audioReady.get(`${roomId}:${d.id}`) === true,
  }));
  return { state, progress: jobStatus(roomId) };
}

function pushState(io, roomId) {
  const payload = snapshot(roomId);
  if (payload) io.to(roomId).emit('state', payload);
}

export function attachRealtime(httpServer) {
  const io = new Server(httpServer, {
    path: '/socket.io',
    maxHttpBufferSize: 4e6,
    cors: { origin: true },
  });

  // transcript 是走 HTTP 上传的，上传完得主动把台词和状态推给房间里所有人 ——
  // 否则房主自己要刷新页面才看得到刚传上去的东西。
  const broadcast = (roomId, { withLines = false } = {}) => {
    if (withLines) io.to(roomId).emit('lines', { lines: getLines(roomId) });
    pushState(io, roomId);
  };

  // 合成过程中只推轻量的 progress；一旦跑完就补一次完整 state ——
  // 角色的“试听”样本是刚刚才生成出来的，只推 progress 的话界面上永远等不到它。
  const wasGenerating = new Map();
  genEvents.on('progress', (roomId, progress) => {
    io.to(roomId).emit('progress', progress);
    if (wasGenerating.get(roomId) && !progress.generating) pushState(io, roomId);
    wasGenerating.set(roomId, progress.generating);
  });

  io.on('connection', (socket) => {
    const { roomId: rawRoomId, deviceId, deviceName, hostToken } = socket.handshake.auth || {};
    const room = getRoom(rawRoomId);

    if (!room || !deviceId) {
      socket.emit('fatal', { message: '房间不存在或设备标识缺失' });
      socket.disconnect(true);
      return;
    }

    const roomId = room.id;
    const isHost = isHostToken(room, hostToken);

    socket.data = { roomId, deviceId, isHost };
    socket.join(roomId);

    upsertDevice(roomId, { id: deviceId, name: deviceName, isHost });

    // 第一台进来的设备如果还没人分到角色，顺手分一下
    if (getSpeakers(roomId).some((s) => !s.device_id)) autoAssignDevices(roomId);

    socket.emit('hello', { roomId, deviceId, isHost, serverNow: Date.now() });
    socket.emit('lines', { lines: getLines(roomId) });
    broadcast(roomId);

    // ---------------- 时钟同步 ----------------
    socket.on('time:sync', (_payload, ack) => {
      if (typeof ack === 'function') ack({ serverNow: Date.now() });
    });

    // ---------------- 设备 ----------------
    socket.on('device:rename', ({ name } = {}) => {
      if (!name) return;
      renameDevice(roomId, deviceId, name);
      broadcast(roomId);
    });

    // 浏览器不允许无手势播放，所以“这台机器点过启用声音了吗”是房主开场前必须看到的信息
    socket.on('device:audio', ({ unlocked } = {}) => {
      audioReady.set(`${roomId}:${deviceId}`, Boolean(unlocked));
      broadcast(roomId);
    });

    // ---------------- 以下都是房主专属 ----------------
    const hostOnly = (handler) => (payload, ack) => {
      if (!socket.data.isHost) {
        socket.emit('toast', { kind: 'error', message: '只有房主可以做这个操作' });
        return;
      }
      try {
        handler(payload || {}, ack);
      } catch (err) {
        socket.emit('toast', { kind: 'error', message: err.message || String(err) });
      }
    };

    // 改设定不会自动触发合成 —— 房主可能要连着调好几个角色，
    // 每动一次下拉框就发一轮 TTS 是在烧钱。统一等他点「合成音频」。
    socket.on(
      'speaker:update',
      hostOnly((payload) => {
        const { changed } = updateSpeaker(roomId, payload.name, payload);
        broadcast(roomId);
        if (changed) {
          const { ready, total } = generationProgress(roomId);
          socket.emit('toast', {
            kind: 'info',
            message:
              ready === total
                ? `「${payload.name}」这套设定之前合成过，音频直接命中缓存`
                : `「${payload.name}」已更新，还有 ${total - ready} 句待合成`,
          });
        }
      })
    );

    socket.on(
      'speaker:randomize',
      hostOnly((payload) => {
        randomizeSpeaker(roomId, payload.name);
        broadcast(roomId);
      })
    );

    socket.on(
      'speakers:randomizeAll',
      hostOnly(() => {
        randomizeAllSpeakers(roomId);
        broadcast(roomId);
      })
    );

    socket.on(
      'speaker:assign',
      hostOnly((payload) => {
        assignSpeaker(roomId, payload.name, payload.deviceId || null);
        broadcast(roomId);
      })
    );

    socket.on(
      'devices:autoAssign',
      hostOnly((payload) => {
        autoAssignDevices(roomId, { force: payload.force !== false });
        broadcast(roomId);
      })
    );

    socket.on(
      'room:settings',
      hostOnly((payload) => {
        updateRoomSettings(roomId, payload);
        broadcast(roomId);
      })
    );

    // 房主确认好所有角色设定之后，显式开始合成
    socket.on(
      'generation:start',
      hostOnly(() => {
        const { ready, total } = generationProgress(roomId);
        if (total === 0) {
          socket.emit('toast', { kind: 'error', message: '还没上传 transcript' });
          return;
        }
        if (ready === total) {
          socket.emit('toast', { kind: 'success', message: '所有台词都已经有音频了，可以直接开始' });
          return;
        }
        ensureGeneration(roomId);
        socket.emit('toast', { kind: 'info', message: `开始合成 ${total - ready} 句` });
      })
    );

    // ---------------- 播放 ----------------
    socket.on(
      'room:start',
      hostOnly(() => startRoom(io, roomId, socket))
    );

    socket.on(
      'room:stop',
      hostOnly(() => stopRoom(io, roomId, 'host'))
    );

    socket.on('play:ready', ({ token } = {}) => {
      const session = sessions.get(roomId);
      if (!session || session.started || session.token !== token) return;
      session.pending.delete(deviceId);
      io.to(roomId).emit('play:preparing', { remaining: session.pending.size });
      if (session.pending.size === 0) go(io, roomId);
    });

    socket.on('disconnect', () => {
      markDeviceOffline(roomId, deviceId);
      const session = sessions.get(roomId);
      if (session && !session.started && session.pending.delete(deviceId) && session.pending.size === 0) {
        go(io, roomId);
      }
      broadcast(roomId);
    });
  });

  return { io, broadcast };
}

/* ------------------------------------------------------------------ */

function startRoom(io, roomId, socket) {
  const room = getRoom(roomId);
  if (!room) return;

  if (!room.locked) {
    socket.emit('toast', { kind: 'error', message: '还没上传 transcript' });
    return;
  }

  const progress = generationProgress(roomId);
  if (progress.ready < progress.total) {
    const missing = progress.total - progress.ready;
    socket.emit('toast', {
      kind: 'error',
      message: `还有 ${missing} 句没有音频，先点「合成音频」`,
    });
    return;
  }
  if (progress.total === 0) {
    socket.emit('toast', { kind: 'error', message: '没有可朗读的台词' });
    return;
  }

  const targets = lineTargets(roomId);
  const audioMap = new Map();
  for (const t of targets) {
    const row = t.hash ? lookupAudio(t.hash) : null;
    if (row) audioMap.set(t.idx, { hash: t.hash, durationMs: row.duration_ms });
  }

  const speakerMap = new Map(getSpeakers(roomId).map((s) => [s.name, s]));
  const hostDevice = room.host_device;
  const { items, totalMs, overlaps } = buildSchedule(
    room,
    getLines(roomId),
    speakerMap,
    audioMap,
    hostDevice
  );

  if (!items.length) {
    socket.emit('toast', { kind: 'error', message: '排期是空的' });
    return;
  }

  // 参与本次播放的设备 = 有台词的设备 + 环境音设备
  const pending = new Set(items.map((i) => i.deviceId).filter(Boolean));
  const ambienceOn = room.noise_mode === 'noisy' && room.ambience_url;
  if (ambienceOn && room.ambience_device) pending.add(room.ambience_device);

  const token = `${roomId}-${Date.now()}`;
  const session = { token, items, totalMs, pending, started: false, timer: null, endTimer: null };
  sessions.set(roomId, session);

  setRoomStatus(roomId, 'playing');

  io.to(roomId).emit('play:prepare', {
    token,
    items,
    totalMs,
    overlaps,
    orderMode: room.order_mode,
    ambience: ambienceOn
      ? {
          deviceId: room.ambience_device,
          url: room.ambience_url,
          kind: room.ambience_kind,
          volume: room.ambience_volume,
        }
      : null,
  });

  pushState(io, roomId);

  // 有设备卡住也不能一直等
  session.timer = setTimeout(() => {
    if (!session.started) {
      io.to(roomId).emit('toast', {
        kind: 'info',
        message: `有 ${session.pending.size} 台设备没报就绪，先开始了`,
      });
      go(io, roomId);
    }
  }, PREPARE_TIMEOUT_MS);
}

function go(io, roomId) {
  const session = sessions.get(roomId);
  if (!session || session.started) return;
  session.started = true;
  clearTimeout(session.timer);

  const startAt = Date.now() + GO_LEAD_MS;
  io.to(roomId).emit('play:go', { token: session.token, startAt, totalMs: session.totalMs });

  session.endTimer = setTimeout(() => {
    stopRoom(io, roomId, 'finished');
  }, GO_LEAD_MS + session.totalMs + 1500);
}

function stopRoom(io, roomId, reason) {
  const session = sessions.get(roomId);
  if (session) {
    clearTimeout(session.timer);
    clearTimeout(session.endTimer);
    sessions.delete(roomId);
  }
  setRoomStatus(roomId, 'idle');
  io.to(roomId).emit('play:stop', { reason });
  pushState(io, roomId);
}
