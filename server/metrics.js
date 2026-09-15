// 从一次对齐结果里读出所有确定性指标。
//
// 这里做的事情原本有三项是交给 LLM 的（逐字正确率、专有名词、说话人归属），
// 现在全部改成 code：
//
//   - 专有名词：真值里的名字对上了候选的哪个 token，对齐结果里直接能读到，
//     能报出「Claude → Cloud」这种具体替换，而不是一个 0-100 的印象分。
//   - 说话人归属：按对齐结果建「真值说话人 × 候选标签」的计数矩阵，再求最优
//     一对一映射。这样能把「两个人被合成一个标签」和「一个人被拆成多个标签」
//     分开报 —— 这是两种完全不同的产品缺陷，LLM 看文本反而数不准。
//   - 加权错误率：漏一个「嗯」和漏一个人名不该算一样重。
//
// 留给 LLM 的只有两件它真正擅长的事：判断漏掉的内容算不算「关键」，以及意思
// 有没有被弄反。这两件都需要理解语义，code 做不了。

import { alignTexts, werFromAlignment } from './wer.js';
import {
  FILLER_PHRASES,
  NEGATION_PHRASES,
  WEIGHTS,
  CASE_NOISE,
} from './lexicon.js';

/** 按 mode 拼回可读文本：中日文不加空格 */
const join = (a, idx) => idx.map((i) => a.raw[i]).join(a.mode === 'char' ? '' : ' ');

/** 每个 segment 里的 token 下标，按出现顺序 */
function segmentIndex(a) {
  const map = a.segments.map(() => []);
  for (let i = 0; i < a.tokens.length; i++) map[a.seg[i]].push(i);
  return map;
}

/**
 * 在文本里找短语，返回覆盖到的 token 区间。
 *
 * 要求匹配的两端都正好落在 token 边界上 —— 否则英文找 "no" 会命中 "nothing"，
 * 中文找「不」会命中「不过」的一部分（后者在按字模式下本来就是单字 token，
 * 边界检查对两种模式都成立）。
 */
function findPhrases(a, phrases, segIdx) {
  const found = [];
  a.segments.forEach((s, si) => {
    const idx = segIdx[si];
    if (!idx.length) return;
    const startAt = new Map(idx.map((i) => [a.offset[i], i]));
    const endAt = new Map(idx.map((i) => [a.offset[i] + a.length[i], i]));

    for (const phrase of phrases) {
      let from = 0;
      for (;;) {
        const at = s.lower.indexOf(phrase, from);
        if (at < 0) break;
        from = at + 1;
        const first = startAt.get(at);
        const last = endAt.get(at + phrase.length);
        if (first === undefined || last === undefined || last < first) continue;
        found.push({ phrase, start: first, end: last + 1 });
      }
    }
  });
  return found;
}

const maskOf = (occurrences) => {
  const m = new Set();
  for (const o of occurrences) for (let i = o.start; i < o.end; i++) m.add(i);
  return m;
};

/**
 * 专有名词候选。
 *
 * 英文靠句中大写自动识别（句首大写是语法要求，不是线索）；中日文没有大小写，
 * 自动识别不了，所以靠 host 填的 glossary 和 transcript 里的说话人名字。
 */
function properNouns(a, { glossary, speakerNames }, segIdx) {
  const occ = [];

  // glossary 和说话人名字：两种模式都按短语匹配
  const terms = [...new Set([...glossary, ...speakerNames].map((t) => t.toLowerCase()))]
    .filter((t) => t.length > 0)
    .sort((x, y) => y.length - x.length);
  const taken = new Set();
  for (const o of findPhrases(a, terms, segIdx)) {
    // 长短语优先，已经被更长的词占掉的位置不再重复算
    let clash = false;
    for (let i = o.start; i < o.end; i++) if (taken.has(i)) clash = true;
    if (clash) continue;
    for (let i = o.start; i < o.end; i++) taken.add(i);
    occ.push({ term: join(a, range(o.start, o.end)), start: o.start, end: o.end, source: 'glossary' });
  }

  if (a.mode === 'word') {
    // 句中大写词，连续的合成一个（Acme Corp 是一个名字，不是两个）
    let run = null;
    const flush = () => {
      if (run) occ.push({ ...run, term: join(a, range(run.start, run.end)), source: 'auto' });
      run = null;
    };
    for (let i = 0; i < a.tokens.length; i++) {
      const w = a.raw[i];
      const capped =
        /^[A-Z]/.test(w) && !a.first[i] && !CASE_NOISE.has(a.tokens[i]) && !taken.has(i);
      const acronym = /^[A-Z]{2,}$/.test(w) && !taken.has(i);
      if (capped || acronym) {
        if (run && run.end === i) run.end = i + 1;
        else {
          flush();
          run = { start: i, end: i + 1 };
        }
      } else flush();
    }
    flush();
  }

  return occ;
}

