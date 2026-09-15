'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Comparison,
  Meta,
  CompareResult,
  CodeMetrics,
  Finding,
  SpeakerReport,
  TermReport,
  UerResult,
} from '@/lib/types';

interface Props {
  meta: Meta | null;
  comparisons: Comparison[];
  referenceLineCount: number;
  glossary: string;
  onPut: (product: string, transcript: string) => void;
  onScore: (product: string) => void;
  onGlossary: (text: string) => void;
  onClose: () => void;
}

const pct = (n: number | null | undefined) => (typeof n === 'number' ? `${n}%` : '—');

/** 错误率越低越好 */
function errColor(n: number | null | undefined) {
  if (typeof n !== 'number') return 'var(--muted)';
  if (n <= 5) return 'var(--ok)';
  if (n <= 15) return 'var(--accent)';
  return 'var(--err)';
}

/** 正确率越高越好 */
function okColor(n: number | null | undefined) {
  if (typeof n !== 'number') return 'var(--muted)';
  if (n >= 95) return 'var(--ok)';
  if (n >= 85) return 'var(--accent)';
  return 'var(--err)';
}

function Stat({ value, label, color }: { value: string; label: string; color: string }) {
  return (
    <div className="metric">
      <span className="metric-n" style={{ color }}>
        {value}
      </span>
      <span className="tiny muted">{label}</span>
    </div>
  );
}

