'use client';

import { useEffect, useState } from 'react';
import { parseYouTubeId } from '@/lib/ambience';
import type { Device, Meta, RoomSettings } from '@/lib/types';

interface Props {
  settings: RoomSettings;
  devices: Device[];
  meta: Meta | null;
  isHost: boolean;
  onChange: (patch: Partial<RoomSettings>) => void;
}

function Seg<T extends string>({
  value,
  options,
  disabled,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  disabled?: boolean;
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button
          key={o.value}
          className={value === o.value ? 'active' : ''}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ToneSettings({ settings, devices, meta, isHost, onChange }: Props) {
  const [advanced, setAdvanced] = useState(false);

  // 每个场景各存一份链接，所以输入框编辑的是「当前选中场景」那一份
  const scene = settings.ambienceKind;
  const savedUrl = (scene === 'airport' ? settings.ambienceUrlAirport : settings.ambienceUrlCafe) ?? '';
  const urlField = scene === 'airport' ? 'ambienceUrlAirport' : 'ambienceUrlCafe';

  const [url, setUrl] = useState(savedUrl);
  useEffect(() => {
    setUrl(savedUrl);
  }, [savedUrl]);

  const parsed = parseYouTubeId(url);
  const urlDirty = savedUrl !== url;
  const models = meta?.models ?? [];
  const activeModel = models.find((m) => m.id === settings.ttsModel);

  return (
    <div className="card">
      <h2>Room settings</h2>
      <p className="sub">These decide whether the room sounds like a meeting or an argument.</p>

      <div className="stack" style={{ gap: 16 }}>
        <div>
          <div className="spread">
            <span>Reading order</span>
            <Seg
              value={settings.orderMode}
              disabled={!isHost}
              options={[
                { value: 'ordered', label: 'Orderly' },
                { value: 'chaotic', label: 'Chaotic' },
              ]}
              onChange={(v) => onChange({ orderMode: v })}
            />
          </div>
          <p className="tiny muted" style={{ margin: '4px 0 0' }}>
            {settings.orderMode === 'ordered'
              ? 'One line finishes, a short pause, then the next one starts.'
              : `Every ~${Math.round(settings.chaosPeriodMs / 1000)}s someone cuts in: the next line starts 1–3s early and the interrupted one ducks to ${Math.round(settings.duckGain * 100)}%.`}
          </p>
        </div>

        <div>
          <div className="spread">
            <span>Ambience</span>
            <Seg
              value={settings.noiseMode}
              disabled={!isHost}
              options={[
                { value: 'quiet', label: 'Quiet' },
                { value: 'noisy', label: 'Noisy' },
              ]}
              onChange={(v) => onChange({ noiseMode: v })}
            />
          </div>

          {settings.noiseMode === 'noisy' && (
            <div className="stack" style={{ marginTop: 12 }}>
              <div className="spread">
                <span className="tiny muted">Scene</span>
                <Seg
                  value={settings.ambienceKind}
                  disabled={!isHost}
                  options={[
                    { value: 'cafe', label: 'Café' },
                    { value: 'airport', label: 'Airport' },
                  ]}
                  onChange={(v) => onChange({ ambienceKind: v })}
                />
              </div>

              <label className="field">
                YouTube link for {scene === 'cafe' ? 'café' : 'airport'} ambience
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <input
                    value={url}
                    disabled={!isHost}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://www.youtube.com/watch?v=..."
                  />
                  {isHost && (
                    <button
                      className="small"
                      disabled={!urlDirty || (url.trim() !== '' && !parsed)}
                      onClick={() => onChange({ [urlField]: url.trim() || null })}
                    >
                      Save
                    </button>
                  )}
                </div>
              </label>
              {url && !parsed && (
                <p className="tiny" style={{ color: 'var(--err)', margin: 0 }}>
                  Can&apos;t find a YouTube video ID in that link
                </p>
              )}
              {parsed && (
                <p className="tiny muted" style={{ margin: 0 }}>
                  Video ID <code>{parsed.id}</code>
                  {parsed.start ? ` · starts at ${parsed.start}s` : ''} · loops
                  {savedUrl !== url ? ' · unsaved' : ''}
                </p>
              )}

              <label className="field">
                Volume {settings.ambienceVolume}%
                <input
                  type="range"
                  min={0}
                  max={100}
                  disabled={!isHost}
                  value={settings.ambienceVolume}
                  onChange={(e) => onChange({ ambienceVolume: Number(e.target.value) })}
                />
              </label>

              <label className="field">
                Which device plays the ambience
                <select
                  value={settings.ambienceDevice ?? ''}
                  disabled={!isHost}
                  onChange={(e) => onChange({ ambienceDevice: e.target.value || null })}
                >
                  <option value="">(none — no ambience)</option>
                  {devices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                      {d.online ? '' : ' (offline)'}
                    </option>
                  ))}
                </select>
              </label>
              <p className="tiny muted" style={{ margin: 0 }}>
                Once picked, that device&apos;s speakers move to other machines — it just plays the
                room.
              </p>
            </div>
          )}
        </div>

        {models.length > 0 && (
          <div>
            <div className="spread">
              <span>TTS model</span>
              <Seg
                value={settings.ttsModel}
                disabled={!isHost}
                options={models.map((m) => ({ value: m.id, label: m.label }))}
                onChange={(v) => onChange({ ttsModel: v })}
              />
            </div>
            <p className="tiny muted" style={{ margin: '4px 0 0' }}>
              {activeModel?.note}
            </p>
            <p className="tiny" style={{ margin: '4px 0 0', color: 'var(--accent)' }}>
              The model is part of the audio cache key, so switching invalidates every clip in this
              room and you&apos;ll need to synthesize again.
            </p>
          </div>
        )}

        {isHost && (
          <div>
            <button className="small ghost" onClick={() => setAdvanced((v) => !v)}>
              {advanced ? 'Hide' : 'Show'} fine-grained settings
            </button>
            {advanced && (
              <div className="dims" style={{ marginTop: 10 }}>
                <label className="field">
                  Gap between lines {settings.gapMs}ms
                  <input
                    type="range"
                    min={0}
                    max={2000}
                    step={50}
                    value={settings.gapMs}
                    onChange={(e) => onChange({ gapMs: Number(e.target.value) })}
                  />
                </label>
                <label className="field">
                  Interrupt every {Math.round(settings.chaosPeriodMs / 1000)}s
                  <input
                    type="range"
                    min={5}
                    max={60}
                    step={1}
                    value={Math.round(settings.chaosPeriodMs / 1000)}
                    onChange={(e) => onChange({ chaosPeriodMs: Number(e.target.value) * 1000 })}
                  />
                </label>
                <label className="field">
                  Duck interrupted line to {Math.round(settings.duckGain * 100)}%
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={Math.round(settings.duckGain * 100)}
                    onChange={(e) => onChange({ duckGain: Number(e.target.value) / 100 })}
                  />
                </label>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
