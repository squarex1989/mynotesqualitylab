// 拿各家会议记录产品录出来的转录，和房间里的原始 transcript（唯一真值）比对。
//
// 分工很明确：
//   code（server/metrics.js）负责所有能算出来的东西 —— 逐字错误率、加权错误率、
//   专有名词错成了什么、数字有没有变、说话人归属对不对。
//   LLM 只回答两个必须理解语义才能答的问题：漏掉的内容算不算「关键」，
//   以及意思有没有被弄反。
//
// LLM 也不打分了 —— 打分是假精度。它输出的是**证据条目**：真值里的原话、候选
// 实际录成了什么、严重程度、为什么重要。能被核对的证据比一个 0-100 有用。
//
// 两个裁判并排跑，证据合并后标注来源：两个都抓到的那条最可信。

import { codeMetrics } from './metrics.js';
import { computeUer } from './uer.js';

const BASE_URL = () =>
  (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');

/**
 * 「High」是推理档位（reasoning.effort），不是独立型号 —— OpenRouter 上
 * 真实的 slug 是下面这两个（2026-09-15 核实过 445 个模型的列表）。
 * 两个都支持 reasoning 和 structured_outputs。
 */
export const JUDGES = [
  {
    id: 'gpt',
    label: 'GPT-5.6 Sol (high)',
    model: process.env.JUDGE_MODEL_GPT || 'openai/gpt-5.6-sol',
  },
  {
    id: 'claude',
    label: 'Claude Opus 5 (high)',
    model: process.env.JUDGE_MODEL_CLAUDE || 'anthropic/claude-opus-5',
  },
];

/** 被比较的三个产品。id 进数据库，label 给界面。 */
export const PRODUCTS = [
  { id: 'my-notes', label: 'My Notes' },
  { id: 'granola', label: 'Granola' },
  { id: 'otter', label: 'Otter' },
];

export function isProduct(id) {
  return PRODUCTS.some((p) => p.id === id);
}

/** 留给 LLM 的两个问题。其余维度都由 code 算。 */
export const QUESTIONS = [
  {
    key: 'missingContent',
    label: 'Key content missing',
    ask: 'Content in the script that never made it into the transcript, and that actually matters — a decision, a commitment, a number, a reason, an objection. Ignore dropped filler and pleasantries.',
  },
  {
    key: 'meaningFlips',
    label: 'Meaning reversed',
    ask: 'Places where the transcript says something materially different from the script — a negation lost or added, a number or date changed, agreement turned into disagreement, a hedge turned into a commitment.',
  },
];

const ITEM = (what) => ({
  type: 'array',
  description: what,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['hunk', 'reference', 'candidate', 'severity', 'why'],
    properties: {
      hunk: {
        type: 'integer',
        description:
          'The numbered diff hunk this came from, so it can be verified. Use -1 if it is not tied to one hunk.',
      },
      reference: {
        type: 'string',
        description: 'The exact wording from the script. Quote it, do not paraphrase.',
      },
      candidate: {
        type: 'string',
        description:
          'What the transcript has instead. Use "(nothing)" when the content is absent entirely.',
      },
      severity: {
        type: 'string',
        enum: ['critical', 'minor'],
        description:
          'critical = someone reading only the transcript would draw the wrong conclusion or miss a decision. minor = noticeable but harmless.',
      },
      why: {
        type: 'string',
        description: 'One sentence on what a reader would get wrong because of this.',
      },
    },
  },
});

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['missingContent', 'meaningFlips', 'summary'],
  properties: {
    missingContent: ITEM(QUESTIONS[0].ask),
    meaningFlips: ITEM(QUESTIONS[1].ask),
    summary: {
      type: 'string',
      description:
        'Two or three sentences for someone deciding whether to rely on this product. Lead with the most consequential problem. Do not restate the metrics.',
    },
  },
};

const SYSTEM = `You are checking how faithfully a meeting-notes product transcribed a conversation that was read aloud from a known script.

Everything measurable has already been measured by exact edit distance: error rates,
which proper nouns came out wrong, which numbers changed, whether speakers were
attributed correctly. Those numbers are given to you as fact. Do not recompute them,
do not contradict them, and do not report them back.

You answer only the two questions that need judgement:

  1. MISSING KEY CONTENT — content in the script that is absent from the transcript
     AND that matters. A dropped "um", "yeah", or "thanks" does not matter. A dropped
     decision, number, commitment, reason or objection does.

  2. REVERSED MEANING — places where the transcript states something materially
     different from the script. Lost or added negation, changed numbers or dates,
     agreement flipped to disagreement, a hedge hardened into a commitment.

Rules:
- Every item must quote the script verbatim. No paraphrasing, no invented quotes.
- Only report what the diff actually shows. If a difference is not in the diff, it did not happen.
- An item belongs in exactly one of the two lists. Do not list the same thing twice.
- Return empty lists when there is nothing worth reporting. Empty is a valid, common answer.
- Speaker labels differing (e.g. "Speaker 1" for "Alice") is NOT an issue — that is measured separately.
- Dropped filler, repetition and false starts are NOT issues.`;

