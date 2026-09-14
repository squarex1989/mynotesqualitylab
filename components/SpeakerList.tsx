'use client';

import { useRef, useState } from 'react';
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
    patch: { voice?: string; config?: Record<string, string>; instructions?: string | null; resetInstructions?: boolean }
  ) => void;
  onRandomize: (name: string) => void;
  onRandomizeAll: () => void;
  onAssign: (name: string, deviceId: string | null) => void;
}

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
        <h2>角色（{speakers.length}）</h2>
        {isHost && (
          <button className="small ghost" onClick={onRandomizeAll}>
            全部重新随机
          </button>
        )}
      </div>
      <p className="sub">
        {meta && <>{meta.voices.length} 个音色可选。</>}性别由音色本身决定，不用单独设。
        调完这里再去右侧点「合成音频」—— 改动不会自动触发 TTS，
        而且只有真正变过的角色需要重跑。
        {meta?.fallbackVoices && (
          <>
            <br />
            <span style={{ color: 'var(--accent)' }}>
              ⚠ 现在用的是内置兜底音色表（只有几个示例）。跑一次{' '}
              <code>node --env-file-if-exists=.env scripts/fetch-fish-voices.mjs</code>{' '}
              从 fish.audio 公开库拉一份带描述的真表。
            </span>
          </>
        )}
      </p>

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
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);

  const dimKeys = meta ? (Object.keys(meta.dimensions) as DimensionKey[]) : [];
  const assigned = devices.find((d) => d.id === speaker.deviceId);
  const voiceInfo = meta?.voices.find((v) => v.id === speaker.voice);

  return (
    <div className={`speaker${speaking ? ' speaking' : ''}`}>
      <div className="spread">
        <div className="row" style={{ gap: 8 }}>
          <strong>{speaker.name}</strong>
          <span className="tiny muted">{speaker.lineCount} 句</span>
          {speaking && <span className="pill on">正在说</span>}
        </div>
        <div className="row" style={{ gap: 6 }}>
          {speaker.sampleHash && (
            <button className="small ghost" onClick={() => onPlaySample(speaker.sampleHash!)}>
              ▶ 试听
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
        <span className="pill">{voiceInfo?.note || ''}</span>
        {(['age', 'tone', 'accent', 'pace'] as DimensionKey[]).map((k) => (
          <span key={k} className="pill">
            {speaker.configLabels[k]}
          </span>
        ))}
      </div>

      {isHost ? (
        <>
          <div className="dims">
            <label className="field">
              音色
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
              朗读设备
              <select
                value={speaker.deviceId ?? ''}
                onChange={(e) => onAssign(speaker.name, e.target.value || null)}
              >
                <option value="">（未分配）</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d.online ? '' : '（离线）'}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div style={{ marginTop: 10 }}>
            <button className="small ghost" onClick={() => setOpen((v) => !v)}>
              {open ? '收起' : '查看/编辑'} 风格标签 {speaker.custom ? '· 已手改' : ''}
            </button>

            {open && (
              <div className="stack" style={{ marginTop: 8 }}>
                <textarea
                  rows={3}
                  value={draft ?? speaker.instructions}
                  onChange={(e) => setDraft(e.target.value)}
                  style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
                />
                <div className="row">
                  <button
                    className="small primary"
                    disabled={draft === null || draft === speaker.instructions}
                    onClick={() => {
                      onUpdate(speaker.name, { instructions: draft });
                      setDraft(null);
                    }}
                  >
                    保存
                  </button>
                  <button
                    className="small ghost"
                    onClick={() => {
                      setDraft(null);
                      onUpdate(speaker.name, { resetInstructions: true });
                    }}
                  >
                    按下拉重新生成
                  </button>
                  {draft !== null && (
                    <button className="small ghost" onClick={() => setDraft(null)}>
                      撤销
                    </button>
                  )}
                </div>
                <p className="tiny muted" style={{ margin: 0 }}>
                  这段文字会以 <code>[方括号]</code> 的形式拼在台词前面发给 Fish{' '}
                  {meta?.model ?? 's2.1-pro'} —— 括号里可以写任意自然语言，
                  比如「疲惫地，几乎在叹气」。标签本身不会被读出来。
                  语速不在这里，它走单独的 <code>prosody.speed</code> 参数。
                </p>
              </div>
            )}
          </div>
        </>
      ) : (
        <p className="tiny muted" style={{ margin: '8px 0 0' }}>
          {voiceInfo?.label ?? speaker.voice} ·{' '}
          {assigned ? `由「${assigned.name}」朗读` : '还没分配设备'}
        </p>
      )}
    </div>
  );
}
