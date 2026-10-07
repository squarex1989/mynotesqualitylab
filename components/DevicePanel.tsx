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
  onSetCapture: (deviceId: string, on: boolean) => void;
}

/*
 * 设备的三种角色：
 *   朗读设备   —— 默认，按角色数分到台词
 *   环境音设备 —— 放 YouTube 环境音，可以同时念台词（自动分配时尽量不让它兼职）
 *   收音设备   —— 跑 My Notes / Granola / Otter 录音的那台，绝不念台词；
 *                 它会直接看到 Compare 弹窗，等着贴转录和摘要
 */

export function DevicePanel({
  devices,
  speakers,
  settings,
  myDeviceId,
  isHost,
  onAutoAssign,
  onRename,
  onSetAmbienceDevice,
  onSetCapture,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const me = devices.find((d) => d.id === myDeviceId);

  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 4 }}>
        <h2>Devices ({devices.filter((d) => d.online).length} online)</h2>
        {isHost && (
          <button className="small ghost" onClick={onAutoAssign}>
            Reassign automatically
          </button>
        )}
      </div>
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
                  {d.id === myDeviceId && <span className="pill on">this device</span>}
                  {d.isHost && <span className="pill">host</span>}
                  {d.capture ? (
                    <span className="pill on">capture</span>
                  ) : (
                    <span className="pill">reader</span>
                  )}
                  {isAmbience && <span className="pill on">ambience</span>}
                </div>
                {/* 收音设备不出声，声音解没解锁跟它无关（除非它还兼着环境音） */}
                {(!d.capture || isAmbience) && (
                  <span className={`pill ${d.audioReady ? 'ok' : 'err'}`}>
                    {d.audioReady ? 'audio ready' : 'audio blocked'}
                  </span>
                )}
              </div>

              <div className="row tiny muted" style={{ marginTop: 8, gap: 6 }}>
                {d.capture ? (
                  <span>records the meeting — never reads a line</span>
                ) : mine.length ? (
                  mine.map((s) => (
                    <span key={s.name} className="pill">
                      {s.name} · {s.lineCount} lines
                    </span>
                  ))
                ) : (
                  <span>no speakers assigned</span>
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
                        Save
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
                      Rename
                    </button>
                  ))}

                {isHost && (
                  <button className="small ghost" onClick={() => onSetCapture(d.id, !d.capture)}>
                    {d.capture ? 'Make it a reader' : 'Use as capture device'}
                  </button>
                )}

                {isHost && settings.noiseMode === 'noisy' && (
                  <button
                    className="small ghost"
                    onClick={() => onSetAmbienceDevice(isAmbience ? null : d.id)}
                  >
                    {isAmbience ? 'Stop being ambience source' : 'Use as ambience source'}
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
