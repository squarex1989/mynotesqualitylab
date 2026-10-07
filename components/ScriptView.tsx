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
  /** 房主才有「从这一句开始播」的按钮 */
  onPlayFrom?: (idx: number) => void;
}

const NOT_READY_TIP = 'All audio needs to be ready before you can play from here';

export function ScriptView({
  lines,
  progress,
  schedule,
  activeIdxs,
  currentIdx,
  playing,
  onPlayFrom,
}: Props) {
  // 所有句子都合成好了才能从中间开播；没好时按钮照样出现，悬停说明原因
  const allReady = Boolean(progress && progress.total > 0 && progress.ready === progress.total);
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
        <h2>Script ({lines.length} lines)</h2>
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
                <span className="no-inner">
                  <span
                    className={`dot ${failed ? 'err' : ready ? 'ok' : ''}`}
                    style={{ display: 'inline-block', marginRight: 4 }}
                  />
                  {l.idx + 1}
                </span>
                {onPlayFrom && (
                  <button
                    className={`play-from${allReady ? '' : ' off'}`}
                    aria-disabled={!allReady}
                    aria-label={allReady ? `Play from line ${l.idx + 1}` : NOT_READY_TIP}
                    data-tip={allReady ? `Play from line ${l.idx + 1}` : NOT_READY_TIP}
                    onClick={() => allReady && onPlayFrom(l.idx)}
                  >
                    ▶
                  </button>
                )}
              </span>
              <span className="who">{l.speaker}</span>
              <span>
                {overlapAt.has(l.idx) && <span className="overlap">⚡cuts in </span>}
                {l.content}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