function userPrompt({ reference, metrics }) {
  const m = metrics;
  const facts = [
    `${m.wer.metric}: ${m.wer.wer}%  (exact match ${m.wer.accuracy}%; ${m.wer.substitutions} substituted, ${m.wer.deletions} deleted, ${m.wer.insertions} inserted out of ${m.wer.refTokens} reference ${m.wer.mode === 'char' ? 'characters' : 'words'})`,
    `Weighted ${m.wer.metric} (filler ×0.1, normal ×1, names/numbers/negations ×3): ${m.weighted.wer}%`,
    m.weighted.keyErrorRate !== null
      ? `Key ${m.wer.mode === 'char' ? 'characters' : 'words'} wrong or missing: ${m.weighted.keyErrorRate}% of ${m.weighted.keyTokens}`
      : null,
    m.properNouns.checked
      ? `Proper nouns: ${m.properNouns.clean}/${m.properNouns.checked} came through correctly` +
        (m.properNouns.issues.length
          ? ` — problems: ${m.properNouns.issues
              .slice(0, 12)
              .map(
                (i) =>
                  `"${i.term}"${i.dropped ? ` dropped ×${i.dropped}` : ''}${i.wrong
                    .map((w) => ` → "${w.got}"`)
                    .join('')}`
              )
              .join('; ')}`
          : '')
      : null,
    m.speakers.unlabeled
      ? 'Speaker attribution: the transcript has no speaker labels at all.'
      : m.speakers.attributionAccuracy !== null && m.speakers.attributionAccuracy !== undefined
        ? `Speaker attribution: ${m.speakers.attributionAccuracy}% of aligned words landed under the right speaker.`
        : null,
    m.wer.approximate ? 'These were computed with approximate alignment (very long transcript).' : null,
  ].filter(Boolean);

  const leads = m.leads.slice(0, 40).map((l) => `- [${l.kind}] line ${l.line}: ${l.detail}`);

  const hunks = m.hunks
    .map(
      (h) =>
        `#${h.n}${h.line ? ` (script line ${h.line}${h.speaker ? `, ${h.speaker}` : ''})` : ''}${h.dropped ? ' [absent from transcript]' : ''}\n` +
        `  script:     ${h.reference}\n` +
        `  transcript: ${h.candidate || '(nothing)'}`
    )
    .join('\n');

  return `THE SCRIPT (ground truth, read aloud in full):
"""
${reference}
"""

ALREADY MEASURED — treat as fact:
${facts.map((f) => `- ${f}`).join('\n')}

DIFF HUNKS — every place the transcript differs from the script. The differing part is
wrapped in ⟦ ⟧; text outside it is context. These are the ONLY differences that exist.
${m.hunksTruncated ? `(Showing the first ${m.hunks.length} of ${m.totalDiffRuns} — there are more.)\n` : ''}
${hunks || '(none — the transcript matches the script exactly)'}
${
  leads.length
    ? `\nLEADS the code flagged — a negation or number changed. Decide whether the meaning actually reversed:\n${leads.join('\n')}`
    : ''
}

Answer the two questions. Quote the script verbatim in every item.`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function apiKeyProblem(key = process.env.OPENROUTER_API_KEY) {
  if (!key) return 'OPENROUTER_API_KEY is not set';
  if (/[^\x20-\x7e]/.test(key))
    return 'OPENROUTER_API_KEY contains non-ASCII characters — looks like a placeholder';
  if (key.length < 20) return `OPENROUTER_API_KEY is only ${key.length} characters`;
  return null;
}

const MAX_ITEMS = 20;

function cleanItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x) => x && typeof x === 'object')
    .map((x) => ({
      hunk: Number.isFinite(Number(x.hunk)) ? Number(x.hunk) : -1,
      reference: String(x.reference || '').trim(),
      candidate: String(x.candidate || '').trim() || '(nothing)',
      severity: x.severity === 'critical' ? 'critical' : 'minor',
      why: String(x.why || '').trim(),
    }))
    .filter((x) => x.reference)
    .slice(0, MAX_ITEMS);
}

