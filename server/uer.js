// UER（Utterance Error Rate）—— 和 μ-bench 同口径的指标。
//
// 为什么要它：加权 WER 是我们自己定的权重（语气词 0.1 / 普通 1 / 关键 3），能解决
// 「轻重不分」，但它只是我们的口径，没法跟外部数字比。UER 是 sierra-research/mu-bench
// 的公开定义，跟着它做出来的数，量级和排序就能和那个榜单上的几家横向看。
//
// 定义（照 μ-bench 的公开文档）：
//   1. 词级对齐之后，把每一个错误（替换/删除/插入）单独交给模型判三档
//        significant  意思变了 —— 账号 C N 8 7 2 → D N 8 7 2、电话号码错一位、否定被反转
//        minor        真实差异但意思保留 —— get → got
//        no error     表面不同、语义相同 —— um vs umm、Dr. vs doctor
//   2. UER = 至少含一个 significant 错误的 utterance 占比
//
// 注意第 2 步是**按句二值化**：一句里错 1 个和错 10 个得分一样。这是 μ-bench 的
// 定义，不是我们的选择 —— 想看「错了多少」要看加权 WER，两个并排放。
//
// 一个诚实的限制：μ-bench 判定三档的 prompt 原文在它的 HuggingFace 数据集里，
// 而那个数据集是受限的（需要申请审批）。所以这里的 rubric 是按论文公开的三档定义
// 和例子写的，措辞不同 —— 边界情况的判断会有出入，数量级和排序可比，逐位不可比。

