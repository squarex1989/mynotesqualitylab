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

export type CompareTab = 'input' | 'result';

interface Props {
  meta: Meta | null;
  /** 房主和收音设备能贴转录 / 摘要、编 glossary、发起打分；其余人只看结果 */
  canEdit: boolean;
  comparisons: Comparison[];
  referenceLineCount: number;
  glossary: string;
  initialTab?: CompareTab;
  onPut: (product: string, patch: { transcript?: string; summary?: string }) => void;
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

/**
 * DER（Diarization Error Rate）—— 说话人归属换成「错误率」框架，跟 Plain/Weighted
 * WER、UER 放在同一张表里时口径一致（都是越低越好）。detailed 的 per-speaker
 * 映射、merge/split 仍然在下面的 Speakers 块里，这里只是 Ranking 表要的一个数。
 */
function derOf(s: SpeakerReport | undefined): { text: string; color: string } {
  if (!s || s.unavailable) return { text: '—', color: 'var(--muted)' };
  if (s.unlabeled) return { text: 'n/a', color: 'var(--accent)' };
  if (typeof s.attributionAccuracy !== 'number') return { text: '—', color: 'var(--muted)' };
  const der = Math.round((100 - s.attributionAccuracy) * 10) / 10;
  return { text: pct(der), color: errColor(der) };
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

type Field = 'transcript' | 'summary';
const FIELD_LABEL: Record<Field, string> = { transcript: 'Transcript', summary: 'Summary' };

export function CompareModal({
  meta,
  canEdit,
  comparisons,
  referenceLineCount,
  glossary,
  initialTab,
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
  const anyResult = products.some((p) => byProduct.get(p.id)?.result);

  // 能编辑的人默认落在 Input；只能看的人只有 Result 可看
  const [tab, setTab] = useState<CompareTab>(
    canEdit ? initialTab ?? (anyResult ? 'result' : 'input') : 'result'
  );
  useEffect(() => {
    if (!canEdit) setTab('result');
  }, [canEdit]);

  // 未保存的草稿：`${产品}:${字段}` -> 文本。保存后回落到服务端那份。
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [terms, setTerms] = useState(glossary);
  const [copied, setCopied] = useState(false);
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // 别的设备改了词表就同步过来，但不要打断正在输入的人
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setTerms(glossary);
  }, [glossary]);

  const k = (id: string, f: Field) => `${id}:${f}`;
  const saved = (id: string, f: Field) => byProduct.get(id)?.[f] ?? '';
  const textOf = (id: string, f: Field) => drafts[k(id, f)] ?? saved(id, f);
  const dirty = (id: string, f: Field) =>
    drafts[k(id, f)] !== undefined && drafts[k(id, f)] !== saved(id, f);

  const save = (id: string, f: Field) => {
    onPut(id, { [f]: textOf(id, f) });
    setDrafts(({ [k(id, f)]: _drop, ...rest }) => rest);
  };

  const loadFile = async (id: string, f: Field, file: File) => {
    if (file.size > 4 * 1024 * 1024) return;
    const text = await file.text();
    setDrafts((d) => ({ ...d, [k(id, f)]: text }));
  };

  /** 转录有没保存的改动就先存再打分 —— 同一个 socket 上按顺序处理，打分拿到的是新文本 */
  const rescore = (id: string) => {
    if (dirty(id, 'transcript')) save(id, 'transcript');
    onScore(id);
  };

  /**
   * 已打分的产品，顺序固定为 My Notes / Granola / Otter（跟 meta.compare.products
   * 一样）——不按分数重排。这是一张并排对比表，不是排行榜，顺序跳来跳去反而
   * 让人找不到自己关心的那一行。
   */
  const ranked = useMemo(() => {
    return products
      .map((p) => ({ p, c: byProduct.get(p.id) }))
      .filter((r) => !!r.c?.result && !r.c.result.metrics.wer?.unavailable)
      .map((r) => ({ p: r.p, res: r.c!.result as CompareResult }));
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
        '## Ranking',
        '',
        '| Product | Plain WER | Weighted WER | UER | DER |',
        '|---|---|---|---|---|'
      );
      ranked.forEach((r) => {
        const m = r.res.metrics;
        out.push(
          `| ${r.p.label} | ${pct(m.wer.wer)} | ${pct(m.weighted?.wer)} | ${
            r.res.uer?.unavailable ? '—' : pct(r.res.uer?.uer)
          } | ${derOf(m.speakers).text} |`
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

  const termCount = terms.split(/[\n,;、，；]/).filter((t) => t.trim()).length;

  const field = (p: { id: string; label: string }, f: Field) => {
    const text = textOf(p.id, f);
    const key = k(p.id, f);
    return (
      <div>
        <div className="spread">
          <strong className="tiny">{FIELD_LABEL[f]}</strong>
          {canEdit && (
            <div className="row" style={{ gap: 6 }}>
              <button className="small ghost" onClick={() => fileRefs.current[key]?.click()}>
                Upload file
              </button>
              <input
                ref={(el) => {
                  fileRefs.current[key] = el;
                }}
                type="file"
                accept=".txt,.md,.vtt,.srt,.json,text/plain"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void loadFile(p.id, f, file);
                  e.target.value = '';
                }}
              />
              {dirty(p.id, f) && (
                <button className="small primary" onClick={() => save(p.id, f)}>
                  Save
                </button>
              )}
            </div>
          )}
        </div>
        <textarea
          rows={7}
          value={text}
          readOnly={!canEdit}
          placeholder={
            canEdit ? `Paste the ${FIELD_LABEL[f].toLowerCase()} from ${p.label}…` : 'Nothing pasted yet'
          }
          onChange={(e) => {
            if (canEdit) setDrafts((d) => ({ ...d, [key]: e.target.value }));
          }}
          onDrop={
            canEdit
              ? (e) => {
                  const file = e.dataTransfer.files?.[0];
                  if (file) {
                    e.preventDefault();
                    void loadFile(p.id, f, file);
                  }
                }
              : undefined
          }
          style={{ marginTop: 6, fontSize: 12.5 }}
        />
        <div className="row tiny muted" style={{ marginTop: 4 }}>
          <span>{text.trim() ? `${text.trim().length.toLocaleString()} chars` : 'empty'}</span>
          {dirty(p.id, f) && <span style={{ color: 'var(--accent)' }}>unsaved</span>}
        </div>
      </div>
    );
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="spread" style={{ marginBottom: 2 }}>
          <h2 style={{ margin: 0 }}>Compare</h2>
          <div className="row" style={{ gap: 6 }}>
            {tab === 'result' && anyResult && (
              <button className="small" onClick={copyAll}>
                {copied ? 'Copied' : 'Copy all results'}
              </button>
            )}
            <button className="small ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div className="tabs">
          <button
            className={tab === 'input' ? 'active' : ''}
            disabled={!canEdit}
            title={canEdit ? undefined : 'Only the host or a capture device can paste'}
            onClick={() => setTab('input')}
          >
            Input
          </button>
          <button className={tab === 'result' ? 'active' : ''} onClick={() => setTab('result')}>
            Result
          </button>
        </div>

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

        {tab === 'input' ? (
          <>
            <p className="sub">
              Paste (or upload) what each product produced — its transcript and its summary. Saving
              a transcript clears its old score; hit Re-score to grade it against this room&apos;s
              script ({referenceLineCount} lines).
            </p>

            {products.map((p) => {
              const c = byProduct.get(p.id);
              const scoring = c?.state === 'scoring';
              const transcript = textOf(p.id, 'transcript');
              return (
                <div key={p.id} className="card" style={{ background: 'var(--panel-2)' }}>
                  <div className="spread">
                    <h2 style={{ margin: 0 }}>{p.label}</h2>
                    <div className="row" style={{ gap: 6 }}>
                      {c?.result && !scoring && <span className="pill ok">scored</span>}
                      {canEdit && (
                        <button
                          className="small primary"
                          disabled={scoring || !transcript.trim() || referenceLineCount === 0}
                          onClick={() => rescore(p.id)}
                        >
                          {scoring ? 'Scoring…' : c?.result ? 'Re-score' : 'Score'}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="paste-grid">
                    {field(p, 'transcript')}
                    {field(p, 'summary')}
                  </div>
                  {c?.state === 'failed' && (
                    <p className="tiny" style={{ color: 'var(--err)', marginBottom: 0 }}>
                      Scoring failed: {c.error}
                    </p>
                  )}
                </div>
              );
            })}

            <div className="card" style={{ background: 'var(--panel-2)' }}>
              <label className="field">
                <span className="spread">
                  <span>Glossary — names, products, jargon (one per line)</span>
                  <span className="muted">{termCount || 'none'}</span>
                </span>
                <textarea
                  rows={3}
                  value={terms}
                  readOnly={!canEdit}
                  placeholder={'Priya Raghavan\nAcme Robotics\nQuicksilver'}
                  onFocus={() => {
                    focused.current = true;
                  }}
                  onBlur={() => {
                    focused.current = false;
                    if (canEdit && terms !== glossary) onGlossary(terms);
                  }}
                  onChange={(e) => {
                    if (canEdit) setTerms(e.target.value);
                  }}
                  style={{ fontSize: 12.5 }}
                />
              </label>
              <p className="sub" style={{ margin: '8px 0 0' }}>
                These count triple when scoring transcripts, and each one is checked individually.
                Speaker names from the script and anything containing a digit are included
                automatically. Chinese and Japanese have no capitalisation, so for those this list
                is the only way to mark proper nouns.
              </p>
            </div>
          </>
        ) : (
          <>
            <p className="sub">
              Transcripts are checked against this room&apos;s script ({referenceLineCount} lines).
              Error rates, proper nouns, numbers and speaker attribution are measured by edit
              distance; whether missing content matters and whether meaning was reversed go to{' '}
              {judges.map((j) => j.label).join(' and ')}.
            </p>

            {!canEdit && (
              <p className="tiny muted" style={{ margin: '0 0 10px' }}>
                Only the host or a capture device can paste transcripts or run scoring.
              </p>
            )}

            {ranked.length > 1 && (
              <div className="card" style={{ background: 'var(--panel-2)' }}>
                <h2 style={{ margin: '0 0 4px' }}>Ranking</h2>
                <p className="sub" style={{ marginTop: 0 }}>
                  Same four metrics side by side. No composite score — one number would hide which
                  kind of mistake each product actually makes.
                </p>
                <table className="scores rank">
                  <thead>
                    <tr>
                      <th />
                      <th>Plain WER</th>
                      <th>Weighted WER</th>
                      <th>UER</th>
                      <th>DER</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranked.map((r) => {
                      const m = r.res.metrics;
                      const der = derOf(m.speakers);
                      return (
                        <tr key={r.p.id}>
                          <td className="dim">{r.p.label}</td>
                          <td style={{ color: errColor(m.wer.wer) }}>{pct(m.wer.wer)}</td>
                          <td style={{ color: errColor(m.weighted?.wer), fontWeight: 700 }}>
                            {pct(m.weighted?.wer)}
                          </td>
                          <td style={{ color: errColor(r.res.uer?.uer) }}>
                            {r.res.uer?.unavailable ? '—' : pct(r.res.uer?.uer)}
                          </td>
                          <td style={{ color: der.color }}>{der.text}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {products.map((p) => {
              const c = byProduct.get(p.id);
              return (
                <div key={p.id} className="card" style={{ background: 'var(--panel-2)' }}>
                  <h2 style={{ margin: 0 }}>{p.label}</h2>

                  <h3 className="tiny" style={{ margin: '12px 0 4px' }}>
                    Transcript evaluation
                  </h3>
                  {c?.state === 'scoring' ? (
                    <p className="tiny muted" style={{ margin: 0 }}>
                      Scoring…
                    </p>
                  ) : c?.state === 'failed' ? (
                    <p className="tiny" style={{ color: 'var(--err)', margin: 0 }}>
                      Scoring failed: {c.error}
                    </p>
                  ) : !c?.result ? (
                    <p className="tiny muted" style={{ margin: 0 }}>
                      {c?.transcript?.trim()
                        ? 'Transcript pasted, not scored yet — Re-score it on the Input tab.'
                        : 'No transcript pasted yet.'}
                    </p>
                  ) : (
                    <div>
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
                        <Evidence key={q.key} label={q.label} items={c.result!.evidence?.[q.key] ?? []} />
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

                  {/* 摘要的评估逻辑后面补；先把位置留出来，并说清楚有没有贴 */}
                  <h3 className="tiny" style={{ margin: '14px 0 4px' }}>
                    Summary evaluation
                  </h3>
                  <p className="tiny muted" style={{ margin: 0 }}>
                    {c?.summary?.trim()
                      ? `Summary pasted (${c.summary.trim().length.toLocaleString()} chars). Evaluation is not available yet.`
                      : 'No summary pasted yet. Evaluation is not available yet.'}
                  </p>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
