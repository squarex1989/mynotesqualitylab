import { Server } from 'socket.io';
import {
  getRoom,
  isRoomHost,
  roomState,
  getLines,
  getSpeakers,
  upsertDevice,
  resetDevicePresence,
  markDeviceOffline,
  pruneOfflineDevices,
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
  putComparison,
  setComparisonState,
  getDevices,
  setDeviceCapture,
  moveDevicesToRoom,
  setGlossary,
  referenceTranscript,
} from './rooms.js';
import { gradeTranscript, isProduct } from './judge.js';
import { userFromCookieHeader } from './auth.js';
import { ensureGeneration, jobStatus, genEvents } from './generate.js';
import { buildSchedule } from './schedule.js';
import { lookupAudio } from './tts.js';

const PREPARE_TIMEOUT_MS = 15000; // 等设备预加载的上限
const GO_LEAD_MS = 1200; // 所有设备就绪后再留这么久做最后对齐
// 有环境音时先让 YouTube 出声、再开始念。等它报「出声了」的上限 —— 超时就照常开始，
// 不能让一个卡住的播放器拖住整场。
const AMBIENCE_WAIT_MS = Number(process.env.AMBIENCE_WAIT_MS) || 10000;

// 设备离线超过这么久才清掉 —— 断线重连、切个 App 通常几秒到几十秒就自己好了，
// 定太短会把正在用的设备从列表里删掉，「Read by」跟着变成未分配，反而添乱。
const DEVICE_PRUNE_AFTER_MS = Number(process.env.DEVICE_PRUNE_AFTER_MS) || 10 * 60 * 1000;
// 多久扫一次。扫描本身很轻（一条 SQL），间隔比阈值短很多也无所谓
const DEVICE_PRUNE_INTERVAL_MS = Number(process.env.DEVICE_PRUNE_INTERVAL_MS) || 2 * 60 * 1000;

/** roomId -> { items, totalMs, pending:Set, timer, started } */
const sessions = new Map();

/**
 * roomId -> 暂停时正在念的那一句的 idx。继续播放就从这一句的开头重新开始 ——
 * 不从半句话中间接着放：各设备的音频要重新预加载、重新对时，从句首开始最干净，
 * 听的人也更容易接上。只存内存，重启即忘（重启后房间本来就是 idle）。
 */
const pausedAt = new Map();

/** `${roomId}:${deviceId}` -> 这台设备有没有解锁过 AudioContext（只存内存，重启即忘） */
const audioReady = new Map();

/**
 * `${roomId}:${deviceId}` -> 这台设备当前活着的 socket id 集合。
 *
 * 一台设备同时存在多个 socket 是常态，不是异常：手机切网络或切后台时，新 socket
 * 会立刻连上，而旧 socket 要等 Socket.IO 的 ping 超时（默认最长 45 秒）才会触发
 * disconnect。如果只按 deviceId 记在线状态，那个迟到的 disconnect 会把刚连上的
 * 设备又标成离线，而且再也不会有人把它改回来 —— 界面显示 offline，房间还会因此
 * 把它的角色改派给别的机器，于是这台设备真念的时候一声不出。
 *
 * 所以按 socket 计数，最后一个断开才算离线。
 */
const liveSockets = new Map();

function snapshot(roomId) {
  const state = roomState(roomId);
  if (!state) return null;
  state.devices = state.devices.map((d) => ({
    ...d,
    audioReady: audioReady.get(`${roomId}:${d.id}`) === true,
  }));
  state.comparisons = getComparisons(roomId);
  state.pausedIdx = pausedAt.has(roomId) ? pausedAt.get(roomId) : null;
  return { state, progress: jobStatus(roomId) };
}

function pushState(io, roomId) {
  const payload = snapshot(roomId);
  if (payload) io.to(roomId).emit('state', payload);
}

