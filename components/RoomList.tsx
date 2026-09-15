'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { createdRoomIds, forgetRoom, getHostToken } from '@/lib/identity';
import { clampTitle, titleWeight, TITLE_MAX_WEIGHT } from '@/lib/roomName';
import type { RoomSummary } from '@/lib/types';

/** 我创建的房间 = 本机存着 host token 的那些。换台机器就看不到了，这是本地记录不是账号。 */
export function RoomList({ refreshKey }: { refreshKey: number }) {
  const router = useRouter();
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const ids = createdRoomIds();
    if (!ids.length) {
      setRooms([]);
      return;
    }
    try {
      const { rooms: got } = await api.roomSummaries(ids);
      // 服务端查不到的（房间被删过 / 换了数据盘）顺手把本地记录也清掉
      const alive = new Set(got.map((r) => r.id));
      ids.filter((id) => !alive.has(id)).forEach(forgetRoom);
      setRooms(got.sort((a, b) => b.createdAt - a.createdAt));
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const rename = async (id: string) => {
    const token = getHostToken(id);
    if (!token) return;
    setBusy(id);
    try {
      await api.renameRoom(id, token, draft);
      setEditing(null);
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    const token = getHostToken(id);
    if (!token) return;
    setBusy(id);
    try {
      await api.deleteRoom(id, token);
      forgetRoom(id);
      setConfirmingDelete(null);
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  if (rooms === null) {
    return (
      <div className="card">
        <h2>Your rooms</h2>
        <p className="sub" style={{ margin: 0 }}>
          Loading…
        </p>
      </div>
    );
  }

  if (!rooms.length) {
    return (
      <div className="card">
        <h2>Your rooms</h2>
        <p className="sub" style={{ margin: 0 }}>
          Rooms you create show up here. They&apos;re remembered on this device only — there are no
          accounts.
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 4 }}>
        <h2>Your rooms ({rooms.length})</h2>
        <button className="small ghost" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <p className="sub">Remembered on this device only — there are no accounts.</p>

      <div className="stack">
        {rooms.map((r) => {
          const isEditing = editing === r.id;
          const isConfirming = confirmingDelete === r.id;
          const weight = titleWeight(draft);
          return (
            <div key={r.id} className="speaker">
              <div className="spread">
                <div className="row" style={{ gap: 8, minWidth: 0 }}>
                  <code style={{ color: 'var(--accent)', letterSpacing: '0.1em' }}>{r.id}</code>
                  {!isEditing && (
                    <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {r.title || <span className="muted">Untitled</span>}
                    </strong>
                  )}
                  {r.status === 'playing' && <span className="pill on">▶ reading</span>}
                </div>
                <span className="tiny muted" style={{ whiteSpace: 'nowrap' }}>
                  {r.locked ? `${r.lineCount} lines · ${r.speakerCount} speakers` : 'no transcript'}
                </span>
              </div>

              {isEditing ? (
                <div className="row" style={{ marginTop: 8, flexWrap: 'nowrap' }}>
                  <input
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(clampTitle(e.target.value))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void rename(r.id);
                      if (e.key === 'Escape') setEditing(null);
                    }}
                    placeholder="Room name"
                  />
                  <span className="tiny muted" style={{ whiteSpace: 'nowrap' }}>
                    {weight}/{TITLE_MAX_WEIGHT}
                  </span>
                  <button className="small primary" disabled={busy === r.id} onClick={() => void rename(r.id)}>
                    Save
                  </button>
                  <button className="small ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              ) : isConfirming ? (
                <div className="row" style={{ marginTop: 8 }}>
                  <span className="tiny" style={{ color: 'var(--err)' }}>
                    Delete {r.id} for good? The transcript and its settings are gone — this can&apos;t
                    be undone.
                  </span>
                  <button className="small danger" disabled={busy === r.id} onClick={() => void remove(r.id)}>
                    {busy === r.id ? 'Deleting…' : 'Yes, delete'}
                  </button>
                  <button className="small ghost" onClick={() => setConfirmingDelete(null)}>
                    Keep it
                  </button>
                </div>
              ) : (
                <div className="row" style={{ marginTop: 8, gap: 6 }}>
                  <button className="small" onClick={() => router.push(`/room/${r.id}`)}>
                    Open
                  </button>
                  <button
                    className="small ghost"
                    onClick={() => {
                      setDraft(r.title ?? '');
                      setConfirmingDelete(null);
                      setEditing(r.id);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    className="small ghost"
                    onClick={() => {
                      setEditing(null);
                      setConfirmingDelete(r.id);
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <p className="tiny" style={{ color: 'var(--err)', marginBottom: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}
