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
  ambienceUrlFor,
  getComparisons,
  putComparisonTranscript,
  setComparisonState,
  referenceTranscript,
} from './rooms.js';
import { gradeTranscript, isProduct } from './judge.js';
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
  state.comparisons = getComparisons(roomId);
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
      socket.emit('fatal', { message: 'Room not found, or this device sent no identifier' });
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

    // ---------------- 转录对比（收音设备本机 + 房主）----------------
    const canCompare = () => {
      if (socket.data.isHost) return true;
      return getRoom(roomId)?.capture_device === deviceId;
    };

    const compareOnly = (handler) => async (payload) => {
      if (!canCompare()) {
        socket.emit('toast', {
          kind: 'error',
          message: 'Only the host or the capture device can run comparisons',
        });
        return;
      }
      try {
        await handler(payload || {});
      } catch (err) {
        socket.emit('toast', { kind: 'error', message: err.message || String(err) });
      }
    };

    socket.on(
      'compare:put',
      compareOnly(({ product, transcript }) => {
        if (!isProduct(product)) throw new Error('Unknown product');
        putComparisonTranscript(roomId, product, transcript);
        broadcast(roomId);
      })
    );

    socket.on(
      'compare:score',
      compareOnly(async ({ product }) => {
        if (!isProduct(product)) throw new Error('Unknown product');

        const reference = referenceTranscript(roomId);
        if (!reference.trim()) throw new Error('This room has no transcript to compare against');

        const row = getComparisons(roomId).find((c) => c.product === product);
        if (!row?.transcript?.trim()) throw new Error('Paste that product\'s transcript first');
        if (row.state === 'scoring') return; // 已经在跑了

        setComparisonState(roomId, product, 'scoring');
        broadcast(roomId);

        try {
          const result = await gradeTranscript({ reference, candidate: row.transcript });
          setComparisonState(roomId, product, 'done', { result });
        } catch (err) {
          setComparisonState(roomId, product, 'failed', { error: err.message || String(err) });
        }
        broadcast(roomId);
      })
    );

    // ---------------- 以下都是房主专属 ----------------
    const hostOnly = (handler) => (payload, ack) => {
      if (!socket.data.isHost) {
        socket.emit('toast', { kind: 'error', message: 'Only the host can do that' });
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
                ? `${payload.name}: this exact setup was synthesized before — served from cache`
                : `${payload.name} updated · ${total - ready} line(s) now need synthesizing`,
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
          socket.emit('toast', { kind: 'error', message: 'No transcript uploaded yet' });
          return;
        }
        if (ready === total) {
          socket.emit('toast', { kind: 'success', message: 'Every line already has audio — you can start' });
          return;
        }
        ensureGeneration(roomId);
        socket.emit('toast', { kind: 'info', message: `Synthesizing ${total - ready} line(s)` });
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
    socket.emit('toast', { kind: 'error', message: 'No transcript uploaded yet' });
    return;
  }

  const progress = generationProgress(roomId);
  if (progress.ready < progress.total) {
    const missing = progress.total - progress.ready;
    socket.emit('toast', {
      kind: 'error',
      message: `${missing} line(s) have no audio yet — hit Synthesize audio first`,
    });
    return;
  }
  if (progress.total === 0) {
    socket.emit('toast', { kind: 'error', message: 'Nothing to read' });
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
    socket.emit('toast', { kind: 'error', message: 'The schedule came out empty' });
    return;
  }

  // 参与本次播放的设备 = 有台词的设备 + 环境音设备
  const pending = new Set(items.map((i) => i.deviceId).filter(Boolean));
  const ambienceUrl = ambienceUrlFor(room);
  const ambienceOn = room.noise_mode === 'noisy' && Boolean(ambienceUrl);
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
          url: ambienceUrl,
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
        message: `${session.pending.size} device(s) never reported ready — starting anyway`,
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
