'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { getHostToken, rememberRoom } from '@/lib/identity';
import { useAuth } from '@/lib/auth';
import { AuthBar } from '@/components/AuthBar';
import { useRoom } from '@/lib/useRoom';
import type { Meta } from '@/lib/types';
import { TranscriptUploader } from '@/components/TranscriptUploader';
import { SpeakerList } from '@/components/SpeakerList';
import { DevicePanel } from '@/components/DevicePanel';
import { ToneSettings } from '@/components/ToneSettings';
import { ScriptView } from '@/components/ScriptView';
import { StagePanel } from '@/components/StagePanel';
import { CompareModal, type CompareTab } from '@/components/CompareModal';
import { CompareStatus } from '@/components/CompareStatus';
import { RoomSwitcher } from '@/components/RoomSwitcher';
import { isIosLike } from '@/lib/audioEngine';

export default function RoomPage() {
  const params = useParams<{ id: string }>();
  const roomId = (params?.id ?? '').toUpperCase();

  const [meta, setMeta] = useState<Meta | null>(null);
  const [copied, setCopied] = useState(false);
  // null = 关着；否则是打开时落在哪个 tab
  const [compareTab, setCompareTab] = useState<CompareTab | null>(null);
  const [diagCopied, setDiagCopied] = useState(false);
  const router = useRouter();

  // 房主换房间并让设备跟随时，所有跟随的设备都会收到 room:goto
  const room = useRoom(roomId, { onGoto: (next) => router.push(`/room/${next}`) });
  // 登录后把账号名下房间的 host token 同步到本机（换房间列表要用）
  const auth = useAuth();
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
    waitingAmbience,
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
  const isAmbienceDevice = state?.settings.ambienceDevice === deviceId;
  const isCaptureDevice = Boolean(meRow?.capture);
  // 房主和收音设备能贴转录 / 摘要、发起打分
  const canEditCompare = isHost || isCaptureDevice;
  // 收音设备（不是房主）只干一件事：把各产品的转录和摘要贴进来。
  // 角色、台词、房间设置对它都没用，手机上全铺出来只是让人找不到入口。
  const captureOnly = isCaptureDevice && !isHost;
  // 有任何产品已经打过分 → 谁都能点进去看；一个都没有 → 还没什么可看的，
  // 只让能编辑的人看到入口
  const hasAnyCompareResult = state?.comparisons.some((c) => c.result) ?? false;

  // 一台设备被设成收音设备的那一刻，直接弹出 Compare 并停在 Input，等着贴转录和摘要
  const wasCapture = useRef(false);
  useEffect(() => {
    if (isCaptureDevice && !wasCapture.current) setCompareTab('input');
    wasCapture.current = isCaptureDevice;
  }, [isCaptureDevice]);

  const switchRoom = async (target: string, follow: boolean): Promise<string | null> => {
    // 登录的建房人没有本机 token 也是房主，服务端会按账号认
    const token = getHostToken(target) ?? '';
    if (follow) {
      const res = await actions.moveRoom(target, token, true);
      if (!res.ok) return res.error || 'Could not move the devices';
    }
    router.push(`/room/${target}`);
    return null;
  };

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

  // 开场面板在页面上出现两次（右栏顶部 + Script 旁边），两份完全一样
  const stagePanel = state ? (
      <StagePanel
        state={state}
        progress={progress}
        isHost={isHost}
        phase={phase}
        totalMs={totalMs}
        elapsedMs={elapsedMs}
        overlaps={overlaps}
        prepareRemaining={prepareRemaining}
        waitingAmbience={waitingAmbience}
        myDeviceId={deviceId}
        onStart={actions.start}
        onPause={actions.pause}
        onStop={actions.stop}
        onGenerate={actions.startGeneration}
      />
  ) : null;

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
          <div className="row" style={{ gap: 14 }}>
            <button
              className="ghost"
              onClick={copy}
              style={{ border: 'none', padding: 0, background: 'none' }}
              title="Click to copy"
            >
              <span className="roomcode">{roomId}</span>
            </button>
            {isHost && (
              <RoomSwitcher
                currentRoomId={roomId}
                othersOnline={state?.devices.filter((d) => d.online && d.id !== deviceId).length ?? 0}
                onSwitch={switchRoom}
              />
            )}
          </div>
        </div>

        <div className="row" style={{ marginLeft: 'auto' }}>
          <span className={`pill ${connected ? 'ok' : 'err'}`}>
            <span className={`dot ${connected ? 'ok' : 'err'}`} />
            {connected ? 'connected' : 'connecting…'}
          </span>
          {state && (
            <span className={`pill ${myLineCount > 0 ? 'ok' : ''}`}>
              {isCaptureDevice
                ? 'capture device'
                : myLineCount > 0
                ? `this device reads ${myLineCount} line${myLineCount === 1 ? '' : 's'}`
                : isAmbienceDevice
                  ? 'ambience only'
                  : 'no lines on this device'}
            </span>
          )}
          {isHost && <span className="pill on">host</span>}
          {state?.status === 'playing' && <span className="pill on">▶ reading</span>}
          {auth.user && <AuthBar auth={auth} compact />}
          <Link href="/" className="pill">
            Home
          </Link>
        </div>
      </div>

      {audioState === 'blocked' && (!captureOnly || isAmbienceDevice) && (
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

      {state && (
        <CompareStatus
          meta={meta}
          comparisons={state.comparisons}
          onOpen={
            canEditCompare
              ? // 房主有结果时先看结果；收音设备的活就是贴，直接进 Input
                () => setCompareTab(isHost && hasAnyCompareResult ? 'result' : 'input')
              : hasAnyCompareResult
                ? () => setCompareTab('result')
                : undefined
          }
        />
      )}

      {state && captureOnly ? (
        <>
          <div className="card">
            <h2>This is the capture device</h2>
            <p className="sub">
              Record the meeting in My Notes, Granola and Otter on this device. When the reading is
              done, copy each product&apos;s transcript and summary and paste them here.
            </p>
            <button className="primary big" style={{ width: '100%' }} onClick={() => setCompareTab('input')}>
              Paste transcripts &amp; summaries
            </button>
            {hasAnyCompareResult && (
              <button style={{ width: '100%', marginTop: 8 }} onClick={() => setCompareTab('result')}>
                View results
              </button>
            )}
          </div>
          <DevicePanel
            devices={state.devices}
            speakers={state.speakers}
            settings={state.settings}
            myDeviceId={deviceId}
            isHost={isHost}
            onAutoAssign={actions.autoAssign}
            onRename={actions.renameDevice}
            onSetAmbienceDevice={(id) => actions.updateSettings({ ambienceDevice: id })}
            onSetCapture={actions.setCapture}
          />
        </>
      ) : !state ? (
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
              onSetCapture={actions.setCapture}
            />
          </div>
          <div>
            <ToneSettings
              settings={state.settings}
              devices={state.devices}
              meta={meta}
              isHost={isHost}
              scriptMode={state.scriptMode}
              onChange={actions.updateSettings}
            />
          </div>
        </div>
      ) : (
        <>
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
              onSetCapture={actions.setCapture}
            />
          </div>

          <div>
            {stagePanel}
            <ToneSettings
              settings={state.settings}
              devices={state.devices}
              meta={meta}
              isHost={isHost}
              scriptMode={state.scriptMode}
              onChange={actions.updateSettings}
            />
          </div>
        </div>
        {/* 台词很长，读的时候人在下面看台词；旁边再放一份一模一样的开场面板，
            吸顶跟着滚，不用滚回页面顶上去点开始 / 停止 */}
        <div className="grid">
          <div>
            <ScriptView
              roomId={roomId}
              hasAnswerKey={state.hasAnswerKey}
              lines={lines}
              progress={progress}
              schedule={schedule}
              activeIdxs={activeIdxs}
              currentIdx={currentIdx}
              playing={phase === 'playing'}
              onPlayFrom={isHost ? (idx) => actions.start(idx) : undefined}
            />
          </div>
          <div className="sticky-col">{stagePanel}</div>
        </div>
        </>
      )}

      {compareTab && state && (
        <CompareModal
          // 换房间时重新挂载，草稿不能带到别的房间
          key={roomId}
          meta={meta}
          canEdit={canEditCompare}
          comparisons={state.comparisons}
          referenceLineCount={state.lineCount}
          glossary={state.settings.glossary}
          initialTab={compareTab}
          onPut={actions.putComparison}
          onScore={actions.scoreComparison}
          onGlossary={actions.setGlossary}
          onClose={() => setCompareTab(null)}
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