export function attachRealtime(httpServer) {
  // 进程刚起来，一个 socket 都没有 —— 但 DB 里可能还留着上次退出时的 online=1。
  // 不清掉的话，每次部署重启后界面会显示一屋子在线设备，其实全都没连。
  resetDevicePresence();

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

  // 定期清掉离线太久的设备，免得房间的设备列表越用越脏。
  // 立刻跑一次，别等第一个 interval 才生效。
  const sweepStaleDevices = () => {
    for (const roomId of pruneOfflineDevices(DEVICE_PRUNE_AFTER_MS)) broadcast(roomId);
  };
  sweepStaleDevices();
  setInterval(sweepStaleDevices, DEVICE_PRUNE_INTERVAL_MS);

  io.on('connection', (socket) => {
    const { roomId: rawRoomId, deviceId, deviceName, hostToken } = socket.handshake.auth || {};
    const room = getRoom(rawRoomId);

    if (!room || !deviceId) {
      socket.emit('fatal', { message: 'Room not found, or this device sent no identifier' });
      socket.disconnect(true);
      return;
    }

    const roomId = room.id;
    // 登录了、且是这个房间的建房人 → 不管本机有没有 host token 都是房主
    const user = userFromCookieHeader(socket.handshake.headers.cookie);
    const isHost = isRoomHost(room, { token: hostToken, userId: user?.id });

    socket.data = { roomId, deviceId, isHost, userId: user?.id ?? null };
    socket.join(roomId);

    const liveKey = `${roomId}:${deviceId}`;
    const live = liveSockets.get(liveKey) || new Set();
    live.add(socket.id);
    liveSockets.set(liveKey, live);

    const cameOnline = upsertDevice(roomId, { id: deviceId, name: deviceName, isHost });

    // 有设备进来（或者有角色还没人念）就分一下：新设备会从最忙的设备那里接过角色。
    // 已有的分配只要设备还在就保留，所以房主手动改过的不会被无故打乱。
    if (cameOnline || getSpeakers(roomId).some((s) => !s.device_id)) autoAssignDevices(roomId);

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

    // ---------------- 转录对比（写：房主和收音设备；读：谁都能看，走 state 广播）----------------
    // 收音设备是真正录音的那台机器，转录和摘要就是在它上面贴进来的，所以它也能写。
    // 每次现查 —— 房主随时可能把它设成 / 取消收音设备。
    const canWriteCompare = () =>
      socket.data.isHost || getDevices(roomId).some((d) => d.id === deviceId && d.capture);

    const compareOnly = (handler) => async (payload) => {
      if (!canWriteCompare()) {
        socket.emit('toast', {
          kind: 'error',
          message: 'Only the host or a capture device can edit or score comparisons',
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
      compareOnly(({ product, transcript, summary }) => {
        if (!isProduct(product)) throw new Error('Unknown product');
        putComparison(roomId, product, { transcript, summary });
        broadcast(roomId);
      })
    );

    socket.on(
      'compare:glossary',
      compareOnly(({ text }) => {
        setGlossary(roomId, text);
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
        // 摘要的评估逻辑还没做，这里只给转录打分
        if (row.state === 'scoring') return; // 已经在跑了

        setComparisonState(roomId, product, 'scoring');
        broadcast(roomId);

        try {
          const result = await gradeTranscript({
            reference,
            candidate: row.transcript,
            glossary: getRoom(roomId)?.glossary || '',
          });
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

    // 收音设备：只录音、贴转录，不念台词
    socket.on(
      'device:capture',
      hostOnly((payload) => {
        setDeviceCapture(roomId, String(payload.deviceId || ''), Boolean(payload.on));
        broadcast(roomId);
      })
    );

    // 房主换房间，可选把这个房间里在线的设备一起带过去（收音 / 环境音角色不变，
    // 朗读设备按新房间的角色数重新分配）
    socket.on(
      'room:move',
      hostOnly((payload, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        const target = getRoom(payload.targetRoomId);
        if (!target || target.id === roomId) {
          reply({ ok: false, error: 'Pick a different, existing room' });
          return;
        }
        if (!isRoomHost(target, { token: payload.targetHostToken, userId: socket.data.userId })) {
          reply({ ok: false, error: 'You are not the host of that room' });
          return;
        }
        if (!payload.follow) {
          reply({ ok: true, moved: 0 });
          return;
        }
        if (sessions.has(roomId)) stopRoom(io, roomId, 'moved');
        const online = getDevices(roomId).filter((d) => d.online).map((d) => d.id);
        const moved = moveDevicesToRoom(roomId, target.id, online);
        broadcast(target.id);
        io.to(roomId).emit('room:goto', { roomId: target.id, from: roomId });
        reply({ ok: true, moved: moved.length });
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
    // fromIdx：从某一句开始（Script 里每行前面的播放按钮、暂停后的继续）
    socket.on(
      'room:start',
      hostOnly((payload) => startRoom(io, roomId, socket, { fromIdx: payload.fromIdx }))
    );

    socket.on(
      'room:pause',
      hostOnly(() => pauseRoom(io, roomId))
    );

    socket.on(
      'room:stop',
      hostOnly(() => stopRoom(io, roomId, 'host'))
    );

    // 环境音设备报告 YouTube 已经出声 —— 这时朗读设备才开始念
    socket.on('ambience:playing', ({ token } = {}) => {
      const session = sessions.get(roomId);
      if (!session || session.token !== token || session.ambienceDevice !== deviceId) return;
      launch(io, roomId);
    });

    socket.on('play:ready', ({ token } = {}) => {
      const session = sessions.get(roomId);
      if (!session || session.started || session.token !== token) return;
      session.pending.delete(deviceId);
      io.to(roomId).emit('play:preparing', { remaining: session.pending.size });
      if (session.pending.size === 0) go(io, roomId);
    });

    socket.on('disconnect', () => {
      // 只有这台设备最后一个 socket 也走了才算离线。旧 socket 的超时断开
      // 不能把已经重连上来的同一台设备标成离线。
      const still = liveSockets.get(liveKey);
      still?.delete(socket.id);
      if (!still || still.size === 0) {
        liveSockets.delete(liveKey);
        markDeviceOffline(roomId, deviceId);
      }
      const session = sessions.get(roomId);
      if (session && !session.started && session.pending.delete(deviceId) && session.pending.size === 0) {
        go(io, roomId);
      }
      // 正在等的环境音设备掉线了，就别再等它出声
      if (session?.awaitingAmbience && session.ambienceDevice === deviceId && !liveSockets.has(liveKey)) {
        launch(io, roomId);
      }
      broadcast(roomId);
    });
  });

  return { io, broadcast };
}

/* ------------------------------------------------------------------ */

function startRoom(io, roomId, socket, { fromIdx } = {}) {
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
  // 没分到设备的角色兜底给房主 —— 除非房主这台是收音设备，收音设备绝不出声
  const hostRow = getDevices(roomId).find((d) => d.id === room.host_device);
  const hostDevice = hostRow && !hostRow.capture ? room.host_device : null;
  const built = buildSchedule(room, getLines(roomId), speakerMap, audioMap, hostDevice);
  let { items, totalMs, overlaps } = built;

  // 从某一句开始：之前的全部丢掉（包括和这一句重叠的上一句），时间线平移到 0
  if (fromIdx !== undefined && fromIdx !== null) {
    const at = items.findIndex((i) => i.idx === Number(fromIdx));
    if (at < 0) {
      socket.emit('toast', { kind: 'error', message: 'That line is not in the schedule' });
      return;
    }
    const offset = items[at].startMs;
    items = items.slice(at).map((i) => ({ ...i, startMs: i.startMs - offset }));
    totalMs = items.reduce((max, it) => Math.max(max, it.startMs + it.durationMs), 0);
    overlaps = items.filter((i) => i.overlapMs > 0).length;
  }

  if (!items.length) {
    socket.emit('toast', { kind: 'error', message: 'The schedule came out empty' });
    return;
  }

  // 正在放（或在准备）的话先停掉，再从新的位置开始
  if (sessions.has(roomId)) endSession(io, roomId, 'restart');
  pausedAt.delete(roomId);

  // 参与本次播放的设备 = 有台词的设备 + 环境音设备
  const pending = new Set(items.map((i) => i.deviceId).filter(Boolean));
  const ambienceUrl = ambienceUrlFor(room);
  const ambienceOn = room.noise_mode === 'noisy' && Boolean(ambienceUrl);
  if (ambienceOn && room.ambience_device) pending.add(room.ambience_device);

  const token = `${roomId}-${Date.now()}`;
  const session = {
    token,
    items,
    totalMs,
    pending,
    started: false,
    launched: false,
    timer: null,
    endTimer: null,
    ambienceTimer: null,
    ambienceDevice: ambienceOn ? room.ambience_device : null,
    awaitingAmbience: false,
  };
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

  // 有环境音：先让环境音设备开播，等它报告 YouTube 真的出声了再让大家开始念。
  // YouTube 从按下播放到出声要缓冲零点几秒到几秒，同时开始的话前几句是在
  // 安静的房间里念的，测不到「嘈杂环境」。
  const amb = session.ambienceDevice;
  if (amb && liveSockets.has(`${roomId}:${amb}`)) {
    session.awaitingAmbience = true;
    io.to(roomId).emit('ambience:start', { token: session.token, deviceId: amb });
    session.ambienceTimer = setTimeout(() => {
      if (session.launched) return;
      io.to(roomId).emit('toast', {
        kind: 'info',
        message: 'The ambience device never confirmed YouTube was playing — starting anyway',
      });
      launch(io, roomId);
    }, AMBIENCE_WAIT_MS);
    return;
  }
  launch(io, roomId);
}

/** 真正开始：给所有设备同一个起点 */
function launch(io, roomId) {
  const session = sessions.get(roomId);
  if (!session || session.launched) return;
  session.launched = true;
  session.awaitingAmbience = false;
  clearTimeout(session.ambienceTimer);

  const startAt = Date.now() + GO_LEAD_MS;
  session.startAt = startAt;
  io.to(roomId).emit('play:go', { token: session.token, startAt, totalMs: session.totalMs });

  session.endTimer = setTimeout(() => {
    stopRoom(io, roomId, 'finished');
  }, GO_LEAD_MS + session.totalMs + 1500);
}

/** 清掉一场播放的计时器并通知各设备停下，不动房间状态 */
function endSession(io, roomId, reason) {
  const session = sessions.get(roomId);
  if (session) {
    clearTimeout(session.timer);
    clearTimeout(session.endTimer);
    clearTimeout(session.ambienceTimer);
    sessions.delete(roomId);
  }
  io.to(roomId).emit('play:stop', { reason });
}

/** 暂停：记下此刻正在念的那一句，停掉；继续时从那一句开头开始 */
function pauseRoom(io, roomId) {
  const session = sessions.get(roomId);
  if (!session) return;
  const elapsed = session.startAt ? Date.now() - session.startAt : -1;
  let current = session.items[0];
  for (const it of session.items) {
    if (it.startMs <= elapsed) current = it;
    else break;
  }
  // 那一句其实已经念完、正在句间停顿里：从下一句继续
  if (current && elapsed >= current.startMs + current.durationMs) {
    const next = session.items[session.items.indexOf(current) + 1];
    if (next) current = next;
  }
  if (current) pausedAt.set(roomId, current.idx);
  endSession(io, roomId, 'paused');
  setRoomStatus(roomId, 'idle');
  pushState(io, roomId);
}

function stopRoom(io, roomId, reason) {
  endSession(io, roomId, reason);
  pausedAt.delete(roomId);
  setRoomStatus(roomId, 'idle');
  pushState(io, roomId);
}