const range = (from, to) => {
  const out = [];
  for (let i = from; i < to; i++) out.push(i);
  return out;
};

/** 含阿拉伯数字的 token。中文数字（一/二/三）和常用字重合太多，不收。 */
function numberMask(a) {
  const m = new Set();
  for (let i = 0; i < a.tokens.length; i++) if (/\d/.test(a.tokens[i])) m.add(i);
  return m;
}

/** 三档权重：语气词 0.1，普通 1，关键词（名字/数字/否定词）3 */
function weighTokens(a, { fillers, keys }) {
  const weight = new Float64Array(a.tokens.length);
  const tier = new Array(a.tokens.length);
  let total = 0;
  const count = { filler: 0, normal: 0, key: 0 };
  for (let i = 0; i < a.tokens.length; i++) {
    // 关键词优先于语气词 —— 「不」既短又常见，但它是否定词，不能按语气词算
    const t = keys.has(i) ? 'key' : fillers.has(i) ? 'filler' : 'normal';
    tier[i] = t;
    weight[i] = WEIGHTS[t];
    count[t]++;
    total += weight[i];
  }
  return { weight, tier, total, count };
}

/** 真值 token 下标 → 它在对齐里的操作 */
function opByRef(ops) {
  const m = new Map();
  for (const o of ops) if (o.ri >= 0) m.set(o.ri, o);
  return m;
}

/** 一个真值区间对到了候选的哪段文本 */
function landedOn(a, opMap, start, end) {
  const his = [];
  for (let i = start; i < end; i++) {
    const o = opMap.get(i);
    if (o && o.hi >= 0) his.push(o.hi);
  }
  return his.length ? join(a.hyp, his) : '';
}

/**
 * 专有名词和数字的逐条结果。
 * 不打分 —— 直接列出「期望是什么、实际录成了什么、出现几次」。
 */
function termOutcomes(a, opMap, occurrences) {
  const byTerm = new Map();
  for (const o of occurrences) {
    const key = o.term.toLowerCase();
    let rec = byTerm.get(key);
    if (!rec) {
      rec = { term: o.term, source: o.source, total: 0, correct: 0, dropped: 0, wrong: [] };
      byTerm.set(key, rec);
    }
    rec.total++;

    const ops = range(o.start, o.end).map((i) => opMap.get(i)?.t || 'del');
    if (ops.every((t) => t === 'hit')) {
      rec.correct++;
      continue;
    }
    if (ops.every((t) => t === 'del')) {
      rec.dropped++;
      continue;
    }
    const got = landedOn(a, opMap, o.start, o.end);
    const hit = rec.wrong.find((w) => w.got === got);
    if (hit) hit.count++;
    else rec.wrong.push({ got, count: 1, line: a.ref.line[o.start] + 1 });
  }

  const all = [...byTerm.values()].sort((x, y) => y.total - x.total);
  const issues = all.filter((r) => r.dropped || r.wrong.length);
  return {
    checked: all.length,
    occurrences: all.reduce((s, r) => s + r.total, 0),
    clean: all.length - issues.length,
    issues,
  };
}

/**
 * 说话人归属。
 *
 * 候选用什么标签无所谓（Speaker 1 也行），只要每个标签稳定对应一个真人。
 * 所以先求最优一对一映射，再看有多少 token 落在了映射之外。
 */
