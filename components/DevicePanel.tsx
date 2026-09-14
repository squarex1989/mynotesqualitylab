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
        <h2>Devices ({devices.filter((d) => d.online).length} online)</h2>
        {isHost && (
          <button className="small ghost" onClick={onAutoAssign}>
            Reassign automatically
          </button>
        )}
      </div>
      <p className="sub">
        One device can hold several speakers. A single machine works fine too — it just reads
        everyone.
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
                  {d.id === myDeviceId && <span className="pill on">this device</span>}
                  {d.isHost && <span className="pill">host</span>}
                  {isAmbience && <span className="pill on">ambience</span>}
                </div>
                <span className={`pill ${d.audioReady ? 'ok' : 'err'}`}>
                  {d.audioReady ? 'audio ready' : 'audio blocked'}
                </span>
              </div>

              <div className="row tiny muted" style={{ marginTop: 8, gap: 6 }}>
                {mine.length ? (
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
