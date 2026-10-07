'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { createdRoomIds, forgetRoom, getHostToken, recentRooms, RECENT_LIMIT } from '@/lib/identity';
import { clampTitle, titleWeight, TITLE_MAX_WEIGHT } from '@/lib/roomName';
import type { RoomSummary } from '@/lib/types';

const PAGE_SIZE = 100;

type Tab = 'mine' | 'recent';

/**
 * 首页右栏的 Rooms：
 *   Your rooms —— 本机存着 host token 的那些（我创建 / 导入的），全部列出，新的在前，100 个一页
 *   Recent     —— 本机最近进入过的房间（不管是不是我建的），最近的在前，最多 100 个
 * 两个列表都是本地记录，不是账号 —— 换台机器就看不到了。
 */
export function RoomList({ refreshKey }: { refreshKey: number }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('mine');
  const [mine, setMine] = useState<RoomSummary[] | null>(null);
  const [recent, setRecent] = useState<RoomSummary[] | null>(null);
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    const own = createdRoomIds();
    const seen = recentRooms().slice(0, RECENT_LIMIT);
    const ids = [...new Set([...own, ...seen])];
    if (!ids.length) {
      setMine([]);
      setRecent([]);
      return;
    }
    try {
      const { rooms: got } = await api.roomSummaries(ids);
      const byId = new Map(got.map((r) => [r.id, r]));
      // 服务端查不到的（房间被删过 / 换了数据盘）顺手把本地记录也清掉
      ids.filter((id) => !byId.has(id)).forEach(forgetRoom);
      setMine(own.map((id) => byId.get(id)).filter((r): r is RoomSummary => !!r).sort((a, b) => b.createdAt - a.createdAt));
      setRecent(seen.map((id) => byId.get(id)).filter((r): r is RoomSummary => !!r));
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const list = tab === 'mine' ? mine : recent;
  const pages = tab === 'mine' && mine ? Math.max(1, Math.ceil(mine.length / PAGE_SIZE)) : 1;
  const safePage = Math.min(page, pages - 1);
  const shown = useMemo(
    () => (tab === 'mine' ? (mine ?? []).slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE) : recent ?? []),
    [tab, mine, recent, safePage]
  );

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

  const pager =
    tab === 'mine' && pages > 1 ? (
      <div className="row" style={{ justifyContent: 'center', gap: 8, margin: '10px 0 0' }}>
        <button className="small" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
          ← Prev
        </button>
        <span className="tiny muted">
          Page {safePage + 1} / {pages}
        </span>
        <button className="small" disabled={safePage >= pages - 1} onClick={() => setPage(safePage + 1)}>
          Next →
        </button>
      </div>
    ) : null;

  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 4 }}>
        <h2>Rooms</h2>
        <button className="small ghost" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      <div className="tabs" style={{ marginTop: 2 }}>
        <button className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>
          Your rooms{mine ? ` (${mine.length})` : ''}
        </button>
        <button className={tab === 'recent' ? 'active' : ''} onClick={() => setTab('recent')}>
          Recent{recent ? ` (${recent.length})` : ''}
        </button>
      </div>

      <p className="sub" style={{ marginTop: -4 }}>
        {tab === 'mine'
          ? `Rooms you created or imported on this device, newest first, ${PAGE_SIZE} per page.`
          : `Rooms you entered on this device, most recent first (up to ${RECENT_LIMIT}).`}
      </p>

      {list === null ? (
        <p className="sub" style={{ margin: 0 }}>
          Loading…
        </p>
      ) : !list.length ? (
        <p className="sub" style={{ margin: 0 }}>
          {tab === 'mine' ? 'Rooms you create or import show up here.' : 'Rooms you open show up here.'}
        </p>
      ) : (
        <>
          {pager}
          <div className="room-rows">
            {shown.map((r) => {
              const isEditing = editing === r.id;
              const isConfirming = confirmingDelete === r.id;
              const canManage = Boolean(getHostToken(r.id));
              return (
                <div key={r.id} className="room-row">
                  <div className="room-row-main" onClick={() => !isEditing && router.push(`/room/${r.id}`)}>
                    <code style={{ color: 'var(--accent)', letterSpacing: '0.08em' }}>{r.id}</code>
                    {!isEditing && (
                      <span className="room-row-title">{r.title || <span className="muted">Untitled</span>}</span>
                    )}
                    {r.status === 'playing' && <span className="pill on">▶ reading</span>}
                    <span className="tiny muted room-row-meta">
                      {r.locked ? `${r.lineCount} lines · ${r.speakerCount} sp` : 'no transcript'}
                    </span>
                  </div>

                  {isEditing ? (
                    <div className="row" style={{ marginTop: 6, flexWrap: 'nowrap' }}>
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
                        {titleWeight(draft)}/{TITLE_MAX_WEIGHT}
                      </span>
                      <button className="small primary" disabled={busy === r.id} onClick={() => void rename(r.id)}>
                        Save
                      </button>
                      <button className="small ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : isConfirming ? (
                    <div className="row" style={{ marginTop: 6 }}>
                      <span className="tiny" style={{ color: 'var(--err)' }}>
                        Delete {r.id} for good? This can&apos;t be undone.
                      </span>
                      <button className="small danger" disabled={busy === r.id} onClick={() => void remove(r.id)}>
                        {busy === r.id ? 'Deleting…' : 'Yes, delete'}
                      </button>
                      <button className="small ghost" onClick={() => setConfirmingDelete(null)}>
                        Keep it
                      </button>
                    </div>
                  ) : (
                    canManage && (
                      <div className="room-row-actions">
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
                    )
                  )}
                </div>
              );
            })}
          </div>
          {pager}
        </>
      )}

      {error && (
        <p className="tiny" style={{ color: 'var(--err)', marginBottom: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}
