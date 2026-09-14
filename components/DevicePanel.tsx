'use client';

import { useState } from 'react';
import type { Device, RoomSettings, Speaker } from '@/lib/types';

interface Props {
  devices: Device[];
  speakers: Speaker[];
  settings: RoomSettings;
  myDeviceId: string;
  isHost: boolean;
  onAutoAssign: () => void;
  onRename: (name: string) => void;
  onSetAmbienceDevice: (deviceId: string | null) => void;
}

export function DevicePanel({
  devices,
  speakers,
  settings,
  myDeviceId,
  isHost,
  onAutoAssign,
  onRename,
  onSetAmbienceDevice,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const me = devices.find((d) => d.id === myDeviceId);

  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 4 }}>
        <h2>设备（{devices.filter((d) => d.online).length} 在线）</h2>
        {isHost && (
          <button className="small ghost" onClick={onAutoAssign}>
            重新自动分配
          </button>
        )}
      </div>
      <p className="sub">
        一台设备可以拿到多个角色；只有你一台机器也能跑起来，它会把所有角色都念了。
      </p>

      <div className="stack">
        {devices.map((d) => {
          const mine = speakers.filter((s) => s.deviceId === d.id);
          const isAmbience = settings.ambienceDevice === d.id;
          return (
            <div
              key={d.id}
              className="speaker"
              style={{ borderColor: d.id === myDeviceId ? 'var(--accent)' : undefined }}
            >
              <div className="spread">
                <div className="row" style={{ gap: 8 }}>
                  <span className={`dot ${d.online ? 'ok' : ''}`} />
                  <strong>{d.name}</strong>
                  {d.id === myDeviceId && <span className="pill on">本机</span>}
                  {d.isHost && <span className="pill">房主</span>}
                  {isAmbience && <span className="pill on">环境音源</span>}
                </div>
                <span className={`pill ${d.audioReady ? 'ok' : 'err'}`}>
                  {d.audioReady ? '已启用声音' : '未启用声音'}
                </span>
              </div>

              <div className="row tiny muted" style={{ marginTop: 8, gap: 6 }}>
                {mine.length ? (
                  mine.map((s) => (
                    <span key={s.name} className="pill">
                      {s.name} · {s.lineCount}句
                    </span>
                  ))
                ) : (
                  <span>没有分到角色</span>
                )}
              </div>

              <div className="row" style={{ marginTop: 8, gap: 6 }}>
                {d.id === myDeviceId &&
                  (editing ? (
                    <>
                      <input
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        maxLength={40}
                        style={{ width: 200 }}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && draft.trim()) {
                            onRename(draft.trim());
                            setEditing(false);
                          }
                        }}
                      />
                      <button
                        className="small"
                        onClick={() => {
                          if (draft.trim()) onRename(draft.trim());
                          setEditing(false);
                        }}
                      >
                        保存
                      </button>
                    </>
                  ) : (
                    <button
                      className="small ghost"
                      onClick={() => {
                        setDraft(me?.name ?? '');
                        setEditing(true);
                      }}
                    >
                      改名
                    </button>
                  ))}

                {isHost && settings.noiseMode === 'noisy' && (
                  <button
                    className="small ghost"
                    onClick={() => onSetAmbienceDevice(isAmbience ? null : d.id)}
                  >
                    {isAmbience ? '取消环境音源' : '设为环境音源'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
