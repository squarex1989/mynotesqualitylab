// 拿各家会议记录产品录出来的转录，和房间里的原始 transcript（唯一真值）比对打分。
//
// 两个裁判模型并排跑，都开最高推理档，不做平均 —— 两个模型分歧大本身就是信息，
// 说明那个维度不好判，比一个虚假的平均分有用。
//
// 用 OpenRouter 的 structured outputs（JSON Schema 强约束）而不是让模型自由输出
// 再去解析：评分这种东西一旦格式跑偏，解析逻辑会越写越脏，而且出错时很难发现。

import { computeWer, werBriefing } from './wer.js';

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

/**
 * 交给模型判断的维度。
 *
 * 逐字正确率不在这里 —— 那是 WER，用编辑距离算（server/wer.js），
 * 确定、免费、而且比让模型数东西准。模型只做它擅长的语义判断。
 */
export const DIMENSIONS = [
  {
    key: 'missingContent',
    label: 'Key content captured',
    ask: 'Whether any substantive content from the reference is missing entirely — dropped turns, dropped sentences, truncated endings. 100 means nothing substantive was lost.',
  },
  {
    key: 'meaningFlips',
    label: 'No reversed meaning',
    ask: 'Whether anything was transcribed into the opposite or materially different meaning (e.g. "I don\'t know" → "I know", negation dropped, a number or date changed). 100 means no meaning was inverted or distorted.',
  },
  {
    key: 'properNouns',
    label: 'Names & proper nouns',
    ask: 'Accuracy of person names, product names, company names and technical terms (e.g. "Claude" → "Cloud"). 100 means every proper noun is correct.',
  },
  {
    key: 'speakerMapping',
    label: 'Speaker attribution',
    ask: 'Whether speakers are separated correctly and consistently. Generic labels like "Speaker 1" are fine as long as each maps stably to exactly one real person throughout. Penalise turns attributed to the wrong person, and labels that drift between people.',
  },
];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [...DIMENSIONS.map((d) => d.key), 'summary'],
  properties: {
    ...Object.fromEntries(
      DIMENSIONS.map((d) => [
        d.key,
        {
          type: 'object',
          additionalProperties: false,
          required: ['score', 'finding'],
          properties: {
            score: {
              type: 'integer',
              minimum: 0,
              maximum: 100,
              description: `0-100 for: ${d.ask}`,
            },
            finding: {
              type: 'string',
              description:
                'One or two sentences citing concrete evidence from the transcripts. Quote the actual difference where possible. Say "no issues found" if the score is 100.',
            },
          },
        },
      ])
    ),
    summary: {
      type: 'string',
      description:
        'A 2-4 sentence briefing for someone deciding whether this product is good enough to rely on. Lead with the most consequential problem. No preamble, no restating the scores.',
    },
  },
};

const SYSTEM = `You are grading how faithfully a meeting-notes product transcribed a conversation.

You get two texts:
  REFERENCE — the exact script that was read aloud. This is ground truth.
  CANDIDATE — what the product produced from listening to that reading.

You also get word-level metrics that were computed deterministically by edit
distance. Treat those numbers as fact — do not re-estimate them, and do not
contradict them. Use them as evidence: a high deletion rate means content was
dropped; a high substitution rate means words were misheard.

Grade only the transcription, not the speaking or the content itself. Score each
dimension 0-100 where 100 is flawless and 0 is unusable. Be specific and cite real
differences — vague findings are useless. Do not inflate scores to be generous: if
a proper noun is wrong, that dimension is not 100.

Note that the candidate may use different speaker labels than the reference
(e.g. "Speaker 1" instead of "Alice"). That is acceptable as long as the mapping is
consistent — judge separation and stability, not whether the names match.`;

function userPrompt(reference, candidate, werText) {
  return `REFERENCE (ground truth, read aloud):
"""
${reference}
"""

CANDIDATE (what the product transcribed):
"""
${candidate}
"""

COMPUTED WORD-LEVEL METRICS (deterministic, already measured — treat as fact):
${werText}

Grade the candidate on the four dimensions above and write the briefing.
The briefing should account for the computed metrics as well as what you found.`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function apiKeyProblem(key = process.env.OPENROUTER_API_KEY) {
  if (!key) return 'OPENROUTER_API_KEY is not set';
  if (/[^\x20-\x7e]/.test(key))
    return 'OPENROUTER_API_KEY contains non-ASCII characters — looks like a placeholder';
  if (key.length < 20) return `OPENROUTER_API_KEY is only ${key.length} characters`;
  return null;
}

/** 跑一个裁判。失败时抛错，由调用方收集。 */
async function runJudge(judge, reference, candidate, werText) {
  const problem = apiKeyProblem();
  if (problem) throw new Error(problem);

  const body = {
    model: judge.model,
    // High = 最高推理档。这是个需要逐句比对的任务，值得让它多想。
    reasoning: { effort: 'high' },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt(reference, candidate, werText) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'transcript_grade', strict: true, schema: SCHEMA },
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

      // schema 是 strict 的，但模型仍可能漏字段 —— 兜一下，别让界面拿到 undefined
      const scores = {};
      for (const d of DIMENSIONS) {
        const raw = parsed[d.key] || {};
        const n = Math.round(Number(raw.score));
        scores[d.key] = {
          score: Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null,
          finding: String(raw.finding || '').trim(),
        };
      }

      return {
        judge: judge.id,
        label: judge.label,
        model: judge.model,
        scores,
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

/**
 * 两个裁判并行跑。一个挂了不影响另一个 —— 半份结果也比没有有用。
 * @returns {Promise<{judges: object[], failures: object[]}>}
 */
export async function gradeTranscript({ reference, candidate }) {
  // 逐字指标先算出来：它既是结果的一部分，也作为事实喂给裁判，
  // 免得模型自己去估一个和实测对不上的数字。
  const wer = computeWer(reference, candidate);
  const werText = werBriefing(wer);

  const settled = await Promise.allSettled(
    JUDGES.map((j) => runJudge(j, reference, candidate, werText))
  );

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

  // 裁判全挂了也还有 WER —— 那部分是本地算的，不依赖任何 API
  if (!judges.length) {
    return { wer, judges: [], failures, judgesUnavailable: true };
  }
  return { wer, judges, failures };
}