function speakerReport(a) {
  const refNames = a.ref.labels;
  const candLabels = a.hyp.labels;

  if (!refNames.length) return { unavailable: true, reason: 'The script has no speaker labels' };
  if (!candLabels.length) {
    // 「没做说话人分离」和「分离了但分错了」是两种不同的产品行为，不该同分
    return { unlabeled: true, refSpeakers: refNames.length };
  }

  const ri = new Map(refNames.map((n, i) => [n, i]));
  const ci = new Map(candLabels.map((n, i) => [n, i]));
  const counts = refNames.map(() => candLabels.map(() => 0));
  let aligned = 0;
  for (const o of a.ops) {
    if (o.t !== 'hit' && o.t !== 'sub') continue;
    const r = ri.get(a.ref.speaker[o.ri]);
    const c = ci.get(a.hyp.speaker[o.hi]);
    if (r === undefined || c === undefined) continue;
    counts[r][c]++;
    aligned++;
  }

  const mapping = bestAssignment(counts);
  let matched = 0;
  const refSpeakers = refNames.map((name, r) => {
    const tokens = counts[r].reduce((s, x) => s + x, 0);
    const to = mapping[r];
    const mine = to >= 0 ? counts[r][to] : 0;
    matched += mine;
    const strays = candLabels
      .map((label, c) => ({ label, tokens: counts[r][c] }))
      .filter((x) => x.tokens > 0 && candLabels.indexOf(x.label) !== to)
      .sort((x, y) => y.tokens - x.tokens);
    return { name, tokens, mappedTo: to >= 0 ? candLabels[to] : null, matched: mine, strays };
  });

  // 一个真值说话人的话散到了多个标签上 —— 产品把一个人拆成了好几个
  const splits = refSpeakers
    .filter((s) => s.tokens > 0)
    .map((s) => ({
      speaker: s.name,
      labels: [
        ...(s.mappedTo ? [{ label: s.mappedTo, tokens: s.matched }] : []),
        ...s.strays,
      ].filter((l) => l.tokens / s.tokens >= 0.1),
    }))
    .filter((s) => s.labels.length > 1);

  // 一个标签承担了多个真值说话人 —— 产品把几个人合成了一个
  const merges = candLabels
    .map((label, c) => {
      const tokens = refNames.reduce((s, _n, r) => s + counts[r][c], 0);
      const speakers = refNames
        .filter((_n, r) => tokens > 0 && counts[r][c] / tokens >= 0.1)
        .map((n, _i) => n);
      return { label, tokens, speakers };
    })
    .filter((m) => m.speakers.length > 1);

  return {
    refSpeakers,
    candLabels: candLabels.map((label, c) => ({
      label,
      tokens: refNames.reduce((s, _n, r) => s + counts[r][c], 0),
    })),
    alignedTokens: aligned,
    misattributed: aligned - matched,
    attributionAccuracy: aligned ? Math.round((matched / aligned) * 1000) / 10 : null,
    labelCountDelta: candLabels.length - refNames.length,
    splits,
    merges,
  };
}

/**
 * 最优一对一映射（最大化落在映射里的 token 数）。
 * 说话人个数很小，位掩码 DP 精确解；异常多的时候退化成贪心。
 */
function bestAssignment(counts) {
  const n = counts.length;
  const m = counts[0]?.length || 0;
  if (!m) return counts.map(() => -1);

  if (n <= 10 && m <= 12) {
    const memo = new Map();
    const best = (r, used) => {
      if (r === n) return { score: 0, pick: [] };
      const key = r * (1 << m) + used;
      const seen = memo.get(key);
      if (seen) return seen;
      // 也允许不分配（真值说话人比候选标签多时必然有人分不到）
      let out = { score: 0, pick: [-1, ...best(r + 1, used).pick] };
      for (let c = 0; c < m; c++) {
        if (used & (1 << c)) continue;
        const rest = best(r + 1, used | (1 << c));
        const score = counts[r][c] + rest.score;
        if (score > out.score) out = { score, pick: [c, ...rest.pick] };
      }
      memo.set(key, out);
      return out;
    };
    return best(0, 0).pick;
  }

  const cells = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < m; c++) cells.push([counts[r][c], r, c]);
  cells.sort((a, b) => b[0] - a[0]);
  const pick = new Array(n).fill(-1);
  const usedC = new Set();
  for (const [v, r, c] of cells) {
    if (v <= 0 || pick[r] >= 0 || usedC.has(c)) continue;
    pick[r] = c;
    usedC.add(c);
  }
  return pick;
}

/**
 * 交给 LLM 的线索：code 能确定「否定词不见了」「数字变了」，但判断
 * 「这句意思是不是真的反了」还得靠语义理解。
 */
