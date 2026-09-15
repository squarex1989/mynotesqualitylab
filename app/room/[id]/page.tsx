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
import { CompareModal } from '@/components/CompareModal';
import { isIosLike } from '@/lib/audioEngine';

export default function RoomPage() {
  const params = useParams<{ id: string }>();
  const roomId = (params?.id ?? '').toUpperCase();

  const [meta, setMeta] = useState<Meta | null>(null);
  const [copied, setCopied] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [diagCopied, setDiagCopied] = useState(false);

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
    audioState,
    audioDiag,
    audioReport,
    playStats,
    unlockAudio,
    ambienceHostRef,
    ambienceStatus,
    actions,
  } = room;

  useEffect(() => {
    api.meta().then(setMeta).catch(() => {});
    if (roomId) rememberRoom(roomId);
  }, [roomId]);

  // 服务端眼里的「我自己」。诊断行要用它对照本机算出来的状态。
  const meRow = state?.devices.find((d) => d.id === deviceId) ?? null;

  const myRows = state ? state.devices.filter((d) => d.id === deviceId).length : 0;

  /**
   * 诊断行只在有异常时出现。
   *
   * 一切正常时它是噪音；但出问题时（尤其在手机上，看不了控制台）它是唯一能
   * 把「设备端状态」和「服务端记下来的状态」对上的东西 —— 所以留着，只是平时藏起来。
   */
  const audioAnomaly =
    audioState === 'blocked' ||
    (state !== null && !connected) ||
    (audioState === 'ready' && (meRow ? !meRow.audioReady : state !== null)) ||
    myRows > 1 ||
    // 开播了却什么都没挂上时间线，或者有解码失败 —— 这正是「状态全绿但不出声」
    (phase !== 'idle' &&
      playStats !== null &&
      (playStats.decodeFails > 0 || (playStats.assigned > 0 && playStats.scheduled === 0)));

  // 这台设备要念几句。台词一句都没分到时它当然不会出声 —— 但以前界面上完全
  // 看不出来，只能干等。
  const myLineCount = state
    ? state.speakers.filter((sp) => sp.deviceId === deviceId).reduce((n, sp) => n + sp.lineCount, 0)
    : 0;
  const isCaptureDevice = state?.settings.captureDevice === deviceId;
  const isAmbienceDevice = state?.settings.ambienceDevice === deviceId;

  // 手机上没法看控制台，这一行要能一键复制出来
  const diagLine =
    `${audioReport()}  local=${audioState}` +
    `  server=${meRow ? (meRow.audioReady ? 'ready' : 'blocked') : 'no-row'}` +
    `  socket=${connected ? 'up' : 'down'}` +
    `  id=${deviceId ? deviceId.slice(0, 6) : '?'}` +
    `  rows=${myRows}/${state ? state.devices.length : 0}`;

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
      /* no clipboard permission — never mind */
    }
  };

  if (fatal) {
    return (
      <div className="shell" style={{ maxWidth: 520, paddingTop: 80 }}>
        <div className="card">
          <h2>Can&apos;t open this room</h2>
          <p className="sub">{fatal}</p>
          <Link href="/">← Home</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <div className="topbar">
        <div style={{ minWidth: 0 }}>
          <div className="tiny muted">
            {state?.title ? state.title : 'Room code'}
            {copied && <span style={{ marginLeft: 8 }}>copied</span>}
          </div>
          <button
            className="ghost"
            onClick={copy}
            style={{ border: 'none', padding: 0, background: 'none' }}
            title="Click to copy"
          >
            <span className="roomcode">{roomId}</span>
          </button>
        </div>

        <div className="row" style={{ marginLeft: 'auto' }}>
          <span className={`pill ${connected ? 'ok' : 'err'}`}>
            <span className={`dot ${connected ? 'ok' : 'err'}`} />
            {connected ? 'connected' : 'connecting…'}
          </span>
          {state && !isCaptureDevice && (
            <span className={`pill ${myLineCount > 0 ? 'ok' : ''}`}>
              {myLineCount > 0
                ? `this device reads ${myLineCount} line${myLineCount === 1 ? '' : 's'}`
                : isAmbienceDevice
                  ? 'ambience only'
                  : 'no lines on this device'}
            </span>
          )}
          {state && !isCaptureDevice && (
            <span className={`pill ${myLineCount > 0 ? 'ok' : ''}`}>
              {myLineCount > 0
                ? `this device reads ${myLineCount} line${myLineCount === 1 ? '' : 's'}`
                : isAmbienceDevice
                  ? 'ambience only'
                  : 'no lines on this device'}
            </span>
          )}
          {isHost && <span className="pill on">host</span>}
          {state?.status === 'playing' && <span className="pill on">▶ reading</span>}
          <Link href="/" className="pill">
            Home
          </Link>
        </div>
      </div>

      {audioState === 'blocked' && (
        <div className="unlock">
          <span>
            This device can&apos;t play audio yet — browsers need one interaction first. Click
            anywhere on the page, or use this button
            {ambienceStatus.isAmbienceDevice || state?.settings.ambienceDevice === deviceId
              ? ' (it also arms the ambience player)'
              : ''}
            .
          </span>
          <button onClick={unlockAudio}>Enable audio</button>
        </div>
      )}

      {isIosLike() && myLineCount > 0 && (
        <p className="sub" style={{ margin: '0 0 10px' }}>
          On iPhone and iPad, flip the ring/silent switch <strong>off</strong>. iOS mutes Web Audio
          when it is on, while the voice previews above keep working — so this device looks
          perfectly healthy and still reads every line silently.
        </p>
      )}

      {audioDiag && audioAnomaly && (
        <p className="tiny muted" style={{ fontFamily: 'var(--mono)', margin: '0 0 10px' }}>
          <button
            className="small ghost"
            style={{ marginRight: 8 }}
            onClick={() => {
              void navigator.clipboard
                ?.writeText(diagLine)
                .then(() => setDiagCopied(true))
                .catch(() => {});
              setTimeout(() => setDiagCopied(false), 1800);
            }}
          >
            {diagCopied ? 'copied' : 'copy audio info'}
          </button>
          {diagLine}
        </p>
      )}

      {ambienceStatus.error && (
        <div className="card" style={{ borderColor: 'rgba(239,111,111,.4)' }}>
          <span className="tiny" style={{ color: 'var(--err)' }}>
            Ambience failed to load: {ambienceStatus.error}
          </span>
        </div>
      )}

      {!state ? (
        <div className="card">
          <p className="muted">Loading room…</p>
        </div>
      ) : !state.locked ? (
        <div className="grid">
          <div>
            {isHost ? (
              <TranscriptUploader roomId={roomId} />
            ) : (
              <div className="card">
                <h2>Waiting for the host to upload a transcript</h2>
                <p className="sub">
                  Once it&apos;s up, the speaker list and your lines show here. Meanwhile, check
                  this device&apos;s name and make sure audio is enabled.
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
              onSetCaptureDevice={(id) => actions.updateSettings({ captureDevice: id })}
              onOpenCompare={() => setCompareOpen(true)}
              canCompare={isHost || state.settings.captureDevice === deviceId}
            />
          </div>
          <div>
            <ToneSettings
              settings={state.settings}
              devices={state.devices}
              meta={meta}
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
              onSetCaptureDevice={(id) => actions.updateSettings({ captureDevice: id })}
              onOpenCompare={() => setCompareOpen(true)}
              canCompare={isHost || state.settings.captureDevice === deviceId}
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
              meta={meta}
              isHost={isHost}
              onChange={actions.updateSettings}
            />
          </div>
        </div>
      )}

      {compareOpen && state && (
        <CompareModal
          meta={meta}
          comparisons={state.comparisons}
          referenceLineCount={state.lineCount}
          glossary={state.settings.glossary}
          onPut={actions.putComparison}
          onScore={actions.scoreComparison}
          onGlossary={actions.setGlossary}
          onClose={() => setCompareOpen(false)}
        />
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