const BASE_URL = () =>
  (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');

/**
 * 判三档只用一个模型。
 *
 * 别的维度我们是两个裁判并排跑、分歧本身当信息看；但 UER 要的是一个能跟外部
 * 对比的数字，两个模型平均出来的东西不对应任何已发表的口径。
 */
export const UER_MODEL = () => process.env.UER_MODEL || process.env.JUDGE_MODEL_GPT || 'openai/gpt-5.6-sol';

export const UER_CATEGORIES = [
  { score: 1, key: 'significant', label: 'Meaning changed' },
  { score: 2, key: 'minor', label: 'Difference without meaning change' },
  { score: 3, key: 'none', label: 'Same meaning' },
];

/** 一次请求里塞多少句。太大容易让模型漏掉后面的，太小请求数爆炸。 */
const BATCH = 20;
/** 需要打分的句子上限。超了就只打前面这些，并标记 partial。 */
const MAX_UTTERANCES = 300;

const joinRaw = (side, idx) => idx.map((i) => side.raw[i]).join(side.mode === 'char' ? '' : ' ');

/**
 * 把对齐结果按「真值的行」切成 utterance，并把每个错误挂到所在的行上。
 *
 * 插入没有对应的真值 token，按紧邻的前一个真值 token 所在行归属 —— 开头的插入
 * 归到后面第一个真值 token 的行。
 */
export function buildUtterances(a) {
  const lines = new Map(); // lineIdx -> utterance

  const at = (lineIdx) => {
    let u = lines.get(lineIdx);
    if (!u) {
      u = {
        line: lineIdx,
        speaker: null,
        refIdx: [],
        hypIdx: [],
        errors: [],
      };
      lines.set(lineIdx, u);
    }
    return u;
  };

  // 先确定每个插入归哪一行
  const lineOf = new Array(a.ops.length).fill(-1);
  let last = -1;
  a.ops.forEach((o, k) => {
    if (o.ri >= 0) last = a.ref.line[o.ri];
    lineOf[k] = last;
  });
  let next = -1;
  for (let k = a.ops.length - 1; k >= 0; k--) {
    if (a.ops[k].ri >= 0) next = a.ref.line[a.ops[k].ri];
    if (lineOf[k] < 0) lineOf[k] = next;
  }

  let id = 0;
  a.ops.forEach((o, k) => {
    const lineIdx = lineOf[k];
    if (lineIdx < 0) return; // 真值一个 token 都没有，无从归属
    const u = at(lineIdx);
    if (o.ri >= 0) {
      u.refIdx.push(o.ri);
      if (u.speaker === null) u.speaker = a.ref.speaker[o.ri];
    }
    if (o.hi >= 0) u.hypIdx.push(o.hi);
    if (o.t === 'hit') return;

    u.errors.push({
      id: ++id,
      type: o.t === 'sub' ? 'substitution' : o.t === 'del' ? 'deletion' : 'insertion',
      script: o.ri >= 0 ? a.ref.raw[o.ri] : '',
      transcript: o.hi >= 0 ? a.hyp.raw[o.hi] : '',
    });
  });

  return [...lines.values()]
    .sort((x, y) => x.line - y.line)
    .filter((u) => u.refIdx.length > 0)
    .map((u) => ({
      line: u.line + 1,
      speaker: u.speaker,
      script: joinRaw(a.ref, u.refIdx),
      transcript: joinRaw(a.hyp, u.hypIdx),
      errors: u.errors,
    }));
}

const SYSTEM = `You classify individual transcription errors by whether they change meaning.

Each error came from a word-level alignment between a SCRIPT (what was read aloud,
ground truth) and a TRANSCRIPT (what a meeting-notes product produced). For every
error you are given, return exactly one score:

  1 = MEANING CHANGED. Someone reading only the transcript would understand something
      different or wrong. Examples: a digit or letter in a code or phone number is
      wrong ("C N 8 7 2" became "D N 8 7 2"); a number, amount or date changed; a
      negation was lost or added; a name became a different name; a decision,
      commitment or quantity was dropped.

  2 = REAL DIFFERENCE, MEANING PRESERVED. The words genuinely differ but a reader
      would understand the same thing. Examples: "get" became "got"; a plural became
      singular; a small function word was dropped without changing the claim.

  3 = NO ERROR. The difference is only surface form and the meaning is identical.
      Examples: "um" vs "umm"; "Dr." vs "doctor"; a filler word dropped; a spelling
      or spacing variant of the same name ("NovaLedger" vs "Nova Ledger"); a
      possessive difference ("Meridian's" vs "Meridian").

Judge each error in the context of its own utterance. Do not judge the utterance as a
whole, and do not re-score errors you were not given. Be strict about score 1: reserve
it for differences that would actually mislead a reader.`;

function userPrompt(batch) {
  const blocks = batch.map((u) => {
    const errors = u.errors
      .map(
        (e) =>
          `    id ${e.id}: ${e.type} — script "${e.script || '(nothing)'}" → transcript "${
            e.transcript || '(nothing)'
          }"`
      )
      .join('\n');
    return (
      `Utterance (script line ${u.line}${u.speaker ? `, ${u.speaker}` : ''}):\n` +
      `  script:     ${u.script}\n` +
      `  transcript: ${u.transcript || '(nothing)'}\n` +
      `  errors:\n${errors}`
    );
  });

  const ids = batch.flatMap((u) => u.errors.map((e) => e.id));
  return `${blocks.join('\n\n')}

Score every error id listed above: ${ids.join(', ')}. Return one entry per id, nothing else.`;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scores'],
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'score', 'reason'],
        properties: {
          id: { type: 'integer', description: 'The error id you were given' },
          score: {
            type: 'integer',
            enum: [1, 2, 3],
            description: '1 = meaning changed, 2 = real difference but same meaning, 3 = no error',
          },
          reason: { type: 'string', description: 'One short clause. No preamble.' },
        },
      },
    },
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scoreBatch(batch) {
  const body = {
    model: UER_MODEL(),
    // 这是逐个错误的分类任务，不需要长链推理；温度压到 0 让它尽量稳定
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt(batch) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'error_scores', strict: true, schema: SCHEMA },
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
        signal: AbortSignal.timeout(180000),
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
      if (!text) throw new Error('UER classifier returned an empty response');
      const parsed = JSON.parse(text);
      return { scores: Array.isArray(parsed?.scores) ? parsed.scores : [], usage: json?.usage };
    } catch (err) {
      lastErr = err;
      const status = err?.status;
      const hopeless = status === 400 || status === 401 || status === 402 || status === 403;
      if (hopeless || attempt === 2) break;
      await sleep(1200 * 2 ** attempt);
    }
  }
  throw lastErr;
}

