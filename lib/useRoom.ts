'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { AudioEngine } from './audioEngine';
import { AmbiencePlayer } from './ambience';
import { getDeviceId, getDeviceName, getHostToken, setDeviceName } from './identity';
import type {
  Line,
  PreparePayload,
  Progress,
  RoomSettings,
  RoomState,
  ScheduleItem,
} from './types';

export type Toast = { id: number; kind: 'info' | 'error' | 'success'; message: string };
export type Phase = 'idle' | 'preparing' | 'playing';

const SYNC_ROUNDS = 6;

export function useRoom(roomId: string) {
  const socketRef = useRef<Socket | null>(null);
  const engineRef = useRef<AudioEngine | null>(null);
  const ambienceRef = useRef<AmbiencePlayer | null>(null);
  const ambienceHostRef = useRef<HTMLDivElement | null>(null);
  const offsetRef = useRef(0); // serverTime = localTime + offset

  const [connected, setConnected] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [deviceId, setDeviceId] = useState('');
  const [state, setState] = useState<RoomState | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const [phase, setPhase] = useState<Phase>('idle');
  const [schedule, setSchedule] = useState<ScheduleItem[]>([]);
  const [totalMs, setTotalMs] = useState(0);
  const [overlaps, setOverlaps] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [prepareRemaining, setPrepareRemaining] = useState(0);
  const startAtLocalRef = useRef(0);

  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [ambienceStatus, setAmbienceStatus] = useState<{
    isAmbienceDevice: boolean;
    ready: boolean;
    armed: boolean;
    error: string | null;
  }>({ isAmbienceDevice: false, ready: false, armed: false, error: null });

  const pushToast = useCallback((kind: Toast['kind'], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-4), { id, kind, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5200);
  }, []);

  /* ---------------- socket ---------------- */
  useEffect(() => {
    if (!roomId) return;

    const myId = getDeviceId();
    setDeviceId(myId);
    engineRef.current = new AudioEngine();
    ambienceRef.current = new AmbiencePlayer();

    const socket = io({
      path: '/socket.io',
      auth: {
        roomId,
        deviceId: myId,
        deviceName: getDeviceName(),
        hostToken: getHostToken(roomId),
      },
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      void syncClock(socket, offsetRef);
      socket.emit('device:audio', { unlocked: engineRef.current?.unlocked ?? false });
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('fatal', ({ message }: { message: string }) => setFatal(message));
    socket.on('hello', (p: { isHost: boolean }) => setIsHost(p.isHost));
    socket.on('state', ({ state: s, progress: p }: { state: RoomState; progress: Progress }) => {
      setState(s);
      setProgress(p);
    });
    socket.on('progress', (p: Progress) => setProgress(p));
    socket.on('lines', ({ lines: l }: { lines: Line[] }) => setLines(l));
    socket.on('toast', ({ kind, message }: { kind: Toast['kind']; message: string }) =>
      pushToast(kind, message)
    );

    socket.on('play:prepare', (payload: PreparePayload) => {
      setPhase('preparing');
      setSchedule(payload.items);
      setTotalMs(payload.totalMs);
      setOverlaps(payload.overlaps);
      setElapsedMs(0);
      void prepareLocal(payload, myId);
    });

    socket.on('play:preparing', ({ remaining }: { remaining: number }) =>
      setPrepareRemaining(remaining)
    );

    socket.on('play:go', ({ token, startAt }: { token: string; startAt: number }) => {
      const localStart = startAt - offsetRef.current;
      startAtLocalRef.current = localStart;
      setPhase('playing');
      engineRef.current?.start(token, localStart);
      const amb = ambienceRef.current;
      if (amb?.isReady) {
        const delay = Math.max(0, localStart - Date.now());
        setTimeout(() => amb.play(), delay);
      }
    });

    socket.on('play:stop', ({ reason }: { reason: string }) => {
      engineRef.current?.stop();
      ambienceRef.current?.stop();
      setPhase('idle');
      setElapsedMs(0);
      setPrepareRemaining(0);
      if (reason === 'finished') pushToast('success', '读完了');
    });

    return () => {
      engineRef.current?.stop();
      ambienceRef.current?.destroy();
      socket.close();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  /* ---------------- 进入准备阶段：预加载自己的那部分 ---------------- */
  const prepareLocal = useCallback(
    async (payload: PreparePayload, myId: string) => {
      const engine = engineRef.current!;
      const mine = payload.items.filter((i) => i.deviceId === myId);
      const isAmbienceDevice = payload.ambience?.deviceId === myId;

      setAmbienceStatus((s) => ({ ...s, isAmbienceDevice }));

      const jobs: Promise<unknown>[] = [];

      if (engine.unlocked) {
        jobs.push(engine.prepare(payload.token, mine));
      } else {
        engine.prepare(payload.token, mine); // 记下排期，解锁后仍能补上
        if (mine.length) {
          pushToast('error', '这台设备还没启用声音，它负责的台词会没声音');
        }
      }

      if (isAmbienceDevice && payload.ambience && ambienceHostRef.current) {
        jobs.push(
          ambienceRef
            .current!.init(ambienceHostRef.current, payload.ambience.url, payload.ambience.volume)
            .then(() => setAmbienceStatus((s) => ({ ...s, ready: true, error: null })))
            .catch((err) => setAmbienceStatus((s) => ({ ...s, error: err.message })))
        );
      }

      await Promise.allSettled(jobs);
      socketRef.current?.emit('play:ready', { token: payload.token });
    },
    [pushToast]
  );

  /* ---------------- 播放进度 ---------------- */
  useEffect(() => {
    if (phase !== 'playing') return;
    let raf = 0;
    const loop = () => {
      setElapsedMs(Date.now() - startAtLocalRef.current);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  /* ---------------- 动作 ---------------- */
  const emit = useCallback((event: string, payload?: unknown) => {
    socketRef.current?.emit(event, payload);
  }, []);

  const unlockAudio = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    const ok = await engine.unlock();
    setAudioUnlocked(ok);
    socketRef.current?.emit('device:audio', { unlocked: ok });

    // 这台机器如果同时是环境音源，顺手在同一次手势里把 YouTube 播放器“点亮”
    const amb = ambienceRef.current;
    const url = state?.settings.ambienceUrl;
    const isAmb = state?.settings.ambienceDevice === deviceId && state?.settings.noiseMode === 'noisy';
    if (amb && url && isAmb && ambienceHostRef.current) {
      try {
        await amb.init(ambienceHostRef.current, url, state!.settings.ambienceVolume);
        amb.arm();
        setAmbienceStatus((s) => ({ ...s, isAmbienceDevice: true, ready: true, armed: true, error: null }));
      } catch (err: any) {
        setAmbienceStatus((s) => ({ ...s, isAmbienceDevice: true, error: err.message }));
      }
    }
    if (ok) pushToast('success', '这台设备已经可以出声了');
  }, [state, deviceId, pushToast]);

  const actions = useMemo(
    () => ({
      renameDevice: (name: string) => {
        setDeviceName(name);
        emit('device:rename', { name });
      },
      updateSpeaker: (
        name: string,
        patch: { voice?: string; config?: Record<string, string>; instructions?: string | null; resetInstructions?: boolean }
      ) => emit('speaker:update', { name, ...patch }),
      randomizeSpeaker: (name: string) => emit('speaker:randomize', { name }),
      randomizeAll: () => emit('speakers:randomizeAll'),
      assignSpeaker: (name: string, targetDeviceId: string | null) =>
        emit('speaker:assign', { name, deviceId: targetDeviceId }),
      autoAssign: () => emit('devices:autoAssign', { force: true }),
      updateSettings: (patch: Partial<RoomSettings>) => emit('room:settings', patch),
      start: () => emit('room:start'),
      stop: () => emit('room:stop'),
      startGeneration: () => emit('generation:start'),
    }),
    [emit]
  );

  const currentIdx = useMemo(() => {
    if (phase !== 'playing' || !schedule.length) return -1;
    let found = -1;
    for (const item of schedule) {
      if (item.startMs <= elapsedMs) found = item.idx;
      else break;
    }
    return found;
  }, [phase, schedule, elapsedMs]);

  const activeIdxs = useMemo(() => {
    if (phase !== 'playing') return new Set<number>();
    const set = new Set<number>();
    for (const item of schedule) {
      if (item.startMs <= elapsedMs && elapsedMs < item.startMs + item.durationMs) set.add(item.idx);
    }
    return set;
  }, [phase, schedule, elapsedMs]);

  return {
    connected,
    fatal,
    isHost,
    deviceId,
    state,
    progress,
    lines,
    toasts,
    phase,
    schedule,
    totalMs,
    overlaps,
    elapsedMs,
    prepareRemaining,
    currentIdx,
    activeIdxs,
    audioUnlocked,
    unlockAudio,
    ambienceHostRef,
    ambienceStatus,
    actions,
  };
}

async function syncClock(socket: Socket, offsetRef: { current: number }) {
  let best = Infinity;
  let bestOffset = offsetRef.current;

  for (let i = 0; i < SYNC_ROUNDS; i++) {
    const t0 = Date.now();
    const serverNow = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 2000);
      socket.emit('time:sync', {}, (res: { serverNow: number }) => {
        clearTimeout(timer);
        resolve(res?.serverNow ?? null);
      });
    });
    if (serverNow == null) continue;
    const t1 = Date.now();
    const rtt = t1 - t0;
    if (rtt < best) {
      best = rtt;
      bestOffset = serverNow - (t0 + t1) / 2;
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  if (Number.isFinite(best)) offsetRef.current = bestOffset;
}
