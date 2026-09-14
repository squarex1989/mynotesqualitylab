'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { rememberRoom } from '@/lib/identity';
import { useRoom } from '@/lib/useRoom';
import type { Meta } from '@/lib/types';
import { TranscriptUploader } from '@/components/TranscriptUploader';
import { SpeakerList } from '@/components/SpeakerList';
import { DevicePanel } from '@/components/DevicePanel';
import { ToneSettings } from '@/components/ToneSettings';
import { ScriptView } from '@/components/ScriptView';
import { StagePanel } from '@/components/StagePanel';

export default function RoomPage() {
  const params = useParams<{ id: string }>();
  const roomId = (params?.id ?? '').toUpperCase();

  const [meta, setMeta] = useState<Meta | null>(null);
  const [copied, setCopied] = useState(false);

  const room = useRoom(roomId);
  const {
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
  } = room;

  useEffect(() => {
    api.meta().then(setMeta).catch(() => {});
    if (roomId) rememberRoom(roomId);
  }, [roomId]);

  const speakingNames = useMemo(() => {
    const names = new Set<string>();
    for (const item of schedule) {
      if (activeIdxs.has(item.idx)) names.add(item.speaker);
    }
    return names;
  }, [schedule, activeIdxs]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(roomId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 没有剪贴板权限就算了 */
    }
  };

  if (fatal) {
    return (
      <div className="shell" style={{ maxWidth: 520, paddingTop: 80 }}>
        <div className="card">
          <h2>进不去这个房间</h2>
          <p className="sub">{fatal}</p>
          <Link href="/">← 回首页</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <div className="topbar">
        <div>
          <div className="tiny muted">房间号</div>
          <button
            className="ghost"
            onClick={copy}
            style={{ border: 'none', padding: 0, background: 'none' }}
            title="点一下复制"
          >
            <span className="roomcode">{roomId}</span>
          </button>
          {copied && <span className="tiny muted" style={{ marginLeft: 8 }}>已复制</span>}
        </div>

        <div className="row" style={{ marginLeft: 'auto' }}>
          <span className={`pill ${connected ? 'ok' : 'err'}`}>
            <span className={`dot ${connected ? 'ok' : 'err'}`} />
            {connected ? '已连接' : '连接中…'}
          </span>
          {isHost && <span className="pill on">房主</span>}
          {state?.status === 'playing' && <span className="pill on">▶ 朗读中</span>}
          <Link href="/" className="pill">
            首页
          </Link>
        </div>
      </div>

      {!audioUnlocked && (
        <div className="unlock">
          <span>
            浏览器默认不给网页出声。点一下这个按钮，这台设备才能朗读
            {ambienceStatus.isAmbienceDevice || state?.settings.ambienceDevice === deviceId
              ? '（顺便把环境音也点亮）'
              : ''}
            。
          </span>
          <button onClick={unlockAudio}>启用声音</button>
        </div>
      )}

      {ambienceStatus.error && (
        <div className="card" style={{ borderColor: 'rgba(239,111,111,.4)' }}>
          <span className="tiny" style={{ color: 'var(--err)' }}>
            环境音加载失败：{ambienceStatus.error}
          </span>
        </div>
      )}

      {!state ? (
        <div className="card">
          <p className="muted">正在加载房间…</p>
        </div>
      ) : !state.locked ? (
        <div className="grid">
          <div>
            {isHost ? (
              <TranscriptUploader roomId={roomId} />
            ) : (
              <div className="card">
                <h2>等房主上传 transcript</h2>
                <p className="sub">
                  上传之后这里会出现角色列表和你分到的台词。先确认一下你这台机器的名字和声音已经启用。
                </p>
              </div>
            )}
            <DevicePanel
              devices={state.devices}
              speakers={state.speakers}
              settings={state.settings}
              myDeviceId={deviceId}
              isHost={isHost}
              onAutoAssign={actions.autoAssign}
              onRename={actions.renameDevice}
              onSetAmbienceDevice={(id) => actions.updateSettings({ ambienceDevice: id })}
            />
          </div>
          <div>
            <ToneSettings
              settings={state.settings}
              devices={state.devices}
              isHost={isHost}
              onChange={actions.updateSettings}
            />
          </div>
        </div>
      ) : (
        <div className="grid">
          <div>
            <SpeakerList
              speakers={state.speakers}
              devices={state.devices}
              meta={meta}
              isHost={isHost}
              speaking={speakingNames}
              onUpdate={actions.updateSpeaker}
              onRandomize={actions.randomizeSpeaker}
              onRandomizeAll={actions.randomizeAll}
              onAssign={actions.assignSpeaker}
            />
            <DevicePanel
              devices={state.devices}
              speakers={state.speakers}
              settings={state.settings}
              myDeviceId={deviceId}
              isHost={isHost}
              onAutoAssign={actions.autoAssign}
              onRename={actions.renameDevice}
              onSetAmbienceDevice={(id) => actions.updateSettings({ ambienceDevice: id })}
            />
            <ScriptView
              lines={lines}
              progress={progress}
              schedule={schedule}
              activeIdxs={activeIdxs}
              currentIdx={currentIdx}
              playing={phase === 'playing'}
            />
          </div>

          <div>
            <StagePanel
              state={state}
              progress={progress}
              isHost={isHost}
              phase={phase}
              totalMs={totalMs}
              elapsedMs={elapsedMs}
              overlaps={overlaps}
              prepareRemaining={prepareRemaining}
              myDeviceId={deviceId}
              onStart={actions.start}
              onStop={actions.stop}
              onGenerate={actions.startGeneration}
            />
            <ToneSettings
              settings={state.settings}
              devices={state.devices}
              isHost={isHost}
              onChange={actions.updateSettings}
            />
          </div>
        </div>
      )}

      <div className="hidden-player" ref={ambienceHostRef} />

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