/**
 * 算 UER。
 *
 * @param {object[]} utterances buildUtterances() 的结果
 * @returns UER 及其分解；没有 key 或一个错误都没有时返回带 unavailable/reason 的对象
 */
export async function computeUer(utterances) {
  const total = utterances.length;
  if (!total) return { unavailable: true, reason: 'The script has no lines to score' };

  const withErrors = utterances.filter((u) => u.errors.length > 0);
  if (!withErrors.length) {
    // 一个错误都没有 —— 不用调模型也知道 UER 是 0
    return {
      metric: 'UER',
      model: UER_MODEL(),
      utterances: total,
      utterancesWithErrors: 0,
      significantUtterances: 0,
      uer: 0,
      counts: { significant: 0, minor: 0, none: 0 },
      errors: [],
    };
  }

  const scoring = withErrors.slice(0, MAX_UTTERANCES);
  const batches = [];
  for (let i = 0; i < scoring.length; i += BATCH) batches.push(scoring.slice(i, i + BATCH));

  const settled = await Promise.allSettled(batches.map((b) => scoreBatch(b)));
  const byId = new Map();
  let usage = 0;
  const failures = [];
  settled.forEach((r, i) => {
    if (r.status !== 'fulfilled') {
      failures.push(r.reason?.message || String(r.reason));
      return;
    }
    usage += Number(r.value.usage?.total_tokens || 0);
    for (const s of r.value.scores) {
      const n = Math.round(Number(s?.id));
      const v = Math.round(Number(s?.score));
      if (!Number.isFinite(n) || ![1, 2, 3].includes(v)) continue;
      byId.set(n, { score: v, reason: String(s.reason || '').trim() });
    }
    void i;
  });

  if (byId.size === 0) {
    return {
      unavailable: true,
      reason: failures[0] || 'The UER classifier returned nothing usable',
      model: UER_MODEL(),
    };
  }

  const counts = { significant: 0, minor: 0, none: 0 };
  const errors = [];
  let significantUtterances = 0;
  let scoredUtterances = 0;

  for (const u of scoring) {
    const scored = u.errors.filter((e) => byId.has(e.id));
    if (!scored.length) continue; // 这一句没打上分，不计入分母
    scoredUtterances++;
    let worst = 3;
    for (const e of scored) {
      const { score, reason } = byId.get(e.id);
      counts[score === 1 ? 'significant' : score === 2 ? 'minor' : 'none']++;
      if (score < worst) worst = score;
      if (score === 1) {
        errors.push({
          line: u.line,
          speaker: u.speaker,
          type: e.type,
          script: e.script,
          transcript: e.transcript,
          reason,
        });
      }
    }
    if (worst === 1) significantUtterances++;
  }

  // 没有错误的句子当然也算进分母 —— μ-bench 就是对全部 utterance 取比例
  const clean = total - withErrors.length;
  const denominator = clean + scoredUtterances;

  return {
    metric: 'UER',
    model: UER_MODEL(),
    utterances: denominator,
    utterancesWithErrors: withErrors.length,
    significantUtterances,
    uer: denominator ? Math.round((significantUtterances / denominator) * 1000) / 10 : null,
    counts,
    // 只列意思变了的那些 —— minor 和 no error 看数量就够
    errors: errors.slice(0, 60),
    tokensUsed: usage || undefined,
    partial: withErrors.length > MAX_UTTERANCES || failures.length > 0 || undefined,
    skipped: withErrors.length > scoredUtterances ? withErrors.length - scoredUtterances : undefined,
    failures: failures.length ? failures.slice(0, 3) : undefined,
  };
}
