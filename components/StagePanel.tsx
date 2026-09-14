'use client';

import type { Device, Progress, RoomState, Speaker } from '@/lib/types';
import type { Phase } from '@/lib/useRoom';

interface Props {
  state: RoomState;
  progress: Progress | null;
  isHost: boolean;
  phase: Phase;
  totalMs: number;
  elapsedMs: number;
  overlaps: number;
  prepareRemaining: number;
  myDeviceId: string;
  onStart: () => void;
  onStop: () => void;
  onGenerate: () => void;
}

function fmt(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function StagePanel({
  state,
  progress,
  isHost,
  phase,
  totalMs,
  elapsedMs,
  overlaps,
  prepareRemaining,
  myDeviceId,
  onStart,
  onStop,
  onGenerate,
}: Props) {
  const ready = progress ? progress.ready : 0;
  const total = progress ? progress.total : 0;
  const pct = total ? Math.round((ready / total) * 100) : 0;
  const done = total > 0 && ready === total;
  const generating = Boolean(progress?.generating);
  const pending = total - ready;
  const failures = progress?.failures ?? [];
  // Some clips exist and some are pending — so this is an incremental re-run after edits
  const isRegen = pending > 0 && ready > 0;

  const silent: Device[] = state.devices.filter(
    (d) => d.online && !d.audioReady && hasWork(d, state.speakers, state)
  );
  const unassigned: Speaker[] = state.speakers.filter((s) => !s.deviceId);

  return (
    <div className="card" style={{ position: 'sticky', top: 16 }}>
      <h2>Curtain up</h2>

      {total > 0 && (
        <div style={{ margin: '10px 0 14px' }}>
          <div className="spread tiny muted" style={{ marginBottom: 5 }}>
            <span>{generating ? 'Synthesizing…' : done ? 'Audio ready' : 'Not synthesized'}</span>
            <span>
              {ready}/{total} · {pct}%
            </span>
          </div>
          <div className="bar">
            <i style={{ width: `${pct}%` }} />
          </div>
          <div className="mask" style={{ marginTop: 8 }}>
            {progress?.mask.map((m, i) => (
              <i
                key={i}
                className={failures.some((f) => f.idx === i) ? 'failed' : m ? 'done' : ''}
              />
            ))}
          </div>
        </div>
      )}

      {failures.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <p className="tiny" style={{ color: 'var(--err)', margin: 0 }}>
            {failures.length} line(s) failed: {failures[0].message.slice(0, 90)}
          </p>
        </div>
      )}

      {phase === 'idle' && (
        <>
          {isHost ? (
            <div className="stack">
              {!done && (
                <>
                  <button
                    className="primary big"
                    style={{ width: '100%' }}
                    disabled={generating || total === 0}
                    onClick={onGenerate}
                  >
                    {generating ? `Synthesizing ${ready}/${total}` : `Synthesize audio (${pending} lines)`}
                  </button>
                  <p className="tiny muted" style={{ margin: 0 }}>
                    {generating
                      ? 'You can keep tuning while this runs — it rescans afterwards and picks up anything you changed.'
                      : isRegen
                        ? 'Speaker settings changed. Only the speakers that actually changed get re-synthesized; the rest stay cached.'
                        : 'Settle on the voices first — every change means re-synthesizing that speaker.'}
                  </p>
                </>
              )}

              {done && (
                <>
                  <button className="primary big" style={{ width: '100%' }} onClick={onStart}>
                    Start room
                  </button>
                  <p className="tiny muted" style={{ margin: 0 }}>
                    Clips are stored by model + voice + style + text, so the next run reuses them
                    and costs nothing.
                  </p>
                </>
              )}
            </div>
          ) : (
            <p className="tiny muted">
              {done
                ? 'Waiting for the host to start.'
                : generating
                  ? 'The host is synthesizing audio…'
                  : 'Waiting for the host to confirm the speaker settings.'}
            </p>
          )}
        </>
      )}

      {phase === 'preparing' && (
        <div className="stack">
          <span className="pill on">
            Devices preloading…{prepareRemaining ? ` ${prepareRemaining} to go` : ''}
          </span>
          {isHost && (
            <button className="danger" onClick={onStop}>
              Cancel
            </button>
          )}
        </div>
      )}

      {phase === 'playing' && (
        <div className="stack">
          <div className="spread">
            <span className="pill on">▶ Playing</span>
            <span className="tiny muted" style={{ fontFamily: 'var(--mono)' }}>
              {fmt(elapsedMs)} / {fmt(totalMs)}
            </span>
          </div>
          <div className="bar">
            <i style={{ width: `${totalMs ? Math.min(100, (elapsedMs / totalMs) * 100) : 0}%` }} />
          </div>
          {state.settings.orderMode === 'chaotic' && (
            <span className="tiny muted">{overlaps} interruptions scheduled for this run</span>
          )}
          {isHost && (
            <button className="danger" onClick={onStop}>
              Stop
            </button>
          )}
        </div>
      )}

      {(silent.length > 0 || unassigned.length > 0) && phase === 'idle' && (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          {silent.map((d) => (
            <p key={d.id} className="tiny" style={{ color: 'var(--accent)', margin: '0 0 4px' }}>
              ⚠ {d.name}{d.id === myDeviceId ? ' (this device)' : ''} can&apos;t play audio yet — its
              lines will be silent
            </p>
          ))}
          {unassigned.length > 0 && (
            <p className="tiny" style={{ color: 'var(--accent)', margin: 0 }}>
              ⚠ {unassigned.map((s) => s.name).join(', ')} have no device — they fall back to the
              host machine
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function hasWork(device: Device, speakers: Speaker[], state: RoomState) {
  if (speakers.some((s) => s.deviceId === device.id)) return true;
  return state.settings.noiseMode === 'noisy' && state.settings.ambienceDevice === device.id;
}
