'use client';

import { useMemo, useRef, useState } from 'react';
import type { Comparison, Meta, JudgeResult, WerMetrics } from '@/lib/types';

interface Props {
  meta: Meta | null;
  comparisons: Comparison[];
  referenceLineCount: number;
  onPut: (product: string, transcript: string) => void;
  onScore: (product: string) => void;
  onClose: () => void;
}

/** 平均分，用来给整体一个粗略排序 —— 单个维度仍然分模型看 */
function meanScore(r: JudgeResult) {
  const nums = Object.values(r.scores)
    .map((s) => s.score)
    .filter((n): n is number => typeof n === 'number');
  return nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
}

function scoreColor(n: number | null) {
  if (n === null) return 'var(--muted)';
  if (n >= 90) return 'var(--ok)';
  if (n >= 70) return 'var(--accent)';
  return 'var(--err)';
}

/** 错误率：越低越好，和分数的配色方向相反 */
function rateColor(n: number) {
  if (n <= 5) return 'var(--ok)';
  if (n <= 15) return 'var(--accent)';
  return 'var(--err)';
}

const pct = (n: number | undefined) => (typeof n === 'number' ? `${n}%` : '—');

/**
 * 逐字指标。单独一块、和模型评分分开放 —— 这些数是算出来的，
 * 不该和模型的判断混在一张表里让人误以为也是估的。
 */
function WordMetrics({ w }: { w: WerMetrics }) {
  if (!w || w.unavailable) return null;
  const unit = w.mode === 'char' ? 'characters' : 'words';
  return (
    <div className="metrics">
      <div className="spread" style={{ marginBottom: 8 }}>
        <strong className="tiny">Word-for-word ({w.metric}, measured)</strong>
        <span className="tiny muted">
          {w.refTokens.toLocaleString()} reference {unit} → {w.hypTokens?.toLocaleString()} transcribed
        </span>
      </div>
      <div className="metric-row">
        <div className="metric">
          <span className="metric-n" style={{ color: rateColor(w.wer ?? 0) }}>{pct(w.wer)}</span>
          <span className="tiny muted">{w.metric}</span>
        </div>
        <div className="metric">
          <span className="metric-n" style={{ color: scoreColor(w.accuracy ?? null) }}>
            {pct(w.accuracy)}
          </span>
          <span className="tiny muted">exact match</span>
        </div>
        <div className="metric">
          <span className="metric-n" style={{ color: rateColor(w.deletionRate ?? 0) }}>
            {pct(w.deletionRate)}
          </span>
          <span className="tiny muted">deleted ({w.deletions})</span>
        </div>
        <div className="metric">
          <span className="metric-n" style={{ color: rateColor(w.substitutionRate ?? 0) }}>
            {pct(w.substitutionRate)}
          </span>
          <span className="tiny muted">substituted ({w.substitutions})</span>
        </div>
        <div className="metric">
          <span className="metric-n" style={{ color: rateColor(w.insertionRate ?? 0) }}>
            {pct(w.insertionRate)}
          </span>
          <span className="tiny muted">inserted ({w.insertions})</span>
        </div>
      </div>
      <p className="tiny muted" style={{ margin: '8px 0 0' }}>
        Edit distance against this room&apos;s script, speaker labels and timestamps stripped.
        {w.approximate && ' Approximate — the transcript was too long to align exactly.'}
      </p>
    </div>
  );
}

