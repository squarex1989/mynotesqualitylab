// 逐字正确率用编辑距离算，不交给 LLM。
//
// 为什么：WER 是确定值，算一次就是一次；让模型去估会每次不一样、贵、而且
// LLM 在长文本上数替换/删除本来就不可靠。模型该做的是语义判断（意思有没有被
// 弄反、关键内容有没有丢），不是做算术。
//
// 两个不处理就会让结果完全失真的细节：
//   1. 说话人标签必须剥掉 —— 候选用「Speaker 1」、真值用「Alice」，
//      不剥的话每一行都算一次替换，WER 虚高得没有意义。
//   2. 中文按字算（CER）—— 中文没有空格分词，按空白切的话一整行是一个 token。

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;
const TS = String.raw`(?:\[|\()?\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?(?:\]|\))?`;

/** 一行开头的「名字:」或「Speaker 1:」前缀，以及时间戳 */
function stripLabel(line) {
  let s = line.replace(new RegExp(String.raw`^\s*${TS}\s*[-–—]?\s*`), '');
  // 冒号前是个短的、不含句末标点的片段 —— 那就是说话人标签
  const m = s.match(/^\s*([^:：]{1,40})[:：]\s*/);
  if (m && !/[。！？.!?,，;；]/.test(m[1])) s = s.slice(m[0].length);
  return s;
}

export function stripSpeakerLabels(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(stripLabel)
    .join('\n');
}

/**
 * 切成可比对的 token。
 * @returns {{ tokens: string[], mode: 'word'|'char' }}
 */
export function tokenize(text) {
  const bare = stripSpeakerLabels(text);

  // 判断按词还是按字：CJK 字符占比过半就按字
  const cjkCount = (bare.match(new RegExp(CJK.source, 'g')) || []).length;
  const letterCount = (bare.match(/[A-Za-z0-9]/g) || []).length;
  const mode = cjkCount > letterCount ? 'char' : 'word';

  // 标点一律去掉，但保留词内的撇号和连字符 —— don't / do not 是真实差异，
  // 不该因为去掉撇号就被抹平成一样。
  const cleaned = bare
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'’-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return { tokens: [], mode };

  if (mode === 'char') {
    // 按字：CJK 单字各算一个，连续的拉丁字母数字仍当一个词
    const tokens = [];
    for (const chunk of cleaned.split(' ')) {
      let buf = '';
      for (const ch of chunk) {
        if (CJK.test(ch)) {
          if (buf) {
            tokens.push(buf);
            buf = '';
          }
          tokens.push(ch);
        } else {
          buf += ch;
        }
      }
      if (buf) tokens.push(buf);
    }
    return { tokens: tokens.filter(Boolean), mode };
  }

  return { tokens: cleaned.split(' ').filter(Boolean), mode };
}

// 完整 DP 的格子上限。方向矩阵用 Uint8Array，40M 格 = 40MB，
// 约等于两边各 6300 个 token（差不多 45 分钟的语速）。
const MAX_CELLS = 40e6;

/**
 * 一次精确的 Levenshtein 对齐，回溯出替换/删除/插入的个数。
 * 替换算 1 次（不是删+插 2 次）—— 这是 WER 的标准定义。
 */
function alignExact(ref, hyp) {
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

  let S = 0;
  let D = 0;
  let I = 0;
  let hits = 0;
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i === 0) {
      I++;
      j--;
      continue;
    }
    if (j === 0) {
      D++;
      i--;
      continue;
    }
    const d = dir[i * (m + 1) + j];
    if (d === 0) {
      if (ref[i - 1] === hyp[j - 1]) hits++;
      else S++;
      i--;
      j--;
    } else if (d === 1) {
      D++;
      i--;
    } else {
      I++;
      j--;
    }
  }
  return { S, D, I, hits, approximate: false };
}

/**
 * 超长时分块对齐：把 ref 按固定块切开，每块对上 hyp 的等比例窗口（留富余）。
 * 结果是近似的 —— 块边界处的错配会被多算一点 —— 所以会标记 approximate。
 */
function alignChunked(ref, hyp) {
  const BLOCK = 1500;
  const total = { S: 0, D: 0, I: 0, hits: 0, approximate: true };
  const ratio = hyp.length / Math.max(1, ref.length);

  for (let start = 0; start < ref.length; start += BLOCK) {
    const refBlock = ref.slice(start, start + BLOCK);
    // hyp 上取等比例位置，两边各留 25% 富余，容纳错位
    const slack = Math.round(refBlock.length * 0.25 * Math.max(1, ratio));
    const from = Math.max(0, Math.round(start * ratio) - slack);
    const to = Math.min(hyp.length, Math.round((start + refBlock.length) * ratio) + slack);
    const r = alignExact(refBlock, hyp.slice(from, to));
    total.S += r.S;
    total.D += r.D;
    total.I += r.I;
    total.hits += r.hits;
  }
  return total;
}

/**
 * 算 WER 及其分解。
 *
 * WER = (替换 + 删除 + 插入) / 真值 token 数，可能大于 1（候选里废话太多时）。
 * 删除率单独拿出来看 —— 它直接对应「内容被漏掉」，和「录错了」是两种不同的问题。
 */
export function computeWer(reference, candidate) {
  const ref = tokenize(reference);
  const hyp = tokenize(candidate);
  const n = ref.tokens.length;

  if (!n) {
    return { mode: ref.mode, refTokens: 0, hypTokens: hyp.tokens.length, unavailable: true };
  }

  const cells = (n + 1) * (hyp.tokens.length + 1);
  const r =
    cells <= MAX_CELLS
      ? alignExact(ref.tokens, hyp.tokens)
      : alignChunked(ref.tokens, hyp.tokens);

  const pct = (x) => Math.round((x / n) * 1000) / 10;

  return {
    // 中文按字算，指标名就该叫 CER 而不是 WER
    mode: ref.mode,
    metric: ref.mode === 'char' ? 'CER' : 'WER',
    refTokens: n,
    hypTokens: hyp.tokens.length,
    substitutions: r.S,
    deletions: r.D,
    insertions: r.I,
    hits: r.hits,
    wer: pct(r.S + r.D + r.I),
    accuracy: Math.max(0, Math.round((r.hits / n) * 1000) / 10),
    substitutionRate: pct(r.S),
    deletionRate: pct(r.D),
    insertionRate: pct(r.I),
    approximate: r.approximate,
  };
}

/** 把指标写成一句话，塞进裁判的 prompt 里当事实依据 */
export function werBriefing(w) {
  if (!w || w.unavailable) return 'Word-level metrics unavailable.';
  return [
    `${w.metric} ${w.wer}% (${w.refTokens} reference ${w.mode === 'char' ? 'characters' : 'words'}):`,
    `${w.substitutions} substituted, ${w.deletions} deleted, ${w.insertions} inserted.`,
    `Deletion rate ${w.deletionRate}%, substitution rate ${w.substitutionRate}%, insertion rate ${w.insertionRate}%.`,
    w.approximate ? '(Approximate — transcript too long for exact alignment.)' : '',
  ]
    .filter(Boolean)
    .join(' ');
}
