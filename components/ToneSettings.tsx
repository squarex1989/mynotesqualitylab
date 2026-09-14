'use client';

import { useEffect, useState } from 'react';
import { parseYouTubeId } from '@/lib/ambience';
import type { Device, RoomSettings } from '@/lib/types';

interface Props {
  settings: RoomSettings;
  devices: Device[];
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

export function ToneSettings({ settings, devices, isHost, onChange }: Props) {
  const [url, setUrl] = useState(settings.ambienceUrl ?? '');
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    setUrl(settings.ambienceUrl ?? '');
  }, [settings.ambienceUrl]);

  const parsed = parseYouTubeId(url);
  const urlDirty = (settings.ambienceUrl ?? '') !== url;

  return (
    <div className="card">
      <h2>房间基调</h2>
      <p className="sub">这两项决定了这屋子听起来像一场会议，还是一场吵架。</p>

      <div className="stack" style={{ gap: 16 }}>
        <div>
          <div className="spread">
            <span>朗读顺序</span>
            <Seg
              value={settings.orderMode}
              disabled={!isHost}
              options={[
                { value: 'ordered', label: '有序' },
                { value: 'chaotic', label: '混乱' },
              ]}
              onChange={(v) => onChange({ orderMode: v })}
            />
          </div>
          <p className="tiny muted" style={{ margin: '4px 0 0' }}>
            {settings.orderMode === 'ordered'
              ? '一句读完停一下，下一句再开口。'
              : `每 ${Math.round(settings.chaosPeriodMs / 1000)} 秒抢一次话：下一句提前 1–3 秒开口，被抢的那句同时压低到 ${Math.round(settings.duckGain * 100)}%。`}
          </p>
        </div>

        <div>
          <div className="spread">
            <span>环境音</span>
            <Seg
              value={settings.noiseMode}
              disabled={!isHost}
              options={[
                { value: 'quiet', label: '安静' },
                { value: 'noisy', label: '嘈杂' },
              ]}
              onChange={(v) => onChange({ noiseMode: v })}
            />
          </div>

          {settings.noiseMode === 'noisy' && (
            <div className="stack" style={{ marginTop: 12 }}>
              <div className="spread">
                <span className="tiny muted">场景</span>
                <Seg
                  value={settings.ambienceKind}
                  disabled={!isHost}
                  options={[
                    { value: 'cafe', label: '咖啡馆' },
                    { value: 'airport', label: '机场' },
                  ]}
                  onChange={(v) => onChange({ ambienceKind: v })}
                />
              </div>

              <label className="field">
                YouTube 链接（{settings.ambienceKind === 'cafe' ? '咖啡馆' : '机场'} 环境音）
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
                      onClick={() => onChange({ ambienceUrl: url.trim() || null })}
                    >
                      保存
                    </button>
                  )}
                </div>
              </label>
              {url && !parsed && (
                <p className="tiny" style={{ color: 'var(--err)', margin: 0 }}>
                  这个链接解析不出视频 ID
                </p>
              )}
              {parsed && (
                <p className="tiny muted" style={{ margin: 0 }}>
                  视频 ID: <code>{parsed.id}</code>
                  {parsed.start ? ` · 从 ${parsed.start}s 开始` : ''} · 会循环播放
                </p>
              )}

              <label className="field">
                音量 {settings.ambienceVolume}%
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
                由哪台设备放环境音
                <select
                  value={settings.ambienceDevice ?? ''}
                  disabled={!isHost}
                  onChange={(e) => onChange({ ambienceDevice: e.target.value || null })}
                >
                  <option value="">（不指定，就没有环境音）</option>
                  {devices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                      {d.online ? '' : '（离线）'}
                    </option>
                  ))}
                </select>
              </label>
              <p className="tiny muted" style={{ margin: 0 }}>
                指定之后，这台设备身上的角色会被挪给别的机器 —— 它专心当那间咖啡馆。
              </p>
            </div>
          )}
        </div>

        {isHost && (
          <div>
            <button className="small ghost" onClick={() => setAdvanced((v) => !v)}>
              {advanced ? '收起' : '更细的参数'}
            </button>
            {advanced && (
              <div className="dims" style={{ marginTop: 10 }}>
                <label className="field">
                  句间停顿 {settings.gapMs}ms
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
                  抢话频率 每 {Math.round(settings.chaosPeriodMs / 1000)}s
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
                  被抢时压到 {Math.round(settings.duckGain * 100)}%
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
