'use client';

import { useRef } from 'react';
import { audioUrl } from '@/lib/api';
import type { Device, DimensionKey, Meta, Speaker } from '@/lib/types';

interface Props {
  speakers: Speaker[];
  devices: Device[];
  meta: Meta | null;
  isHost: boolean;
  speaking: Set<string>;
  onUpdate: (
    name: string,
    patch: {
      voice?: string;
      config?: Record<string, string>;
      volume?: number;
      instructions?: string | null;
      resetInstructions?: boolean;
    }
  ) => void;
  onRandomize: (name: string) => void;
  onRandomizeAll: () => void;
  onAssign: (name: string, deviceId: string | null) => void;
}

// 0 表示静音，其余 20–100。用离散选项而不是滑块 —— 1–19 是无效区间，
// 滑块会让人以为能拖到那里去。
const VOLUME_OPTIONS = [100, 90, 80, 70, 60, 50, 40, 30, 20, 0];
const volumeLabel = (v: number) => (v === 0 ? 'Muted' : `${v}%`);

export function SpeakerList({
  speakers,
  devices,
  meta,
  isHost,
  speaking,
  onUpdate,
  onRandomize,
  onRandomizeAll,
  onAssign,
}: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const playSample = (hash: string) => {
    if (!audioRef.current) audioRef.current = new Audio();
    audioRef.current.pause();
    audioRef.current.src = audioUrl(hash);
    void audioRef.current.play().catch(() => {});
  };

  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 4 }}>
        <h2>Speakers ({speakers.length})</h2>
        {isHost && (
          <button className="small ghost" onClick={onRandomizeAll}>
            Randomize all
          </button>
        )}
      </div>
      {meta?.fallbackVoices && (
        <p className="sub" style={{ color: 'var(--accent)' }}>
          ⚠ Using the built-in fallback voice list (just a few samples). Run{' '}
          <code>scripts/voices-from-ids.mjs</code> or <code>scripts/fetch-fish-voices.mjs</code> to
          pull a real catalogue from fish.audio.
        </p>
      )}

      {speakers.map((s) => (
        <SpeakerCard
          key={s.name}
          speaker={s}
          devices={devices}
          meta={meta}
          isHost={isHost}
          speaking={speaking.has(s.name)}
          onUpdate={onUpdate}
          onRandomize={onRandomize}
          onAssign={onAssign}
          onPlaySample={playSample}
        />
      ))}
    </div>
  );
}

function SpeakerCard({
  speaker,
  devices,
  meta,
  isHost,
  speaking,
  onUpdate,
  onRandomize,
  onAssign,
  onPlaySample,
}: {
  speaker: Speaker;
  devices: Device[];
  meta: Meta | null;
  isHost: boolean;
  speaking: boolean;
  onUpdate: Props['onUpdate'];
  onRandomize: Props['onRandomize'];
  onAssign: Props['onAssign'];
  onPlaySample: (hash: string) => void;
}) {
  const dimKeys = meta ? (Object.keys(meta.dimensions) as DimensionKey[]) : [];
  const assigned = devices.find((d) => d.id === speaker.deviceId);
  const voiceInfo = meta?.voices.find((v) => v.id === speaker.voice);

  return (
    <div className={`speaker${speaking ? ' speaking' : ''}`}>
      <div className="spread">
        <div className="row" style={{ gap: 8 }}>
          <strong>{speaker.name}</strong>
          <span className="tiny muted">{speaker.lineCount} lines</span>
          {speaking && <span className="pill on">speaking</span>}
        </div>
        <div className="row" style={{ gap: 6 }}>
          {speaker.sampleHash && (
            <button className="small ghost" onClick={() => onPlaySample(speaker.sampleHash!)}>
              ▶ Preview
            </button>
          )}
          {isHost && (
            <button className="small ghost" onClick={() => onRandomize(speaker.name)}>
              🎲
            </button>
          )}
        </div>
      </div>

      <div className="row tiny muted" style={{ marginTop: 6, gap: 6 }}>
        <span className="pill">{voiceInfo?.label ?? speaker.voice}</span>
        {voiceInfo?.languages?.length ? (
          <span className="pill">{voiceInfo.languages.join('/')}</span>
        ) : null}
        <span className="pill">{speaker.configLabels.pace}</span>
        {speaker.volume !== 100 && (
          <span className={`pill${speaker.volume === 0 ? ' err' : ' on'}`}>
            {volumeLabel(speaker.volume)}
          </span>
        )}
        {voiceInfo?.note ? <span className="pill">{voiceInfo.note}</span> : null}
      </div>

      {isHost ? (
        <>
          <div className="dims">
            <label className="field">
              Voice
              <select
                value={speaker.voice}
                onChange={(e) => onUpdate(speaker.name, { voice: e.target.value })}
              >
                {meta?.voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {[v.label, v.languages?.length ? v.languages.join('/') : '', v.note]
                      .filter(Boolean)
                      .join(' · ')}
                  </option>
                ))}
              </select>
            </label>

            {dimKeys.map((key) => (
              <label className="field" key={key}>
                {meta!.dimensions[key].label}
                <select
                  value={speaker.config[key]}
                  onChange={(e) => onUpdate(speaker.name, { config: { [key]: e.target.value } })}
                >
                  {meta!.dimensions[key].options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}

            <label className="field">
              Volume
              <select
                value={speaker.volume}
                onChange={(e) =>
                  onUpdate(speaker.name, { volume: Number(e.target.value) })
                }
              >
                {VOLUME_OPTIONS.map((v) => (
                  <option key={v} value={v}>
                    {volumeLabel(v)}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              Read by
              <select
                value={speaker.deviceId ?? ''}
                onChange={(e) => onAssign(speaker.name, e.target.value || null)}
              >
                <option value="">(unassigned)</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d.online ? '' : ' (offline)'}
                  </option>
                ))}
              </select>
            </label>
          </div>

        </>
      ) : (
        <p className="tiny muted" style={{ margin: '8px 0 0' }}>
          {voiceInfo?.label ?? speaker.voice} ·{' '}
          {assigned ? `read by ${assigned.name}` : 'no device assigned'}
          {speaker.volume !== 100 ? ` · ${volumeLabel(speaker.volume)}` : ''}
        </p>
      )}
    </div>
  );
}
