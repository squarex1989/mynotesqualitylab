'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { createdRoomIds } from '@/lib/identity';
import type { RoomSummary } from '@/lib/types';

/**
 * 房主在房间里直接换到自己的另一个房间。选好之后先问一句：
 * 要不要让这个房间里的设备自动跟过去（收音 / 环境音设备角色不变，朗读设备按新房间重新分配）。
 */
export function RoomSwitcher({
  currentRoomId,
  othersOnline,
  onSwitch,
}: {
  currentRoomId: string;
  /** 除了房主这台，房间里还有几台在线设备。0 台就没什么可带的，不用问 */
  othersOnline: number;
  onSwitch: (targetRoomId: string, follow: boolean) => Promise<string | null>;
}) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [target, setTarget] = useState<RoomSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const ids = createdRoomIds().filter((id) => id !== currentRoomId);
    if (!ids.length) return setRooms([]);
    try {
      const { rooms: got } = await api.roomSummaries(ids);
      setRooms(got.sort((a, b) => b.createdAt - a.createdAt));
    } catch {
      /* 列表拉不到就算了，不影响房间本身 */
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRoomId]);

  const go = async (follow: boolean) => {
    if (!target) return;
    setBusy(true);
    setError(null);
    const err = await onSwitch(target.id, follow);
    setBusy(false);
    if (err) setError(err);
    else setTarget(null);
  };

  return (
    <>
      <select
        className="small"
        value=""
        onFocus={() => void load()}
        onChange={(e) => {
          const r = rooms.find((x) => x.id === e.target.value);
          if (!r) return;
          if (othersOnline === 0) {
            // 只有房主自己：直接过去，不弹「要不要带设备」
            void onSwitch(r.id, false).then((err) => err && setError(err));
            return;
          }
          setTarget(r);
        }}
        style={{ width: 'auto', maxWidth: 260 }}
        title="Switch to another room you host"
      >
        <option value="">Switch room…</option>
        {rooms.map((r) => (
          <option key={r.id} value={r.id}>
            {r.id} · {r.title || 'Untitled'}
            {r.locked ? ` (${r.speakerCount} speakers)` : ' (no transcript)'}
          </option>
        ))}
      </select>

      {!target && error && (
        <span className="tiny" style={{ color: 'var(--err)' }}>
          {error}
        </span>
      )}

      {target && (
        <div className="modal-backdrop" onClick={() => !busy && setTarget(null)}>
          <div className="modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>
              Go to {target.id}
              {target.title ? ` · ${target.title}` : ''}
            </h2>
            <p>Have the devices in this room follow you into the new room automatically?</p>
            <p className="sub">
              Capture and ambience devices keep their roles. Readers are reassigned to the new
              room&apos;s {target.locked ? `${target.speakerCount} speakers` : 'speakers'} — if there
              are more devices than speakers, some get no lines.
            </p>
            {error && (
              <p className="tiny" style={{ color: 'var(--err)' }}>
                {error}
              </p>
            )}
            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <button className="primary" disabled={busy} onClick={() => void go(true)}>
                {busy ? 'Moving…' : 'Yes, bring the devices'}
              </button>
              <button disabled={busy} onClick={() => void go(false)}>
                No, just me
              </button>
              <button className="ghost" disabled={busy} onClick={() => setTarget(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
