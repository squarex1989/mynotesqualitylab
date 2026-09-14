'use client';

import { useEffect, useRef } from 'react';
import type { Line, Progress, ScheduleItem } from '@/lib/types';

interface Props {
  lines: Line[];
  progress: Progress | null;
  schedule: ScheduleItem[];
  activeIdxs: Set<number>;
  currentIdx: number;
  playing: boolean;
}

export function ScriptView({ lines, progress, schedule, activeIdxs, currentIdx, playing }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const overlapAt = new Set(schedule.filter((s) => s.overlapMs > 0).map((s) => s.idx));

  useEffect(() => {
    if (!playing || currentIdx < 0) return;
    const el = boxRef.current?.querySelector(`[data-idx="${currentIdx}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [currentIdx, playing]);

  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 10 }}>
        <h2>台词（{lines.length} 句）</h2>
        {progress && progress.ready < progress.total && (
          <span className="tiny muted">
            绿点 = 已合成 {progress.ready}/{progress.total}
          </span>
        )}
      </div>

      <div className="script" ref={boxRef}>
        {lines.map((l) => {
          const ready = progress?.mask[l.idx] === 1;
          const failed = progress?.failures.some((f) => f.idx === l.idx);
          const active = activeIdxs.has(l.idx);
          const past = playing && currentIdx >= 0 && l.idx < currentIdx && !active;
          return (
            <div
              key={l.idx}
              data-idx={l.idx}
              className={`line${active ? ' active' : ''}${past ? ' past' : ''}`}
            >
              <span className="no">
                <span
                  className={`dot ${failed ? 'err' : ready ? 'ok' : ''}`}
                  style={{ display: 'inline-block', marginRight: 4 }}
                />
                {l.idx + 1}
              </span>
              <span className="who">{l.speaker}</span>
              <span>
                {overlapAt.has(l.idx) && <span className="overlap">⚡抢话 </span>}
                {l.content}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