function codeLeads(a, opMap, refNeg, hypNeg, refNum) {
  const leads = [];
  const ctx = (side, i, span = 6) => {
    const from = Math.max(0, i - span);
    const to = Math.min(side.tokens.length, i + span + 1);
    return join(side, range(from, to));
  };

  for (const i of refNeg) {
    const o = opMap.get(i);
    const t = o?.t || 'del';
    if (t === 'hit') continue;
    leads.push({
      kind: t === 'del' ? 'negation-dropped' : 'negation-changed',
      line: a.ref.line[i] + 1,
      speaker: a.ref.speaker[i],
      reference: ctx(a.ref, i),
      candidate: o && o.hi >= 0 ? ctx(a.hyp, o.hi) : '(dropped)',
      detail: `"${a.ref.raw[i]}"${o && o.hi >= 0 ? ` → "${a.hyp.raw[o.hi]}"` : ' is missing'}`,
    });
  }

  // 候选里多出来的否定词同样会把意思弄反
  const hypIns = new Set(a.ops.filter((o) => o.t === 'ins').map((o) => o.hi));
  for (const j of hypNeg) {
    if (!hypIns.has(j)) continue;
    leads.push({
      kind: 'negation-added',
      line: a.hyp.line[j] + 1,
      speaker: a.hyp.speaker[j],
      reference: '(not in the script)',
      candidate: ctx(a.hyp, j),
      detail: `"${a.hyp.raw[j]}" was added`,
    });
  }

  for (const i of refNum) {
    const o = opMap.get(i);
    const t = o?.t || 'del';
    if (t === 'hit') continue;
    leads.push({
      kind: t === 'del' ? 'number-dropped' : 'number-changed',
      line: a.ref.line[i] + 1,
      speaker: a.ref.speaker[i],
      reference: ctx(a.ref, i),
      candidate: o && o.hi >= 0 ? ctx(a.hyp, o.hi) : '(dropped)',
      detail: `"${a.ref.raw[i]}"${o && o.hi >= 0 ? ` → "${a.hyp.raw[o.hi]}"` : ' is missing'}`,
    });
  }

  return leads;
}

const MAX_HUNKS = 220;

/**
 * 把对齐结果压成 diff 片段：只有出错的地方 + 前后一点上下文。
 *
 * LLM 只看这些片段和完整真值，不用看完整候选 —— 判断「漏掉的算不算关键内容」
 * 需要知道这场会在讲什么（所以给完整真值），但不需要逐字读一遍候选。
 */
function diffHunks(a) {
  const GAP = 3; // 两处错误之间命中不超过这么多，就并成一个片段
  const CTX = 8;

  const runs = [];
  let cur = null;
  a.ops.forEach((o, k) => {
    if (o.t === 'hit') {
      if (cur && k - cur.lastBad > GAP) {
        runs.push(cur);
        cur = null;
      }
      return;
    }
    if (!cur) cur = { from: k, to: k, lastBad: k };
    cur.to = k;
    cur.lastBad = k;
  });
  if (cur) runs.push(cur);

  const hunks = runs.slice(0, MAX_HUNKS).map((run, n) => {
    const from = Math.max(0, run.from - CTX);
    const to = Math.min(a.ops.length, run.to + CTX + 1);
    const refIdx = [];
    const hypIdx = [];
    const refBad = [];
    const hypBad = [];
    for (let k = from; k < to; k++) {
      const o = a.ops[k];
      const bad = k >= run.from && k <= run.to;
      if (o.ri >= 0) {
        refIdx.push(o.ri);
        if (bad) refBad.push(o.ri);
      }
      if (o.hi >= 0) {
        hypIdx.push(o.hi);
        if (bad) hypBad.push(o.hi);
      }
    }
    const mark = (side, idx, bad) => {
      const badSet = new Set(bad);
      const sep = side.mode === 'char' ? '' : ' ';
      const out = [];
      let inBad = false;
      for (const i of idx) {
        const isBad = badSet.has(i);
        if (isBad && !inBad) out.push('⟦');
        if (!isBad && inBad) out.push('⟧');
        inBad = isBad;
        out.push(side.raw[i]);
      }
      if (inBad) out.push('⟧');
      return out
        .join(sep)
        .replace(new RegExp(`⟦${sep}`, 'g'), '⟦')
        .replace(new RegExp(`${sep}⟧`, 'g'), '⟧');
    };

    const anchor = refBad[0] ?? refIdx[0];
    return {
      n: n + 1,
      line: anchor !== undefined ? a.ref.line[anchor] + 1 : null,
      speaker: anchor !== undefined ? a.ref.speaker[anchor] : null,
      reference: mark(a.ref, refIdx, refBad),
      candidate: mark(a.hyp, hypIdx, hypBad),
      dropped: refBad.length > 0 && hypBad.length === 0,
    };
  });

  return { hunks, truncated: runs.length > MAX_HUNKS, totalRuns: runs.length };
}

