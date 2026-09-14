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
  // 已经合成过一部分、又有新的待合成 —— 说明是改了角色设定之后的增量
  const isRegen = pending > 0 && ready > 0;

  const silent: Device[] = state.devices.filter(
    (d) => d.online && !d.audioReady && hasWork(d, state.speakers, state)
  );
  const unassigned: Speaker[] = state.speakers.filter((s) => !s.deviceId);

  return (
    <div className="card" style={{ position: 'sticky', top: 16 }}>
      <h2>开场</h2>

      {total > 0 && (
        <div style={{ margin: '10px 0 14px' }}>
          <div className="spread tiny muted" style={{ marginBottom: 5 }}>
            <span>{generating ? '正在合成…' : done ? '音频已就绪' : '待合成'}</span>
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
            {failures.length} 句合成失败：{failures[0].message.slice(0, 90)}
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
                    {generating ? `合成中 ${ready}/${total}` : `合成音频（${pending} 句）`}
                  </button>
                  <p className="tiny muted" style={{ margin: 0 }}>
                    {generating
                      ? '合成期间可以继续调设定，跑完会再扫一遍把新改的补上。'
                      : isRegen
                        ? '角色设定变过了，只有变过的那些角色需要重跑，其余照旧用缓存。'
                        : '先把各角色的音色语气定下来再合成 —— 改一次就要重跑一次。'}
                  </p>
                </>
              )}

              {done && (
                <>
                  <button className="primary big" style={{ width: '100%' }} onClick={onStart}>
                    开始 room
                  </button>
                  <p className="tiny muted" style={{ margin: 0 }}>
                    音频按「文本 + 音色 + instructions」存盘，下次开场直接用缓存，不再花 API 钱。
                  </p>
                </>
              )}
            </div>
          ) : (
            <p className="tiny muted">
              {done ? '等房主按开始。' : generating ? '房主正在合成音频…' : '等房主确认角色设定。'}
            </p>
          )}
        </>
      )}

      {phase === 'preparing' && (
        <div className="stack">
          <span className="pill on">各设备预加载中…{prepareRemaining ? ` 还差 ${prepareRemaining} 台` : ''}</span>
          {isHost && (
            <button className="danger" onClick={onStop}>
              取消
            </button>
          )}
        </div>
      )}

      {phase === 'playing' && (
        <div className="stack">
          <div className="spread">
            <span className="pill on">▶ 进行中</span>
            <span className="tiny muted" style={{ fontFamily: 'var(--mono)' }}>
              {fmt(elapsedMs)} / {fmt(totalMs)}
            </span>
          </div>
          <div className="bar">
            <i style={{ width: `${totalMs ? Math.min(100, (elapsedMs / totalMs) * 100) : 0}%` }} />
          </div>
          {state.settings.orderMode === 'chaotic' && (
            <span className="tiny muted">这一场安排了 {overlaps} 次抢话</span>
          )}
          {isHost && (
            <button className="danger" onClick={onStop}>
              停止
            </button>
          )}
        </div>
      )}

      {(silent.length > 0 || unassigned.length > 0) && phase === 'idle' && (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          {silent.map((d) => (
            <p key={d.id} className="tiny" style={{ color: 'var(--accent)', margin: '0 0 4px' }}>
              ⚠「{d.name}」还没点启用声音{d.id === myDeviceId ? '（就是这台）' : ''}，它负责的部分会是哑的
            </p>
          ))}
          {unassigned.length > 0 && (
            <p className="tiny" style={{ color: 'var(--accent)', margin: 0 }}>
              ⚠ {unassigned.map((s) => s.name).join('、')} 还没分配设备，会落到房主机器上
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
