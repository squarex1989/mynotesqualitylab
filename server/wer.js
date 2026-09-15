// 文本切分和对齐 —— 所有确定性指标的地基。
//
// 逐字正确率用编辑距离算，不交给 LLM：WER 是确定值，算一次就是一次；让模型去估
// 会每次不一样、贵、而且 LLM 在长文本上数替换/删除本来就不可靠。
//
// 这里不只给出计数，还把**对齐结果本身**（每个真值 token 对上了候选的哪个
// token）暴露出去。专有名词错成什么、说话人归属对不对、diff 长什么样，全都是从
// 这份对齐上读出来的 —— 那些同样不需要 LLM。
//
// 两个不处理就会让结果完全失真的细节：
//   1. 说话人标签必须剥掉 —— 候选用「Speaker 1」、真值用「Alice」，
//      不剥的话每一行都算一次替换，WER 虚高得没有意义。
//      但标签本身要留下来（谁说的这句），归属分析要用。
//   2. 中日文按字算（CER）—— 没有空格分词，按空白切的话一整行是一个 token。

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;
const TS = String.raw`(?:\[|\()?\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?(?:\]|\))?`;
const SENTENCE_END = /([.!?。！？…]+)/;

/** 拆出「说话人标签」和正文。时间戳一并剥掉。 */
export function splitLine(line) {
  let s = line.replace(new RegExp(String.raw`^\s*${TS}\s*[-–—]?\s*`), '');
  // 冒号前是个短的、不含句末标点的片段 —— 那就是说话人标签
  const m = s.match(/^\s*([^:：]{1,40})[:：]\s*/);
  if (m && !/[。！？.!?,，;；]/.test(m[1])) {
    return { label: m[1].trim(), body: s.slice(m[0].length) };
  }
  return { label: null, body: s };
}

export function stripSpeakerLabels(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => splitLine(l).body)
    .join('\n');
}

// 标点一律去掉，但保留词内的撇号和连字符 —— don't / do not 是真实差异，
// 不该因为去掉撇号就被抹平成一样。大小写在这一步不动（要留给专有名词识别），
// 所以变换是等长的，lower 和 cased 的下标可以一一对应。
const clean = (s) =>
  s
    .replace(/[^\p{L}\p{N}\s'’-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * 把文本切成带出处的 token 序列。
 *
 * 返回的都是平行数组，下标一致；tokens 是纯字符串数组，对齐时比较的就是它，
 * 其余都是元信息。
 */
export function analyze(text) {
  const rawLines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n');

  // 先过一遍决定按词还是按字：CJK 字符占一半以上就按字
  const bodies = rawLines.map((l) => splitLine(l));
  const joined = bodies.map((b) => b.body).join('\n');
  const cjkCount = (joined.match(new RegExp(CJK.source, 'gu')) || []).length;
  const letterCount = (joined.match(/[A-Za-z0-9]/g) || []).length;
  const mode = cjkCount > letterCount ? 'char' : 'word';

  const tokens = [];
  const raw = [];
  const seg = [];
  const offset = [];
  const length = [];
  const speaker = [];
  const line = [];
  const first = [];
  const segments = [];
  const labels = [];

  bodies.forEach(({ label, body }, lineIdx) => {
    if (label && !labels.includes(label)) labels.push(label);

    // 按句切开：句首的大写是语法要求而不是专有名词线索，所以得知道哪里是句首
    for (const piece of body.split(SENTENCE_END)) {
      const cased = clean(piece);
      if (!cased) continue;
      const lower = cased.toLowerCase();
      const segIdx = segments.length;
      segments.push({ line: lineIdx, speaker: label, cased, lower });

      let atSentenceStart = true;
      const push = (start, len) => {
        tokens.push(lower.slice(start, start + len));
        raw.push(cased.slice(start, start + len));
        seg.push(segIdx);
        offset.push(start);
        length.push(len);
        speaker.push(label);
        line.push(lineIdx);
        first.push(atSentenceStart);
        atSentenceStart = false;
      };

      if (mode === 'char') {
        // CJK 单字各算一个 token，连续的拉丁字母数字仍当一个词
        let runStart = -1;
        for (let i = 0; i <= lower.length; i++) {
          const ch = lower[i];
          const isRun = ch && ch !== ' ' && !CJK.test(ch);
          if (isRun && runStart < 0) runStart = i;
          if (!isRun && runStart >= 0) {
            push(runStart, i - runStart);
            runStart = -1;
          }
          if (ch && CJK.test(ch)) push(i, 1);
        }
      } else {
        const re = /[^ ]+/g;
        let m;
        while ((m = re.exec(lower))) push(m.index, m[0].length);
      }
    }
  });

  return { mode, tokens, raw, seg, offset, length, speaker, line, first, segments, labels };
}

/** 旧接口，测试和外部调用还在用 */
export function tokenize(text) {
  const a = analyze(text);
  return { tokens: a.tokens, mode: a.mode };
}

// 完整 DP 的格子上限。方向矩阵用 Uint8Array，40M 格 = 40MB，
// 约等于两边各 6300 个 token（差不多 45 分钟的语速）。
const MAX_CELLS = 40e6;

/**
 * 一次精确的 Levenshtein 对齐，回溯出每一步操作。
 * 替换算 1 次（不是删+插 2 次）—— 这是 WER 的标准定义。
 *
 * @returns {{ ops: {t:'hit'|'sub'|'del'|'ins', ri:number, hi:number}[], S,D,I,hits }}
 */
function alignExact(ref, hyp, rOff = 0, hOff = 0) {
  const n = ref.length;
  const m = hyp.length;

  // 方向矩阵：0=命中/替换（对角）1=删除（少了 ref 的词）2=插入（多了 hyp 的词）
  const dir = new Uint8Array((n + 1) * (m + 1));
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);

  for (let j = 0; j <= m; j++) {
    prev[j] = j;
    dir[j] = 2;
  }
  dir[0] = 0;

  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    dir[i * (m + 1)] = 1;
    for (let j = 1; j <= m; j++) {
      const sub = prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      let best = sub;
      let d = 0;
      if (del < best) {
        best = del;
        d = 1;
      }
      if (ins < best) {
        best = ins;
        d = 2;
      }
      cur[j] = best;
      dir[i * (m + 1) + j] = d;
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }

  const ops = [];
  let S = 0;
  let D = 0;
  let I = 0;
  let hits = 0;
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i === 0) {
      ops.push({ t: 'ins', ri: -1, hi: hOff + j - 1 });
      I++;
      j--;
      continue;
    }
    if (j === 0) {
      ops.push({ t: 'del', ri: rOff + i - 1, hi: -1 });
      D++;
      i--;
      continue;
    }
    const d = dir[i * (m + 1) + j];
    if (d === 0) {
      const hit = ref[i - 1] === hyp[j - 1];
      ops.push({ t: hit ? 'hit' : 'sub', ri: rOff + i - 1, hi: hOff + j - 1 });
      if (hit) hits++;
      else S++;
      i--;
      j--;
    } else if (d === 1) {
      ops.push({ t: 'del', ri: rOff + i - 1, hi: -1 });
      D++;
      i--;
    } else {
      ops.push({ t: 'ins', ri: -1, hi: hOff + j - 1 });
      I++;
      j--;
    }
  }
  ops.reverse();
  return { ops, S, D, I, hits, approximate: false };
}