/** 跑一个裁判。失败时抛错，由调用方收集。 */
async function runJudge(judge, input) {
  const problem = apiKeyProblem();
  if (problem) throw new Error(problem);

  const body = {
    model: judge.model,
    // High = 最高推理档。这是个需要逐句比对的任务，值得让它多想。
    reasoning: { effort: 'high' },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt(input) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'transcript_findings', strict: true, schema: SCHEMA },
    },
  };

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE_URL()}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300000), // 高推理档 + 长文本，给足时间
      });

      if (!res.ok) {
        const raw = (await res.text().catch(() => '')) || '';
        let message = raw.slice(0, 300);
        try {
          message = JSON.parse(raw)?.error?.message || message;
        } catch {
          /* 不是 JSON 就用原文 */
        }
        const err = new Error(message || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }

      const json = await res.json();
      const text = json?.choices?.[0]?.message?.content;
      if (!text) throw new Error('Judge returned an empty response');

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`Judge returned non-JSON: ${String(text).slice(0, 200)}`);
      }

      const findings = {};
      for (const q of QUESTIONS) findings[q.key] = cleanItems(parsed[q.key]);

      return {
        judge: judge.id,
        label: judge.label,
        model: judge.model,
        findings,
        summary: String(parsed.summary || '').trim(),
        usage: json?.usage ?? null,
      };
    } catch (err) {
      lastErr = err;
      const status = err?.status;
      const hopeless = status === 401 || status === 402 || status === 403 || status === 400;
      const retryable = !hopeless && (status === 429 || status >= 500 || status === undefined);
      if (!retryable || attempt === 2) break;
      await sleep(1500 * 2 ** attempt);
    }
  }
  throw lastErr;
}

const norm = (s) =>
  new Set(
    String(s)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .flatMap((w) => (/[぀-ヿ㐀-䶿一-鿿]/.test(w) ? [...w] : [w]))
      .filter(Boolean)
  );

/** 两条证据指的是不是同一处 —— 引用的原文重合度够高就算同一处 */
function sameFinding(a, b) {
  if (a.hunk >= 0 && a.hunk === b.hunk) return true;
  const x = norm(a.reference);
  const y = norm(b.reference);
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  return shared / Math.min(x.size, y.size) >= 0.6;
}

/**
 * 合并两个裁判的证据，标注来源。
 * 两个都抓到的排前面 —— 那些最可信；严重程度取高的那个。
 */
function mergeFindings(results) {
  const out = {};
  for (const q of QUESTIONS) {
    const merged = [];
    for (const r of results) {
      for (const item of r.findings[q.key]) {
        const hit = merged.find((m) => sameFinding(m, item));
        if (hit) {
          if (!hit.sources.includes(r.judge)) hit.sources.push(r.judge);
          if (item.severity === 'critical') hit.severity = 'critical';
          if (item.why && item.why.length > hit.why.length) hit.why = item.why;
        } else {
          merged.push({ ...item, sources: [r.judge] });
        }
      }
    }
    merged.sort(
      (a, b) =>
        b.sources.length - a.sources.length ||
        (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1) ||
        a.hunk - b.hunk
    );
    out[q.key] = merged;
  }
  return out;
}

/**
 * 全套评估：code 指标 + 两个裁判的证据。
 *
 * @param {{reference: string, candidate: string, glossary?: string}} input
 */
export async function gradeTranscript({ reference, candidate, glossary = '' }) {
  const metrics = codeMetrics({ reference, candidate, glossary });
  if (metrics.unavailable) {
    return {
      metrics: strip(metrics),
      uer: { unavailable: true, reason: 'Nothing to compare against' },
      evidence: emptyEvidence(),
      judges: [],
      failures: [],
    };
  }

  // UER 和两个裁判并行跑 —— 它们互不依赖，串起来只是白等
  const [settled, uerResult] = await Promise.all([
    Promise.allSettled(JUDGES.map((j) => runJudge(j, { reference, metrics }))),
    (async () => {
      const problem = apiKeyProblem();
      if (problem) return { unavailable: true, reason: problem };
      try {
        return await computeUer(metrics.utterances || []);
      } catch (err) {
        return { unavailable: true, reason: err?.message || String(err) };
      }
    })(),
  ]);

  const judges = [];
  const failures = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') judges.push(r.value);
    else
      failures.push({
        judge: JUDGES[i].id,
        label: JUDGES[i].label,
        message: r.reason?.message || String(r.reason),
      });
  });

  const evidence = mergeFindings(judges);
  const critical = QUESTIONS.reduce(
    (s, q) => s + evidence[q.key].filter((x) => x.severity === 'critical').length,
    0
  );

  return {
    metrics: strip(metrics),
    // 和 μ-bench 同口径：逐个错误判三档，再按句二值化
    uer: uerResult,
    evidence,
    critical,
    judges: judges.map(({ findings: _f, ...rest }) => rest),
    failures,
    // 裁判全挂了也还有 code 指标 —— 那部分不依赖任何 API
    judgesUnavailable: judges.length === 0 || undefined,
  };
}

const emptyEvidence = () => Object.fromEntries(QUESTIONS.map((q) => [q.key, []]));

/** diff 片段只是喂给模型的中间产物，没必要存进数据库 */
function strip(m) {
  const { hunks: _h, utterances: _u, leads, ...rest } = m;
  return { ...rest, leads: (leads || []).slice(0, 40) };
}