/** glossary 文本（每行一个词）→ 数组 */
export function parseGlossary(text) {
  return String(text || '')
    .split(/[\n,;、，；]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 60)
    .slice(0, 300);
}

/**
 * 所有 code 侧指标。只对齐一次。
 *
 * @param {{reference: string, candidate: string, glossary?: string}} input
 */
export function codeMetrics({ reference, candidate, glossary = '' }) {
  const a = alignTexts(reference, candidate);
  const wer = werFromAlignment(a);
  if (wer.unavailable) return { wer, unavailable: true };

  const refSeg = segmentIndex(a.ref);
  const hypSeg = segmentIndex(a.hyp);
  const terms = parseGlossary(glossary);
  const speakerNames = a.ref.labels.filter((l) => !/^speaker\s*\d+$/i.test(l));
  const ctx = { glossary: terms, speakerNames };

  const refNouns = properNouns(a.ref, ctx, refSeg);
  const hypNouns = properNouns(a.hyp, ctx, hypSeg);
  const refNum = numberMask(a.ref);
  const hypNum = numberMask(a.hyp);
  const refNeg = maskOf(findPhrases(a.ref, NEGATION_PHRASES, refSeg));
  const hypNeg = maskOf(findPhrases(a.hyp, NEGATION_PHRASES, hypSeg));
  const refFill = maskOf(findPhrases(a.ref, FILLER_PHRASES, refSeg));
  const hypFill = maskOf(findPhrases(a.hyp, FILLER_PHRASES, hypSeg));

  const refKeys = new Set([...maskOf(refNouns), ...refNum, ...refNeg]);
  const hypKeys = new Set([...maskOf(hypNouns), ...hypNum, ...hypNeg]);
  const rw = weighTokens(a.ref, { fillers: refFill, keys: refKeys });
  const hw = weighTokens(a.hyp, { fillers: hypFill, keys: hypKeys });

  // 加权错误率：分母是真值的总权重；插入按候选那个词自己的权重算
  //（产品自己加一堆「嗯」不该被当成大问题）
  let wSub = 0;
  let wDel = 0;
  let wIns = 0;
  let keyBad = 0;
  for (const o of a.ops) {
    if (o.t === 'sub') wSub += rw.weight[o.ri];
    else if (o.t === 'del') wDel += rw.weight[o.ri];
    else if (o.t === 'ins') wIns += hw.weight[o.hi];
    if ((o.t === 'sub' || o.t === 'del') && refKeys.has(o.ri)) keyBad++;
  }
  const den = rw.total || 1;
  const wp = (x) => Math.round((x / den) * 1000) / 10;

  const opMap = opByRef(a.ops);
  const { hunks, truncated, totalRuns } = diffHunks(a);

  return {
    wer,
    weighted: {
      metric: `Weighted ${wer.metric}`,
      wer: wp(wSub + wDel + wIns),
      substitutionRate: wp(wSub),
      deletionRate: wp(wDel),
      insertionRate: wp(wIns),
      // 关键词单独看一眼：漏的到底是「嗯」还是人名和数字
      keyErrorRate: rw.count.key
        ? Math.round((keyBad / rw.count.key) * 1000) / 10
        : null,
      keyTokens: rw.count.key,
      fillerTokens: rw.count.filler,
      normalTokens: rw.count.normal,
      weights: WEIGHTS,
    },
    properNouns: termOutcomes(a, opMap, refNouns),
    numbers: termOutcomes(
      a,
      opMap,
      [...refNum].sort((x, y) => x - y).map((i) => ({
        term: a.ref.raw[i],
        start: i,
        end: i + 1,
        source: 'number',
      }))
    ),
    speakers: speakerReport(a),
    glossaryTerms: terms.length,
    leads: codeLeads(a, opMap, [...refNeg].sort((x, y) => x - y), [...hypNeg], [...refNum].sort((x, y) => x - y)),
    hunks,
    hunksTruncated: truncated,
    totalDiffRuns: totalRuns,
  };
}