/** 实测指标。全部由编辑距离算出，不经过模型。 */
function Measured({ m }: { m: CodeMetrics }) {
  const w = m.wer;
  const g = m.weighted;
  if (!w || w.unavailable || !g) return null;
  const unit = w.mode === 'char' ? 'characters' : 'words';
  return (
    <div className="metrics">
      <div className="spread" style={{ marginBottom: 8 }}>
        <strong className="tiny">Measured by edit distance</strong>
        <span className="tiny muted">
          {w.refTokens.toLocaleString()} script {unit} → {w.hypTokens?.toLocaleString()} transcribed
        </span>
      </div>

      <div className="metric-row">
        <Stat value={pct(g.wer)} label={`weighted ${w.metric}`} color={errColor(g.wer)} />
        <Stat value={pct(w.wer)} label={`plain ${w.metric}`} color={errColor(w.wer)} />
        <Stat value={pct(w.accuracy)} label="exact match" color={okColor(w.accuracy)} />
        <Stat
          value={pct(g.keyErrorRate)}
          label={`key ${unit} wrong (${g.keyTokens})`}
          color={errColor(g.keyErrorRate)}
        />
        <Stat
          value={pct(w.deletionRate)}
          label={`deleted (${w.deletions})`}
          color={errColor(w.deletionRate)}
        />
        <Stat
          value={pct(w.substitutionRate)}
          label={`substituted (${w.substitutions})`}
          color={errColor(w.substitutionRate)}
        />
        <Stat
          value={pct(w.insertionRate)}
          label={`inserted (${w.insertions})`}
          color={errColor(w.insertionRate)}
        />
      </div>

      <p className="tiny muted" style={{ margin: '8px 0 0' }}>
        Weighted counts filler {unit} ×{g.weights.filler} and names, numbers and negations ×
        {g.weights.key} — dropping &ldquo;um&rdquo; barely registers, dropping a name does. This
        script has {g.fillerTokens} filler, {g.normalTokens} ordinary and {g.keyTokens} key {unit}.
{' '}
        Speaker labels, timestamps and bracketed annotations like{' '}
        <code>[LAUGH]</code> are stripped from both sides first — nobody reads those aloud.
        {w.approximate &&
          ' Alignment was approximate — the transcript was too long to align exactly.'}
      </p>
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

const JUDGE_SHORT: Record<string, string> = { gpt: 'GPT', claude: 'Claude' };

const sourceLabel = (sources: string[]) =>
  sources.length > 1 ? 'both judges' : `${JUDGE_SHORT[sources[0]] ?? sources[0]} only`;

/** LLM 的证据条目。两个裁判都抓到的排前面并标出来。 */
function Evidence({ items, label }: { items: Finding[]; label: string }) {
  return (
    <div className="block">
      <div className="spread">
        <strong className="tiny">{label}</strong>
        <span className="tiny" style={{ color: items.length ? 'var(--err)' : 'var(--ok)' }}>
          {items.length === 0
            ? 'none found'
            : `${items.length} found (${items.filter((i) => i.severity === 'critical').length} critical)`}
        </span>
      </div>
      {items.map((it, n) => (
        <div key={`${it.hunk}-${n}`} className="evi">
          <div className="row tiny" style={{ gap: 6, marginBottom: 4 }}>
            <span className={`badge${it.severity === 'critical' ? ' bad' : ''}`}>
              {it.severity}
            </span>
            <span className={`badge${it.sources.length > 1 ? ' agree' : ''}`}>
              {sourceLabel(it.sources)}
            </span>
          </div>
          <div className="tiny">
            <span className="muted">script:</span> {it.reference}
          </div>
          <div className="tiny">
            <span className="muted">transcript:</span>{' '}
            <span style={{ color: 'var(--err)' }}>{it.candidate}</span>
          </div>
          {it.why && (
            <div className="tiny muted" style={{ marginTop: 3 }}>
              {it.why}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function CompareModal({
  meta,
  comparisons,
  referenceLineCount,
  glossary,
  onPut,
  onScore,
  onGlossary,
  onClose,
}: Props) {
  const products = meta?.compare.products ?? [];
  const questions = meta?.compare.questions ?? [];
  const judges = meta?.compare.judges ?? [];
  const keyProblem = meta?.compare.problem;

  const byProduct = useMemo(() => new Map(comparisons.map((c) => [c.product, c])), [comparisons]);

  // 未保存的草稿：产品 id -> 文本。保存后回落到服务端那份。
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [terms, setTerms] = useState(glossary);
  const [copied, setCopied] = useState(false);
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // 别的设备改了词表就同步过来，但不要打断正在输入的人
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setTerms(glossary);
  }, [glossary]);

  const textOf = (id: string) => drafts[id] ?? byProduct.get(id)?.transcript ?? '';
  const dirty = (id: string) =>
    drafts[id] !== undefined && drafts[id] !== (byProduct.get(id)?.transcript ?? '');

  const loadFile = async (id: string, file: File) => {
    if (file.size > 4 * 1024 * 1024) return;
    const text = await file.text();
    setDrafts((d) => ({ ...d, [id]: text }));
  };

  /** 按加权错误率排序 —— 这是确定值，不造合成总分 */
  const ranked = useMemo(() => {
    const rows = products
      .map((p) => ({ p, c: byProduct.get(p.id) }))
      .filter((r) => !!r.c?.result && !r.c.result.metrics.wer?.unavailable)
      .map((r) => ({ p: r.p, res: r.c!.result as CompareResult }));
    rows.sort(
      (a, b) => (a.res.metrics.weighted?.wer ?? 999) - (b.res.metrics.weighted?.wer ?? 999)
    );
    return rows;
  }, [products, byProduct]);

  /** 把所有结果拼成 Markdown，方便贴进别处 */
  const copyAll = async () => {
    const out: string[] = [
      '# Transcript comparison',
      `Script: ${referenceLineCount} lines. Error rates, proper nouns, numbers and speaker attribution measured by edit distance. Missing key content and reversed meaning judged by ${judges
        .map((j) => j.label)
        .join(' and ')}.`,
      '',
    ];

    if (ranked.length > 1) {
      out.push(
        '## Ranking (by weighted error rate, lower is better)',
        '',
        '| # | Product | Weighted | Plain | Deleted | Key wrong | UER | Speakers | Critical |',
        '|---|---|---|---|---|---|---|---|---|'
      );
      ranked.forEach((r, i) => {
        const m = r.res.metrics;
        out.push(
          `| ${i + 1} | ${r.p.label} | ${pct(m.weighted?.wer)} | ${pct(m.wer.wer)} | ${pct(
            m.wer.deletionRate
          )} | ${pct(m.weighted?.keyErrorRate)} | ${
            r.res.uer?.unavailable ? '—' : pct(r.res.uer?.uer)
          } | ${m.speakers?.unlabeled ? 'none' : pct(m.speakers?.attributionAccuracy)} | ${
            r.res.critical ?? 0
          } |`
        );
      });
      out.push('');
    }

    for (const p of products) {
      const c = byProduct.get(p.id);
      out.push(`## ${p.label}`);
      if (!c?.result) {
        out.push(c?.transcript ? '(not scored yet)' : '(no transcript)', '');
        continue;
      }
      const m = c.result.metrics;
      const w = m.wer;
      if (w.unavailable) {
        out.push('(nothing to compare against)', '');
        continue;
      }
      const unit = w.mode === 'char' ? 'characters' : 'words';
      out.push(
        '### Measured (edit distance)',
        `- Weighted ${w.metric}: ${pct(m.weighted?.wer)}  |  plain ${w.metric}: ${pct(
          w.wer
        )}  |  exact match: ${pct(w.accuracy)}`,
        `- Key ${unit} wrong or missing: ${pct(m.weighted?.keyErrorRate)} of ${m.weighted?.keyTokens}`,
        `- Deleted ${w.deletions} (${pct(w.deletionRate)}), substituted ${w.substitutions} (${pct(
          w.substitutionRate
        )}), inserted ${w.insertions} (${pct(w.insertionRate)})`,
        `- Script: ${w.refTokens} ${unit}; transcript: ${w.hypTokens} ${unit}` +
          (w.approximate ? ' (approximate alignment)' : ''),
        ''
      );

      const reports: [string, TermReport | undefined][] = [
        ['Proper nouns', m.properNouns],
        ['Numbers', m.numbers],
      ];
      for (const [title, rep] of reports) {
        if (!rep?.checked) continue;
        out.push(`### ${title} — ${rep.clean}/${rep.checked} correct`);
        if (!rep.issues.length) out.push('- all correct');
        for (const v of rep.variants ?? [])
          out.push(
            `- "${v.term}" spelled as ${v.variants.map((x) => `"${x.got}"`).join(' / ')} — counted as correct`
          );
        for (const i of rep.issues) {
          const bits = [
            ...i.wrong.map((x) => `→ "${x.got}"${x.count > 1 ? ` ×${x.count}` : ''}`),
            ...(i.dropped ? [`dropped${i.dropped > 1 ? ` ×${i.dropped}` : ''}`] : []),
          ];
          out.push(`- "${i.term}" ${bits.join(', ')}`);
        }
        out.push('');
      }

      const u = c.result.uer;
      if (u && !u.unavailable) {
        const cc = u.counts ?? { significant: 0, minor: 0, none: 0 };
        out.push(
          `### Utterance Error Rate (μ-bench definition, ${u.model})`,
          `- UER: ${pct(u.uer)} — ${u.significantUtterances}/${u.utterances} lines hold at least one meaning change`,
          `- Errors classified: ${cc.significant} meaning-changed, ${cc.minor} real but harmless, ${cc.none} surface-only`,
          ...(u.partial ? [`- Partial: ${u.skipped ?? 0} line(s) not scored`] : []),
          ...(u.errors ?? []).map(
            (e) =>
              `- line ${e.line}: "${e.script || '(nothing)'}" → "${e.transcript || '(nothing)'}"` +
              (e.reason ? ` — ${e.reason}` : '')
          ),
          ''
        );
      } else if (u?.unavailable) {
        out.push('### Utterance Error Rate', `- not available: ${u.reason}`, '');
      }

      const s = m.speakers;
      if (s && !s.unavailable) {
        out.push('### Speaker attribution');
        if (s.unlabeled) out.push('- N/A — the transcript has no speaker labels');
        else {
          out.push(`- ${pct(s.attributionAccuracy)} of aligned words under the right speaker`);
          for (const r of s.refSpeakers ?? [])
            out.push(
              `- ${r.name} → ${r.mappedTo ?? 'no matching label'} (${r.matched}/${r.tokens} words)` +
                (r.strays.length
                  ? `; also under ${r.strays.map((x) => `${x.label} (${x.tokens})`).join(', ')}`
                  : '')
            );
          for (const g of s.merges ?? [])
            out.push(`- ${g.label} merges ${g.speakers.join(' and ')}`);
          for (const g of s.splits ?? [])
            out.push(`- ${g.speaker} split across ${g.labels.map((l) => l.label).join(', ')}`);
        }
        out.push('');
      }

      for (const q of questions) {
        const items = c.result.evidence?.[q.key] ?? [];
        out.push(
          `### ${q.label} — ${items.length} found (${
            items.filter((i) => i.severity === 'critical').length
          } critical)`
        );
        if (!items.length) out.push('- none found');
        for (const it of items) {
          out.push(
            `- [${it.severity}, ${sourceLabel(it.sources)}]`,
            `  - script: ${it.reference}`,
            `  - transcript: ${it.candidate}`,
            ...(it.why ? [`  - ${it.why}`] : [])
          );
        }
        out.push('');
      }

      for (const j of c.result.judges) if (j.summary) out.push(`**${j.label}:** ${j.summary}`, '');
      for (const f of c.result.failures ?? []) out.push(`${f.label} failed: ${f.message}`, '');
    }

    try {
      await navigator.clipboard.writeText(out.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* 没有剪贴板权限就算了 */
    }
  };

  const anyResult = products.some((p) => byProduct.get(p.id)?.result);
  const termCount = terms.split(/[\n,;、，；]/).filter((t) => t.trim()).length;

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
          Checked against this room&apos;s script ({referenceLineCount} lines). Error rates, proper
          nouns, numbers and speaker attribution are measured by edit distance. Only two questions
          go to {judges.map((j) => j.label).join(' and ')}: whether the missing content matters, and
          whether any meaning was reversed.
        </p>

        {keyProblem && (
          <p className="tiny" style={{ color: 'var(--err)' }}>
            {keyProblem} — everything measured still works, but the two judged questions are skipped
            until you set the key and restart.
          </p>
        )}

        {referenceLineCount === 0 && (
          <p className="tiny" style={{ color: 'var(--err)' }}>
            This room has no script yet, so there is nothing to compare against.
          </p>
        )}

        <div className="card" style={{ background: 'var(--panel-2)' }}>
          <label className="field">
            <span className="spread">
              <span>Glossary — names, products, jargon (one per line)</span>
              <span className="muted">{termCount || 'none'}</span>
            </span>
            <textarea
              rows={3}
              value={terms}
              placeholder={'Priya Raghavan\nAcme Robotics\nQuicksilver'}
              onFocus={() => {
                focused.current = true;
              }}
              onBlur={() => {
                focused.current = false;
                if (terms !== glossary) onGlossary(terms);
              }}
              onChange={(e) => setTerms(e.target.value)}
              style={{ fontSize: 12.5 }}
            />
          </label>
          <p className="sub" style={{ margin: '8px 0 0' }}>
            These count triple, and each one is checked individually so you can see what it came out
            as. Speaker names from the script and anything containing a digit are included
            automatically. Latin proper nouns are picked up from capitalisation — Chinese and
            Japanese have none, so for those this list is the only way.
          </p>
        </div>

        {ranked.length > 1 && (
          <div className="card" style={{ background: 'var(--panel-2)' }}>
            <h2 style={{ margin: '0 0 4px' }}>Ranking</h2>
            <p className="sub" style={{ marginTop: 0 }}>
              By weighted error rate, lowest first. No composite score — one number would hide which
              kind of mistake each product actually makes.
            </p>
            <table className="scores rank">
              <thead>
                <tr>
                  <th />
                  <th>Weighted</th>
                  <th>Plain</th>
                  <th>Deleted</th>
                  <th>Key wrong</th>
                  <th>UER</th>
                  <th>Speakers</th>
                  <th>Critical</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((r, i) => {
                  const m = r.res.metrics;
                  return (
                    <tr key={r.p.id}>
                      <td className="dim">
                        {i + 1}. {r.p.label}
                      </td>
                      <td style={{ color: errColor(m.weighted?.wer), fontWeight: 700 }}>
                        {pct(m.weighted?.wer)}
                      </td>
                      <td style={{ color: errColor(m.wer.wer) }}>{pct(m.wer.wer)}</td>
                      <td style={{ color: errColor(m.wer.deletionRate) }}>
                        {pct(m.wer.deletionRate)}
                      </td>
                      <td style={{ color: errColor(m.weighted?.keyErrorRate) }}>
                        {pct(m.weighted?.keyErrorRate)}
                      </td>
                      <td style={{ color: errColor(r.res.uer?.uer) }}>
                        {r.res.uer?.unavailable ? '—' : pct(r.res.uer?.uer)}
                      </td>
                      <td
                        style={{
                          color: m.speakers?.unlabeled
                            ? 'var(--accent)'
                            : okColor(m.speakers?.attributionAccuracy),
                        }}
                      >
                        {m.speakers?.unlabeled ? 'none' : pct(m.speakers?.attributionAccuracy)}
                      </td>
                      <td
                        style={{
                          color: r.res.critical ? 'var(--err)' : 'var(--ok)',
                          fontWeight: 600,
                        }}
                      >
                        {r.res.critical ?? 0}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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
                  <button className="small ghost" onClick={() => fileRefs.current[p.id]?.click()}>
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
                    disabled={scoring || !text.trim() || dirty(p.id) || referenceLineCount === 0}
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
                  <Measured m={c.result.metrics} />

                  <Terms
                    r={c.result.metrics.properNouns}
                    title="Proper nouns"
                    empty="Every name came through correctly."
                  />
                  <Terms
                    r={c.result.metrics.numbers}
                    title="Numbers"
                    empty="Every number came through correctly."
                  />
                  <Speakers s={c.result.metrics.speakers} />
                  <Uer u={c.result.uer} />

                  {questions.map((q) => (
                    <Evidence
                      key={q.key}
                      label={q.label}
                      items={c.result!.evidence?.[q.key] ?? []}
                    />
                  ))}

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
