'use client';

// Result 页的各块：按《How we measure summary and transcript quality》的口径展示。
//   Transcript —— EWER / UER / WDER / Language（主指标）+ WER（参考），每个数字都能展开看证据
//   Summary    —— Precision / 加权 Recall / F1 / Critical Error（护栏）+ Action items，
//                 逐条陈述的判定、信息单元的覆盖、行动项的字段核对都能展开看
// 所有分数都是代码根据模型的逐条结论算出来的。

import type {
  Comparison,
  CompareResult,
  RoomReference,
  SpeakerReport,
  SummaryResult,
  TermReport,
  UerResult,
} from '@/lib/types';

export const pct = (n: number | null | undefined) => (typeof n === 'number' ? `${n}%` : '—');

/** 错误率越低越好 */
export function errColor(n: number | null | undefined) {
  if (typeof n !== 'number') return 'var(--muted)';
  if (n <= 5) return 'var(--ok)';
  if (n <= 15) return 'var(--accent)';
  return 'var(--err)';
}

/** 正确率越高越好 */
export function okColor(n: number | null | undefined) {
  if (typeof n !== 'number') return 'var(--muted)';
  if (n >= 95) return 'var(--ok)';
  if (n >= 85) return 'var(--accent)';
  return 'var(--err)';
}

/** 摘要类指标（precision / recall）普遍比转录低，阈值放宽一些 */
function summaryColor(n: number | null | undefined) {
  if (typeof n !== 'number') return 'var(--muted)';
  if (n >= 90) return 'var(--ok)';
  if (n >= 70) return 'var(--accent)';
  return 'var(--err)';
}

function Stat({ value, label, color, hint }: { value: string; label: string; color: string; hint?: string }) {
  return (
    <div className="metric" title={hint}>
      <span className="metric-n" style={{ color }}>
        {value}
      </span>
      <span className="tiny muted">{label}</span>
    </div>
  );
}

/**
 * UER —— 和 μ-bench 同口径的指标，单独一块。
 *
 * 刻意不跟「Measured by edit distance」那一块混在一起：那些是算出来的，UER 里
 * 每个错误的轻重是模型判的，性质不同，不该看起来一样可靠。
 */