/**
 * 超长时分块对齐：把 ref 按固定块切开，每块对上 hyp 的等比例窗口（留富余）。
 * 结果是近似的 —— 块边界处的错配会被多算一点 —— 所以会标记 approximate。
 */
function alignChunked(ref, hyp) {
  const BLOCK = 1500;
  const total = { ops: [], S: 0, D: 0, I: 0, hits: 0, approximate: true };
  const ratio = hyp.length / Math.max(1, ref.length);

  for (let start = 0; start < ref.length; start += BLOCK) {
    const refBlock = ref.slice(start, start + BLOCK);
    // hyp 上取等比例位置，两边各留 25% 富余，容纳错位
    const slack = Math.round(refBlock.length * 0.25 * Math.max(1, ratio));
    const from = Math.max(0, Math.round(start * ratio) - slack);
    const to = Math.min(hyp.length, Math.round((start + refBlock.length) * ratio) + slack);
    const r = alignExact(refBlock, hyp.slice(from, to), start, from);
    total.ops.push(...r.ops);
    total.S += r.S;
    total.D += r.D;
    total.I += r.I;
    total.hits += r.hits;
  }
  return total;
}

/**
 * 对齐两份文本。只跑一次，WER、专有名词、说话人归属、diff 全都从这份结果上读。
 */
export function alignTexts(reference, candidate) {
  const ref = analyze(reference);
  const hyp = analyze(candidate);
  const n = ref.tokens.length;

  if (!n) {
    return { ref, hyp, ops: [], S: 0, D: 0, I: 0, hits: 0, approximate: false, unavailable: true };
  }

  const cells = (n + 1) * (hyp.tokens.length + 1);
  const r =
    cells <= MAX_CELLS
      ? alignExact(ref.tokens, hyp.tokens)
      : alignChunked(ref.tokens, hyp.tokens);

  return { ref, hyp, ...r };
}

/**
 * 从对齐结果算出 WER 及其分解。
 *
 * WER = (替换 + 删除 + 插入) / 真值 token 数，可能大于 1（候选里废话太多时）。
 * 删除率单独拿出来看 —— 它直接对应「内容被漏掉」，和「录错了」是两种不同的问题。
 */
export function werFromAlignment(a) {
  const n = a.ref.tokens.length;
  if (!n || a.unavailable) {
    return {
      mode: a.ref.mode,
      refTokens: 0,
      hypTokens: a.hyp.tokens.length,
      unavailable: true,
    };
  }

  const pct = (x) => Math.round((x / n) * 1000) / 10;

  return {
    // 中日文按字算，指标名就该叫 CER 而不是 WER
    mode: a.ref.mode,
    metric: a.ref.mode === 'char' ? 'CER' : 'WER',
    refTokens: n,
    hypTokens: a.hyp.tokens.length,
    substitutions: a.S,
    deletions: a.D,
    insertions: a.I,
    hits: a.hits,
    wer: pct(a.S + a.D + a.I),
    accuracy: Math.max(0, Math.round((a.hits / n) * 1000) / 10),
    substitutionRate: pct(a.S),
    deletionRate: pct(a.D),
    insertionRate: pct(a.I),
    approximate: a.approximate,
  };
}

export function computeWer(reference, candidate) {
  return werFromAlignment(alignTexts(reference, candidate));
}