export function CompareModal({
  meta,
  comparisons,
  referenceLineCount,
  onPut,
  onScore,
  onClose,
}: Props) {
  const products = meta?.compare.products ?? [];
  const dimensions = meta?.compare.dimensions ?? [];
  const judges = meta?.compare.judges ?? [];
  const keyProblem = meta?.compare.problem;
  const werOnly = 'WER / deletion rate';

  const byProduct = useMemo(
    () => new Map(comparisons.map((c) => [c.product, c])),
    [comparisons]
  );

  // 未保存的草稿：产品 id -> 文本。保存后回落到服务端那份。
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const textOf = (id: string) => drafts[id] ?? byProduct.get(id)?.transcript ?? '';
  const dirty = (id: string) =>
    drafts[id] !== undefined && drafts[id] !== (byProduct.get(id)?.transcript ?? '');

  const loadFile = async (id: string, file: File) => {
    if (file.size > 4 * 1024 * 1024) return;
    const text = await file.text();
    setDrafts((d) => ({ ...d, [id]: text }));
  };

  /** 把所有产品的分数和简报拼成纯文本，方便贴进别处 */
  const copyAll = async () => {
    const lines: string[] = [`Transcript comparison — reference has ${referenceLineCount} lines`, ''];
    for (const p of products) {
      const c = byProduct.get(p.id);
      lines.push(`## ${p.label}`);
      if (!c?.result) {
        lines.push(c?.transcript ? '(not scored yet)' : '(no transcript)', '');
        continue;
      }
      const w = c.result.wer;
      if (w && !w.unavailable) {
        const unit = w.mode === 'char' ? 'characters' : 'words';
        lines.push(
          `### Word-for-word (${w.metric}, measured by edit distance)`,
          `- ${w.metric}: ${w.wer}%  |  exact match: ${w.accuracy}%`,
          `- Deleted: ${w.deletions} (${w.deletionRate}%)`,
          `- Substituted: ${w.substitutions} (${w.substitutionRate}%)`,
          `- Inserted: ${w.insertions} (${w.insertionRate}%)`,
          `- Reference: ${w.refTokens} ${unit}; transcribed: ${w.hypTokens} ${unit}` +
            (w.approximate ? ' (approximate alignment)' : ''),
          ''
        );
      }
      for (const j of c.result.judges) {
        const avg = meanScore(j);
        lines.push(`### ${j.label}${avg !== null ? ` — overall ${avg}` : ''}`);
        for (const d of dimensions) {
          const s = j.scores[d.key];
          if (!s) continue;
          lines.push(`- ${d.label}: ${s.score ?? '—'} — ${s.finding}`);
        }
        if (j.summary) lines.push('', j.summary);
        lines.push('');
      }
      for (const f of c.result.failures ?? []) {
        lines.push(`### ${f.label} — failed: ${f.message}`, '');
      }
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* 没有剪贴板权限就算了 */
    }
  };

  const anyResult = products.some((p) => byProduct.get(p.id)?.result);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="spread" style={{ marginBottom: 6 }}>
          <h2 style={{ margin: 0 }}>Compare transcripts</h2>
          <div className="row" style={{ gap: 6 }}>
            {anyResult && (
              <button className="small" onClick={copyAll}>
                {copied ? 'Copied' : 'Copy all results'}
              </button>
            )}
            <button className="small ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <p className="sub">
          Graded against this room&apos;s script ({referenceLineCount} lines). Word-for-word
          accuracy is measured by edit distance; the remaining dimensions are judged by{' '}
          {judges.map((j) => j.label).join(' and ')}.
        </p>

        {keyProblem && (
          <p className="tiny" style={{ color: 'var(--err)' }}>
            {keyProblem} — {werOnly} will still be measured, but the model-judged dimensions
            will be skipped until you set the key and restart.
          </p>
        )}

        {referenceLineCount === 0 && (
          <p className="tiny" style={{ color: 'var(--err)' }}>
            This room has no script yet, so there is nothing to compare against.
          </p>
        )}

        {products.map((p) => {
          const c = byProduct.get(p.id);
          const scoring = c?.state === 'scoring';
          const text = textOf(p.id);
          return (
            <div key={p.id} className="card" style={{ background: 'var(--panel-2)' }}>
              <div className="spread">
                <h2 style={{ margin: 0 }}>{p.label}</h2>
                <div className="row" style={{ gap: 6 }}>
                  <button
                    className="small ghost"
                    onClick={() => fileRefs.current[p.id]?.click()}
                  >
                    Choose file
                  </button>
                  <input
                    ref={(el) => {
                      fileRefs.current[p.id] = el;
                    }}
                    type="file"
                    accept=".txt,.md,.vtt,.srt,.json,text/plain"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void loadFile(p.id, f);
                      e.target.value = '';
                    }}
                  />
                  {dirty(p.id) && (
                    <button
                      className="small primary"
                      onClick={() => {
                        onPut(p.id, text);
                        setDrafts(({ [p.id]: _drop, ...rest }) => rest);
                      }}
                    >
                      Save
                    </button>
                  )}
                  <button
                    className="small primary"
                    disabled={
                      scoring || !text.trim() || dirty(p.id) || referenceLineCount === 0
                    }
                    onClick={() => onScore(p.id)}
                  >
                    {scoring ? 'Scoring…' : c?.result ? 'Re-score' : 'Score'}
                  </button>
                </div>
              </div>

              <textarea
                rows={5}
                value={text}
                placeholder={`Paste what ${p.label} transcribed…`}
                onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                onDrop={(e) => {
                  const f = e.dataTransfer.files?.[0];
                  if (f) {
                    e.preventDefault();
                    void loadFile(p.id, f);
                  }
                }}
                style={{ marginTop: 10, fontSize: 12.5 }}
              />
              <div className="row tiny muted" style={{ marginTop: 6 }}>
                <span>{text.trim() ? `${text.trim().length.toLocaleString()} chars` : 'empty'}</span>
                {dirty(p.id) && <span style={{ color: 'var(--accent)' }}>unsaved</span>}
              </div>

              {c?.state === 'failed' && (
                <p className="tiny" style={{ color: 'var(--err)', marginBottom: 0 }}>
                  Scoring failed: {c.error}
                </p>
              )}

              {c?.result && (
                <div style={{ marginTop: 12 }}>
                  <WordMetrics w={c.result.wer} />

                  {c.result.judges.length > 0 && (
                  <table className="scores">
                    <thead>
                      <tr>
                        <th />
                        {c.result.judges.map((j) => (
                          <th key={j.judge}>{j.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {dimensions.map((d) => (
                        <tr key={d.key}>
                          <td className="dim">{d.label}</td>
                          {c.result!.judges.map((j) => {
                            const s = j.scores[d.key];
                            return (
                              <td key={j.judge}>
                                <span
                                  style={{
                                    color: scoreColor(s?.score ?? null),
                                    fontWeight: 600,
                                    fontFamily: 'var(--mono)',
                                  }}
                                >
                                  {s?.score ?? '—'}
                                </span>
                                {s?.finding && <div className="finding">{s.finding}</div>}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                      <tr>
                        <td className="dim">Overall</td>
                        {c.result.judges.map((j) => {
                          const avg = meanScore(j);
                          return (
                            <td key={j.judge}>
                              <span
                                style={{
                                  color: scoreColor(avg),
                                  fontWeight: 700,
                                  fontFamily: 'var(--mono)',
                                }}
                              >
                                {avg ?? '—'}
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                    </tbody>
                  </table>
                  )}

                  {c.result.judges.map((j) =>
                    j.summary ? (
                      <p key={j.judge} className="tiny" style={{ marginBottom: 6 }}>
                        <strong>{j.label}:</strong> {j.summary}
                      </p>
                    ) : null
                  )}

                  {(c.result.failures ?? []).map((f) => (
                    <p key={f.label} className="tiny" style={{ color: 'var(--err)', margin: 0 }}>
                      {f.label} failed: {f.message}
                    </p>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