function Uer({ u }: { u: UerResult | undefined }) {
  if (!u) return null;
  if (u.unavailable) {
    return (
      <div className="block">
        <strong className="tiny">Utterance Error Rate</strong>
        <p className="tiny muted" style={{ margin: '4px 0 0' }}>
          Not available — {u.reason}
        </p>
      </div>
    );
  }
  const c = u.counts ?? { significant: 0, minor: 0, none: 0 };
  return (
    <div className="block">
      <div className="spread">
        <strong className="tiny">Utterance Error Rate (μ-bench definition)</strong>
        <span className="tiny muted">{u.model}</span>
      </div>
      <div className="metric-row" style={{ marginTop: 8 }}>
        <Stat value={pct(u.uer)} label="UER" color={errColor(u.uer)} />
        <Stat
          value={`${u.significantUtterances}/${u.utterances}`}
          label="lines with a meaning change"
          color={u.significantUtterances ? 'var(--err)' : 'var(--ok)'}
        />
        <Stat value={String(c.significant)} label="meaning changed" color={errColor(100)} />
        <Stat value={String(c.minor)} label="differs, same meaning" color="var(--accent)" />
        <Stat value={String(c.none)} label="surface only" color="var(--ok)" />
      </div>
      <p className="tiny muted" style={{ margin: '8px 0 0' }}>
        Every aligned error is classified as meaning-changed / real-but-harmless /
        surface-only, then a line counts as wrong if it holds at least one meaning change.
        A line with one such error scores the same as a line with ten — that is the
        μ-bench definition, so look at the weighted rate above for how much is wrong.
        {u.partial && ` Partial: ${u.skipped ?? 0} line(s) were not scored.`}
      </p>
      {(u.errors ?? []).length > 0 && (
        <ul className="terms" style={{ marginTop: 8 }}>
          {(u.errors ?? []).map((e, n) => (
            <li key={`${e.line}-${n}`}>
              <span className="muted">line {e.line}</span>{' '}
              <code>{e.script || '(nothing)'}</code>
              {' → '}
              <code style={{ color: 'var(--err)' }}>{e.transcript || '(nothing)'}</code>
              {e.reason && <span className="muted"> — {e.reason}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 专有名词 / 数字：直接列出录成了什么，不打分 */
function Terms({ r, title, empty }: { r: TermReport | undefined; title: string; empty: string }) {
  if (!r || !r.checked) return null;
  return (
    <div className="block">
      <div className="spread">
        <strong className="tiny">{title}</strong>
        <span className="tiny" style={{ color: r.issues.length ? 'var(--err)' : 'var(--ok)' }}>
          {r.clean}/{r.checked} correct
        </span>
      </div>
      {r.issues.length === 0 ? (
        <p className="tiny muted" style={{ margin: '4px 0 0' }}>
          {empty}
        </p>
      ) : (
        <ul className="terms">
          {r.issues.map((i) => (
            <li key={i.term}>
              <code>{i.term}</code>
              {i.wrong.map((w) => (
                <span key={w.got}>
                  {' → '}
                  <code style={{ color: 'var(--err)' }}>{w.got || '(garbled)'}</code>
                  {w.count > 1 && <span className="muted"> ×{w.count}</span>}
                </span>
              ))}
              {i.dropped > 0 && (
                <span style={{ color: 'var(--err)' }}>
                  {' '}
                  dropped{i.dropped > 1 ? ` ×${i.dropped}` : ''}
                </span>
              )}
              {i.correct > 0 && <span className="muted"> ({i.correct} correct)</span>}
            </li>
          ))}
        </ul>
      )}
      {/* 写法不同但算对的：复合词被拆开、所有格、连字符 —— 名字本身是对的，
          不该混在红色的错误列表里，但也得说一声，否则「全对」和肉眼看到的差异对不上 */}
      {(r.variants ?? []).length > 0 && (
        <p className="tiny muted" style={{ margin: '6px 0 0' }}>
          Counted as correct, spelled differently:{' '}
          {(r.variants ?? [])
            .map((v) => `${v.term} → ${v.variants.map((x) => x.got).join(' / ')}`)
            .join('; ')}
        </p>
      )}
    </div>
  );
}

/**
 * 说话人归属。候选用什么标签无所谓，只要每个标签稳定对应一个真人 ——
 * 所以看的是最优一对一映射下有多少词落在了对的人名下。
 */
function Speakers({ s }: { s: SpeakerReport | undefined }) {
  if (!s || s.unavailable) return null;
  if (s.unlabeled) {
    return (
      <div className="block">
        <strong className="tiny">Speaker attribution</strong>
        <p className="tiny" style={{ margin: '4px 0 0', color: 'var(--accent)' }}>
          N/A — this transcript has no speaker labels at all, so the product never attempted
          speaker separation. That is a different failure from separating them and getting it wrong.
        </p>
      </div>
    );
  }
  return (
    <div className="block">
      <div className="spread">
        <strong className="tiny">Speaker attribution</strong>
        <span className="tiny" style={{ color: okColor(s.attributionAccuracy) }}>
          {pct(s.attributionAccuracy)} of aligned words under the right speaker
        </span>
      </div>
      <ul className="terms">
        {(s.refSpeakers ?? []).map((r) => (
          <li key={r.name}>
            <code>{r.name}</code>
            {' → '}
            {r.mappedTo ? (
              <code>{r.mappedTo}</code>
            ) : (
              <span style={{ color: 'var(--err)' }}>no matching label</span>
            )}
            <span className="muted">
              {' '}
              {r.matched}/{r.tokens} words
            </span>
            {r.strays.length > 0 && (
              <span style={{ color: 'var(--err)' }}>
                {' '}
                — also under {r.strays.map((x) => `${x.label} (${x.tokens})`).join(', ')}
              </span>
            )}
          </li>
        ))}
      </ul>
      {(s.merges ?? []).map((m) => (
        <p key={m.label} className="tiny" style={{ margin: '4px 0 0', color: 'var(--err)' }}>
          {m.label} merges {m.speakers.join(' and ')} into one speaker.
        </p>
      ))}
      {(s.splits ?? []).map((p) => (
        <p key={p.speaker} className="tiny" style={{ margin: '4px 0 0', color: 'var(--err)' }}>
          {p.speaker} was split across {p.labels.map((l) => l.label).join(', ')}.
        </p>
      ))}
      {!!s.labelCountDelta && (
        <p className="tiny muted" style={{ margin: '4px 0 0' }}>
          The transcript has {Math.abs(s.labelCountDelta)}{' '}
          {s.labelCountDelta > 0 ? 'more' : 'fewer'} speaker
          {Math.abs(s.labelCountDelta) === 1 ? '' : 's'} than the script.
        </p>
      )}
    </div>
  );
}


/* ------------------------------------------------------------------ */
/* Transcript                                                          */
/* ------------------------------------------------------------------ */

function stateNote(state: string, error: string | null, has: boolean, what: string, legacy: boolean) {
  if (state === 'scoring') return <p className="tiny muted" style={{ margin: 0 }}>Scoring…</p>;
  if (state === 'failed')
    return (
      <p className="tiny" style={{ color: 'var(--err)', margin: 0 }}>
        Scoring failed: {error}
      </p>
    );
  if (legacy)
    return (
      <p className="tiny muted" style={{ margin: 0 }}>
        Scored with the previous method — Re-score it on the Input tab to get the new metrics.
      </p>
    );
  return (
    <p className="tiny muted" style={{ margin: 0 }}>
      {has ? `${what} pasted, not scored yet — Score it on the Input tab.` : `No ${what.toLowerCase()} pasted yet.`}
    </p>
  );
}

export function TranscriptEval({ c }: { c: Comparison | undefined }) {
  const r = c?.result as CompareResult | null | undefined;
  if (!c || !r || r.version !== 2 || c.state === 'scoring') {
    return stateNote(c?.state ?? 'idle', c?.error ?? null, Boolean(c?.transcript?.trim()), 'Transcript', Boolean(r && r.version !== 2));
  }
  const h = r.headline ?? {};
  const m = r.metrics;
  const ewer = m.ewer;
  const lang = m.languageCheck;
  const entityReport: TermReport | undefined = ewer
    ? {
        checked: ewer.entities,
        occurrences: ewer.occurrences,
        clean: ewer.entities - ewer.errors.length,
        issues: ewer.errors,
      }
    : undefined;

  return (
    <div>
      <div className="metric-row">
        <Stat value={pct(h.ewer)} label="EWER" color={errColor(h.ewer)} hint="Entity word error rate — names, companies, products, places, terms" />
        <Stat value={pct(h.uer)} label="UER" color={errColor(h.uer)} hint="Share of lines with at least one meaning-changing error (μ-bench)" />
        <Stat
          value={h.wderUnlabeled ? 'n/a' : pct(h.wder)}
          label="WDER"
          color={h.wderUnlabeled ? 'var(--accent)' : errColor(h.wder)}
          hint="Words attributed to the wrong speaker"
        />
        <Stat value={pct(h.language)} label="Language" color={okColor(h.language)} hint="Lines transcribed in the right language" />
        <Stat value={pct(h.wer)} label={`${m.wer?.metric ?? 'WER'} (reference)`} color="var(--muted)" />
      </div>

      <details className="eval-details">
        <summary className="tiny">
          Entities — {ewer?.substitutions ?? 0} wrong, {ewer?.deletions ?? 0} dropped of {ewer?.occurrences ?? 0}
          {ewer?.source === 'auto' ? ' (auto-detected names; no reference entities yet)' : ''}
        </summary>
        <Terms r={entityReport} title="Entity words" empty="Every entity came through correctly." />
      </details>

      <details className="eval-details">
        <summary className="tiny">Meaning-changing errors (UER)</summary>
        <Uer u={r.uer as UerResult | undefined} />
      </details>

      <details className="eval-details">
        <summary className="tiny">Speaker attribution (WDER)</summary>
        <Speakers s={m.speakers as SpeakerReport | undefined} />
      </details>

      <details className="eval-details">
        <summary className="tiny">
          Language — {lang?.wrongLines ?? 0} of {lang?.checkedLines ?? 0} lines in the wrong language
        </summary>
        {lang && lang.mismatches.length > 0 ? (
          <ul className="terms">
            {lang.mismatches.map((x) => (
              <li key={x.line}>
                <span className="muted">line {x.line}</span> expected <code>{x.expected}</code>, got{' '}
                <code style={{ color: 'var(--err)' }}>{x.got}</code> — {x.transcript.slice(0, 120)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="tiny muted" style={{ margin: '4px 0 0' }}>
            Every checked line is in the expected language. A script line split into several
            transcript lines is matched back to it by alignment.
          </p>
        )}
      </details>

      <details className="eval-details">
        <summary className="tiny">Numbers</summary>
        <Terms r={m.numbers} title="Numbers" empty="Every number came through correctly." />
      </details>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

const VERDICT_STYLE: Record<string, { label: string; color: string }> = {
  supported: { label: 'supported', color: 'var(--ok)' },
  partially_supported: { label: 'partial', color: 'var(--accent)' },
  unsupported: { label: 'unsupported', color: 'var(--err)' },
  contradicted: { label: 'contradicted', color: 'var(--err)' },
  irrelevant: { label: 'irrelevant', color: 'var(--muted)' },
};
const COVERAGE_STYLE: Record<string, string> = { covered: 'ok', partial: '', missing: 'err' };
const IMPORTANCE = ['', 'minor', 'important', 'critical'];
const human = (s: string) => s.replace(/_/g, ' ');

export function SummaryEval({ c }: { c: Comparison | undefined }) {
  const s = c?.summaryResult as SummaryResult | null | undefined;
  if (!c || !s || c.summaryState === 'scoring') {
    return stateNote(c?.summaryState ?? 'idle', c?.summaryError ?? null, Boolean(c?.summary?.trim()), 'Summary', false);
  }
  const h = s.headline;
  const ai = s.actionItems;
  const d = s.diagnostics;

  return (
    <div>
      <div className="metric-row">
        <Stat value={pct(h.precision)} label="Precision" color={summaryColor(h.precision)} hint="Valid share of the summary's claims" />
        <Stat value={pct(h.recall)} label="Recall (weighted)" color={summaryColor(h.recall)} hint="Important meeting information covered, weighted by importance" />
        <Stat value={pct(h.f1)} label="F1" color={summaryColor(h.f1)} />
        <Stat
          value={h.critical ? `${h.criticalCount}` : 'none'}
          label="Critical errors"
          color={h.critical ? 'var(--err)' : 'var(--ok)'}
          hint="Guardrail — reported separately, never offset by a better F1"
        />
      </div>
      <div className="metric-row" style={{ marginTop: 8 }}>
        <Stat value={pct(h.actionPrecision)} label="Action item precision" color={summaryColor(h.actionPrecision)} />
        <Stat value={pct(h.actionRecall)} label="Action item recall" color={summaryColor(h.actionRecall)} />
        <Stat value={pct(h.actionF1)} label="Action item F1" color={summaryColor(h.actionF1)} />
        <Stat value={pct(ai.allAttributesCorrect)} label="All attributes correct" color={summaryColor(ai.allAttributesCorrect)} />
        <Stat
          value={pct(ai.unsupportedAttributeRate)}
          label="Invented owner / due"
          color={errColor(ai.unsupportedAttributeRate)}
        />
      </div>

      {h.languageOk === false && (
        <p className="tiny" style={{ color: 'var(--err)', margin: '8px 0 0' }}>
          Written in {d.language.got}, expected {d.language.expected}.
        </p>
      )}

      <details className="eval-details">
        <summary className="tiny">
          Claims — {s.precision.claims} total ·{' '}
          {Object.entries(s.precision.byVerdict)
            .filter(([, n]) => n)
            .map(([v, n]) => `${n} ${VERDICT_STYLE[v]?.label ?? v}`)
            .join(' · ')}
        </summary>
        <div>
          {s.claims.map((cl) => {
            const v = VERDICT_STYLE[cl.verdict] ?? VERDICT_STYLE.unsupported;
            return (
              <div key={cl.index} className="evi">
                <div className="row tiny" style={{ gap: 6, marginBottom: 3 }}>
                  <span className="badge" style={{ color: v.color, borderColor: v.color }}>
                    {v.label}
                  </span>
                  {cl.errorType !== 'none' && <span className="badge">{human(cl.errorType)}</span>}
                  {cl.critical && <span className="badge bad">critical · {human(cl.criticalType)}</span>}
                  {cl.section && <span className="muted">{cl.section}</span>}
                </div>
                <div className="tiny">{cl.claim}</div>
                {cl.evidence && (
                  <div className="tiny muted" style={{ marginTop: 2 }}>
                    {cl.evidenceLines.length ? `line ${cl.evidenceLines.join(', ')}: ` : ''}
                    {cl.evidence}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </details>

      <details className="eval-details">
        <summary className="tiny">
          Coverage of the meeting — {s.units.filter((u) => u.coverage !== 'covered').length} of {s.units.length} units
          missing or partial
        </summary>
        <ul className="terms">
          {s.units.map((u) => (
            <li key={u.id}>
              <span className={`dot ${COVERAGE_STYLE[u.coverage]}`} style={{ display: 'inline-block', marginRight: 6 }} />
              <span className="muted">
                {u.id} · {human(u.type)} · {IMPORTANCE[u.importance]}
              </span>{' '}
              {u.text}
              {u.coverage !== 'covered' && <span style={{ color: u.coverage === 'missing' ? 'var(--err)' : 'var(--accent)' }}> — {u.coverage}</span>}
            </li>
          ))}
        </ul>
        {Object.keys(s.recall.byType).length > 0 && (
          <p className="tiny muted" style={{ margin: '6px 0 0' }}>
            Recall by type:{' '}
            {Object.entries(s.recall.byType)
              .map(([t, r]) => `${human(t)} ${pct(r.recall)} (${r.units})`)
              .join(' · ')}
          </p>
        )}
      </details>

      <details className="eval-details">
        <summary className="tiny">
          Action items — {ai.extracted} extracted, {ai.valid} valid, {ai.matched}/{ai.referenceActions} expected found
        </summary>
        {ai.items.length > 0 && (
          <div className="table-scroll">
            <table className="scores">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Valid</th>
                  <th>Owner</th>
                  <th>Due</th>
                  <th>Deliverable</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {ai.items.map((a, i) => (
                  <tr key={i}>
                    <td>{a.text}</td>
                    <td style={{ color: a.valid ? 'var(--ok)' : 'var(--err)' }}>{a.valid ? 'yes' : human(a.invalidReason)}</td>
                    {(['owner', 'due', 'deliverable', 'status'] as const).map((f) => (
                      <td key={f} style={{ color: a.checks[f] === 'correct' ? 'var(--ok)' : a.checks[f] === 'not_applicable' ? 'var(--muted)' : 'var(--err)' }}>
                        {(a[f] || '—') + (a.checks[f] !== 'correct' && a.checks[f] !== 'not_applicable' ? ` (${a.checks[f]})` : '')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="tiny muted" style={{ margin: '6px 0 0' }}>
          Attribute accuracy: owner {pct(ai.attributeAccuracy.owner)} · due {pct(ai.attributeAccuracy.due)} · deliverable{' '}
          {pct(ai.attributeAccuracy.deliverable)} · status {pct(ai.attributeAccuracy.status)}
          {ai.missed.length ? ` · missed: ${ai.missed.join(', ')}` : ''}
        </p>
      </details>

      <details className="eval-details">
        <summary className="tiny">Error types &amp; diagnostics</summary>
        <p className="tiny" style={{ margin: '4px 0' }}>
          {Object.entries(s.errorTypes).length
            ? Object.entries(s.errorTypes).map(([k, v]) => `${human(k)} ${v}`).join(' · ')
            : 'No claim-level errors.'}
        </p>
        <p className="tiny muted" style={{ margin: 0 }}>
          Names {pct(d.nameCorrectness)} · numbers &amp; dates {pct(d.numberDateCorrectness)} · decision status{' '}
          {pct(d.decisionCorrectness)} · attribution {pct(d.attributionCorrectness)} · terminology{' '}
          {pct(d.terminologyCorrectness)} · language {d.language.got ?? '—'}
          {d.language.expected ? ` (expected ${d.language.expected})` : ''}. Template alignment is not evaluated yet.
        </p>
      </details>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 并排对比 / 参考                                                      */
/* ------------------------------------------------------------------ */

const RANK_COLS: { key: string; label: string; get: (c?: Comparison) => number | null | undefined; color: (n: number | null | undefined) => string }[] = [
  { key: 'ewer', label: 'EWER', get: (c) => (c?.result?.version === 2 ? c.result.headline?.ewer : null), color: errColor },
  { key: 'uer', label: 'UER', get: (c) => (c?.result?.version === 2 ? c.result.headline?.uer : null), color: errColor },
  { key: 'wder', label: 'WDER', get: (c) => (c?.result?.version === 2 ? c.result.headline?.wder : null), color: errColor },
  { key: 'lang', label: 'Lang', get: (c) => (c?.result?.version === 2 ? c.result.headline?.language : null), color: okColor },
  { key: 'p', label: 'Precision', get: (c) => c?.summaryResult?.headline.precision, color: summaryColor },
  { key: 'r', label: 'Recall', get: (c) => c?.summaryResult?.headline.recall, color: summaryColor },
  { key: 'f1', label: 'F1', get: (c) => c?.summaryResult?.headline.f1, color: summaryColor },
  { key: 'af1', label: 'Action F1', get: (c) => c?.summaryResult?.headline.actionF1, color: summaryColor },
];

export function RankingTable({ products, byProduct }: { products: { id: string; label: string }[]; byProduct: Map<string, Comparison> }) {
  return (
    <div className="table-scroll">
      <table className="scores rank">
        <thead>
          <tr>
            <th />
            {RANK_COLS.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
            <th>Critical</th>
          </tr>
        </thead>
        <tbody>
          {products.map((p) => {
            const c = byProduct.get(p.id);
            const crit = c?.summaryResult?.headline;
            return (
              <tr key={p.id}>
                <td className="dim">{p.label}</td>
                {RANK_COLS.map((col) => {
                  const v = col.get(c);
                  return (
                    <td key={col.key} style={{ color: col.color(v) }}>
                      {pct(v)}
                    </td>
                  );
                })}
                <td style={{ color: crit ? (crit.critical ? 'var(--err)' : 'var(--ok)') : 'var(--muted)' }}>
                  {crit ? (crit.critical ? crit.criticalCount : 'none') : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ReferencePanel({ reference }: { reference: RoomReference | null | undefined }) {
  if (!reference) {
    return (
      <p className="tiny muted" style={{ margin: 0 }}>
        Extracted from the script the first time any product is scored: the entity words used for
        EWER, and the information units a good summary should cover.
      </p>
    );
  }
  return (
    <>
      <p className="tiny" style={{ margin: '4px 0' }}>
        <strong>Entities ({reference.entities.length}): </strong>
        {reference.entities.map((e) => e.text).join(' · ') || 'none'}
      </p>
      <ul className="terms">
        {reference.units.map((u) => (
          <li key={u.id}>
            <span className="muted">
              {u.id} · {human(u.type)} · {IMPORTANCE[u.importance]}
            </span>{' '}
            {u.text}
            {u.type === 'action_item' && (
              <span className="muted">
                {' '}
                (owner {u.owner || '—'}, due {u.due || '—'}, {u.status})
              </span>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

/** 「Copy all results」：把所有结果拼成 Markdown */
export function resultsMarkdown(
  products: { id: string; label: string }[],
  byProduct: Map<string, Comparison>,
  referenceLineCount: number
) {
  const out = ['# Transcript & summary evaluation', `Script: ${referenceLineCount} lines.`, ''];
  out.push(
    '| Product | EWER | UER | WDER | Language | Precision | Recall | F1 | Critical | Action F1 |',
    '|---|---|---|---|---|---|---|---|---|---|'
  );
  for (const p of products) {
    const c = byProduct.get(p.id);
    const t = c?.result?.version === 2 ? c.result.headline : undefined;
    const s = c?.summaryResult?.headline;
    out.push(
      `| ${p.label} | ${pct(t?.ewer)} | ${pct(t?.uer)} | ${t?.wderUnlabeled ? 'n/a' : pct(t?.wder)} | ${pct(t?.language)} | ${pct(s?.precision)} | ${pct(s?.recall)} | ${pct(s?.f1)} | ${s ? (s.critical ? s.criticalCount : 'none') : '—'} | ${pct(s?.actionF1)} |`
    );
  }
  for (const p of products) {
    const c = byProduct.get(p.id);
    const s = c?.summaryResult;
    out.push('', `## ${p.label}`);
    const e = c?.result?.version === 2 ? c.result.metrics.ewer : undefined;
    if (e?.errors.length) {
      out.push('### Entity errors');
      for (const i of e.errors)
        out.push(`- "${i.term}" ${[...i.wrong.map((w) => `→ "${w.got}"${w.count > 1 ? ` ×${w.count}` : ''}`), ...(i.dropped ? [`dropped ×${i.dropped}`] : [])].join(', ')}`);
    }
    if (s) {
      const bad = s.claims.filter((cl) => cl.verdict !== 'supported');
      if (bad.length) {
        out.push('### Summary claims with problems');
        for (const cl of bad)
          out.push(`- [${cl.verdict}${cl.critical ? ', CRITICAL' : ''}, ${cl.errorType}] ${cl.claim}${cl.evidence ? ` — script: ${cl.evidence}` : ''}`);
      }
      const missing = s.units.filter((u) => u.coverage === 'missing');
      if (missing.length) {
        out.push('### Missing from the summary');
        for (const u of missing) out.push(`- (${u.type}, ${IMPORTANCE[u.importance]}) ${u.text}`);
      }
    }
  }
  return out.join('\n');
}
