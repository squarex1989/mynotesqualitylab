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

/*
 * 非语音内容，两边都要剥掉。
 *
 * 不剥的话会从两头污染指标：真值里多出一堆没人念的 token，候选里多出一堆没人
 * 说的 token。而且这些东西恰好最容易被误判成「关键词」—— [HESITATION] 全大写，
 * 会被当成缩写词；时间码含数字，会被当成数字。两者都按 3 倍权重算，加权错误率
 * 于是彻底失真。
 */

// 方括号标注：[HESITATION] [LAUGH] [OVERLAP] [inaudible] [crosstalk] …
const ANNOTATION = /\[[^\]\n]{0,120}\]|【[^】\n]{0,120}】/g;

// VTT/SRT 的时间轴行和序号行，整行都不是台词
const CUE_LINE = /^\s*\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\s*-{1,3}>\s*\d{1,2}:\d{2}/;
const SEQ_LINE = /^\s*\d{1,4}\s*$/;

// 三段式时间码（00:35:42）没有歧义，出现在哪儿都剥
const TS_FULL = /\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?\b/g;


// 箭头和长横线的残渣。clean() 特意保留连字符（don't、t-shirt 要留），
// 所以 --> 会剩下一个 -- token，得在这儿清掉
const DASH_RUN = /-{2,}>?|<-{2,}/g;

/** 剥掉一行里所有非语音的东西。整行是时间轴或序号的话返回空串。 */
function scrub(line) {
  const s = String(line).replace(ANNOTATION, ' ');
  if (CUE_LINE.test(s) || SEQ_LINE.test(s)) return '';
  return s.replace(TS_FULL, ' ').replace(DASH_RUN, ' ');
}

/**
 * 行首的时间码。
 *
 * 两段式（35:42）只在行首剥，不在行尾剥 —— 实际格式里时间码都在行首、方括号里、
 * 或者 VTT 的时间轴行上，而行尾一个裸的 mm:ss 更可能是台词里真在说时间
 *（「那就约 10:30」）。宁可漏剥一个时间码，也不要把内容当成时间码吃掉。
 */
const TS_LEAD = new RegExp(String.raw`^\s*${TS}\s*[-–—]?\s*`);

/** 拆出「说话人标签」和正文。非语音内容（方括号标注、时间码）一并剥掉。 */
export function splitLine(line) {
  const s = scrub(line).replace(TS_LEAD, '');
  if (!s.trim()) return { label: null, body: '' };
  // 冒号前是个短的、不含句末标点的片段 —— 那就是说话人标签
  const m = s.match(/^\s*([^:：]{1,40})[:：]\s*/);
  if (m && !/[。！？.!?,，;；]/.test(m[1])) {
    // 标签后面还可能跟一个时间码：「Alice: 35:42 那我们…」
    return { label: m[1].trim(), body: s.slice(m[0].length).replace(TS_LEAD, '') };
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
        const text = lower.slice(start, start + len);
        // 只剩标点的不算 token（连字符和撇号是 clean() 特意保留的）
        if (!/[\p{L}\p{N}]/u.test(text)) return;
        tokens.push(text);
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
 * 代价相同的对齐往往有很多条，**平局时选命中最多的那条**。这不是锦上添花：
 *
 *   ref: quicksilver launch um        hyp: quick silver launch
 *
 * 「3 次替换」和「替换 + 插入 + 命中 + 删除」代价都是 3。选前者会得出
 * launch→Silver、um→launch 这种毫无意义的配对，于是专有名词报成
 * 「Quicksilver → Quick」（看着像被截断）、一个权重 1 的实词和一个权重 0.1 的
 * 语气词互换了位置、说话人矩阵也跟着错。总 WER 不受影响（代价一样），但 S/D/I
 * 的分布、加权错误率和所有从对齐上读出来的东西都依赖挑对这条路径。
 *
 * @returns {{ ops: {t:'hit'|'sub'|'del'|'ins', ri:number, hi:number}[], S,D,I,hits }}
 */
function alignExact(ref, hyp, rOff = 0, hOff = 0) {
  const n = ref.length;
  const m = hyp.length;

  // 方向矩阵：0=命中/替换（对角）1=删除（少了 ref 的词）2=插入（多了 hyp 的词）
  const dir = new Uint8Array((n + 1) * (m + 1));
  // 每格存两个量：最小代价，以及取到该代价时路径上的命中数（用来打破平局）
  let prev = new Int32Array(m + 1);
  let prevHits = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  let curHits = new Int32Array(m + 1);

  for (let j = 0; j <= m; j++) {
    prev[j] = j;
    dir[j] = 2;
  }
  dir[0] = 0;

  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    curHits[0] = 0;
    dir[i * (m + 1)] = 1;
    for (let j = 1; j <= m; j++) {
      const match = ref[i - 1] === hyp[j - 1];
      // 代价升序、命中降序：代价一样就选命中多的
      let best = prev[j - 1] + (match ? 0 : 1);
      let bestHits = prevHits[j - 1] + (match ? 1 : 0);
      let d = 0;

      const del = prev[j] + 1;
      if (del < best || (del === best && prevHits[j] > bestHits)) {
        best = del;
        bestHits = prevHits[j];
        d = 1;
      }

      const ins = cur[j - 1] + 1;
      if (ins < best || (ins === best && curHits[j - 1] > bestHits)) {
        best = ins;
        bestHits = curHits[j - 1];
        d = 2;
      }

      cur[j] = best;
      curHits[j] = bestHits;
      dir[i * (m + 1) + j] = d;
    }
    let swap = prev;
    prev = cur;
    cur = swap;
    swap = prevHits;
    prevHits = curHits;
    curHits = swap;
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
