'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import type { ReportListItem, RoomSummary } from '@/lib/types';

const PHASE: Record<string, string> = {
  queued: 'Queued',
  scoring: 'Scoring missing evaluations',
  aggregating: 'Aggregating',
  summarizing: 'Writing the AI summary',
  done: 'Done',
};

function when(ts: number) {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * 首页 Rooms 卡片里的 Reports 标签：手动生成的综合报告列表。
 * 顶部「Generate report」从自己的房间里多选 / 全选（最多 1000 个）。
 */
export function ReportsPanel({ rooms }: { rooms: RoomSummary[] }) {
  const [reports, setReports] = useState<ReportListItem[] | null>(null);
  const [maxRooms, setMaxRooms] = useState(1000);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await api.listReports();
      setReports(r.reports);
      setMaxRooms(r.maxRooms);
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  // 有报告在跑就每 2 秒刷新一次进度
  const running = reports?.some((r) => r.state === 'running');
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [running]);

  const remove = async (id: string) => {
    try {
      await api.deleteReport(id);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <>
      <button className="primary" style={{ width: '100%', marginBottom: 10 }} onClick={() => setPicking(true)}>
        Generate report
      </button>

      {reports === null ? (
        <p className="sub" style={{ margin: 0 }}>
          Loading…
        </p>
      ) : !reports.length ? (
        <p className="sub" style={{ margin: 0 }}>
          No reports yet. A report combines the evaluation results of the rooms you pick into one
          comparison of My Notes, Granola and Otter.
        </p>
      ) : (
        <div className="room-rows">
          {reports.map((r) => (
            <div key={r.id} className="room-row">
              <Link href={`/report/${r.id}`} className="room-row-main" style={{ color: 'inherit', textDecoration: 'none' }}>
                <span className="room-row-title">{r.title}</span>
                <span className="tiny muted room-row-meta">
                  {r.roomCount} rooms · {when(r.createdAt)}
                </span>
              </Link>
              <span className={`pill ${r.state === 'done' ? 'ok' : r.state === 'failed' ? 'err' : 'on'}`}>
                {r.state === 'running'
                  ? `${PHASE[r.progress?.phase ?? 'queued'] ?? r.progress?.phase}${r.progress?.total ? ` ${r.progress.done}/${r.progress.total}` : ''}…`
                  : r.state}
              </span>
              <button className="small ghost" onClick={() => void remove(r.id)}>
                Delete
              </button>
            </div>
          ))}
        </div>
      )}

      {error && (
        <p className="tiny" style={{ color: 'var(--err)', marginBottom: 0 }}>
          {error}
        </p>
      )}

      {picking && (
        <GenerateDialog
          rooms={rooms}
          maxRooms={maxRooms}
          onClose={() => setPicking(false)}
          onCreated={() => {
            setPicking(false);
            void load();
          }}
        />
      )}
    </>
  );
}

function GenerateDialog({
  rooms,
  maxRooms,
  onClose,
  onCreated,
}: {
  rooms: RoomSummary[];
  maxRooms: number;
  onClose: () => void;
  onCreated: () => void;
}) {
  // 没有 transcript 的房间没法评估，不让选
  const eligible = useMemo(() => rooms.filter((r) => r.locked), [rooms]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState('');
  const [scoreMissing, setScoreMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? eligible.filter((r) => `${r.id} ${r.title ?? ''}`.toLowerCase().includes(q)) : eligible;
  }, [eligible, query]);

  const allShownSelected = shown.length > 0 && shown.every((r) => selected.has(r.id));
  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allShownSelected) shown.forEach((r) => next.delete(r.id));
      else for (const r of shown) {
        if (next.size >= maxRooms) break;
        next.add(r.id);
      }
      return next;
    });
  };
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < maxRooms) next.add(id);
      return next;
    });

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.createReport({ roomIds: [...selected], title: title.trim() || undefined, scoreMissing });
      onCreated();
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="spread" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Generate report</h2>
          <button className="small ghost" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>

        <label className="field" style={{ marginBottom: 10 }}>
          Title (optional)
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Week 41 — EN chaotic rooms" maxLength={120} />
        </label>

        <div className="row" style={{ gap: 8, marginBottom: 8, flexWrap: 'nowrap' }}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by code or name" />
          <button className="small" onClick={toggleAll} disabled={!shown.length} style={{ whiteSpace: 'nowrap' }}>
            {allShownSelected ? 'Clear' : query ? `Select ${Math.min(shown.length, maxRooms)} shown` : 'Select all'}
          </button>
        </div>

        <div className="room-rows pick-list">
          {shown.map((r) => (
            <label key={r.id} className="room-row" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} style={{ width: 'auto' }} />
              <code style={{ color: 'var(--accent)' }}>{r.id}</code>
              <span className="room-row-title">{r.title || 'Untitled'}</span>
              <span className="tiny muted room-row-meta">{r.speakerCount} sp</span>
            </label>
          ))}
          {!shown.length && (
            <p className="sub" style={{ margin: 8 }}>
              {eligible.length ? 'No room matches that filter.' : 'None of your rooms has a transcript yet.'}
            </p>
          )}
        </div>

        <label className="tiny" style={{ display: 'flex', alignItems: 'flex-start', gap: 8, margin: '10px 0', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={scoreMissing}
            onChange={(e) => setScoreMissing(e.target.checked)}
            style={{ width: 'auto', marginTop: 3 }}
          />
          <span>
            Score missing evaluations first — runs the judge model on every pasted transcript /
            summary that has no result yet. Slower and costs tokens.
          </span>
        </label>

        {error && (
          <p className="tiny" style={{ color: 'var(--err)' }}>
            {error}
          </p>
        )}

        <div className="spread">
          <span className="tiny muted">
            {selected.size} selected{selected.size >= maxRooms ? ` (max ${maxRooms})` : ''}
          </span>
          <button className="primary" disabled={!selected.size || busy} onClick={() => void generate()}>
            {busy ? 'Starting…' : `Generate report (${selected.size})`}
          </button>
        </div>
      </div>
    </div>
  );
}
