#!/usr/bin/env node
// 对比打分里所有 code 侧逻辑的断言。
//
// 每组的期望值都是能手算出来的 —— 权重、替换数、映射结果都写在注释里。
// 跑法：node scripts/check-metrics.mjs

import http from 'node:http';
import { codeMetrics, parseGlossary } from '../server/metrics.js';
import { analyze, alignTexts } from '../server/wer.js';

let pass = 0;
let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
};
const group = (n) => console.log(`\n${n}`);

// ---------------------------------------------------------------- 1
group('1) 加权：漏一个语气词和漏一个人名，普通 WER 一样，加权差 30 倍');
// 真值 7 个词：um(0.1) we should ship(各1) quicksilver(3) on(1) friday(3)
// 总权重 = 0.1 + 1 + 1 + 1 + 3 + 1 + 3 = 10.1
const refA = 'Alice: um we should ship Quicksilver on Friday.';
const dropFiller = codeMetrics({
  reference: refA,
  candidate: 'Speaker 1: we should ship Quicksilver on Friday.',
});
const dropName = codeMetrics({
  reference: refA,
  candidate: 'Speaker 1: um we should ship on Friday.',
});
t('两边普通 WER 都是 14.3%', dropFiller.wer.wer === 14.3 && dropName.wer.wer === 14.3,
  `${dropFiller.wer.wer} / ${dropName.wer.wer}`);
t('漏语气词加权 1%（0.1/10.1）', dropFiller.weighted.wer === 1, `${dropFiller.weighted.wer}`);
t('漏人名加权 29.7%（3/10.1）', dropName.weighted.wer === 29.7, `${dropName.weighted.wer}`);
t('关键词 2 个（Quicksilver / Friday）', dropName.weighted.keyTokens === 2,
  `${dropName.weighted.keyTokens}`);
t('语气词 1 个（um）', dropName.weighted.fillerTokens === 1, `${dropName.weighted.fillerTokens}`);
t('漏语气词时关键词错误率 0%', dropFiller.weighted.keyErrorRate === 0);
t('漏人名时关键词错误率 50%（2 个里错 1 个）', dropName.weighted.keyErrorRate === 50,
  `${dropName.weighted.keyErrorRate}`);

// ---------------------------------------------------------------- 2
group('2) 边界：no 不能命中 nominal，ok 不能命中 broker');
const bound = codeMetrics({
  reference: 'Alice: The broker sent a nominal invoice.',
  candidate: 'Speaker 1: The broker sent a nominal invoice.',
});
t('没有误判出关键词', bound.weighted.keyTokens === 0, `${bound.weighted.keyTokens}`);
t('没有误判出语气词', bound.weighted.fillerTokens === 0, `${bound.weighted.fillerTokens}`);
t('完全一致 → 0%', bound.wer.wer === 0 && bound.weighted.wer === 0);

// ---------------------------------------------------------------- 3
group('3) 专有名词：逐条列出录成了什么，不打分');
const nouns = codeMetrics({
  reference: 'Alice: I think Priya said Claude handles it.\nBob: And Acme signed off.',
  candidate: 'Speaker 1: I think Prya said Cloud handles it.\nSpeaker 2: And Acme signed off.',
});
const pn = nouns.properNouns;
t('识别出 3 个（Priya / Claude / Acme）', pn.checked === 3, `${pn.checked}`);
t('1 个全对（Acme）', pn.clean === 1, `${pn.clean}`);
const asStr = pn.issues.map((i) => `${i.term}→${i.wrong.map((w) => w.got).join('|')}`).sort();
t('Priya → Prya', asStr.some((s) => s === 'Priya→Prya'), asStr.join(', '));
t('Claude → Cloud', asStr.some((s) => s === 'Claude→Cloud'), asStr.join(', '));
t('句首大写不算专有名词（I / And 没进来）',
  !pn.issues.some((i) => /^(i|and)$/i.test(i.term)));

// 词被拆开是常见的 ASR 错误，插入的那半必须算进来
const splitWord = codeMetrics({
  reference: 'Alice: We ship Quicksilver today.',
  candidate: 'Speaker 1: We ship Quick Silver today.',
});
t('Quicksilver → Quick Silver（不是 → Quick）',
  splitWord.properNouns.issues.some((i) => i.wrong.some((w) => w.got === 'Quick Silver')),
  JSON.stringify(splitWord.properNouns.issues));
// 反过来：两个词被并成一个
const gluedWord = codeMetrics({
  reference: 'Alice: We ship Acme Robotics today.',
  candidate: 'Speaker 1: We ship AcmeRobotics today.',
});
t('Acme Robotics → AcmeRobotics',
  gluedWord.properNouns.issues.some((i) => i.term === 'Acme Robotics'),
  JSON.stringify(gluedWord.properNouns.issues));
// 漏掉要报成 dropped，而不是「替换成了空」
const droppedName = codeMetrics({
  reference: 'Alice: I told Marcus about it.\nBob: Fine.',
  candidate: 'Speaker 1: Fine.',
  glossary: 'Marcus',
});
t('整句被漏 → 名字记为 dropped 而不是 wrong',
  droppedName.properNouns.issues.some((i) => i.term === 'Marcus' && i.dropped === 1 && !i.wrong.length),
  JSON.stringify(droppedName.properNouns.issues));

// ---------------------------------------------------------------- 4
group('4) 中文：没有大小写，靠 glossary 认专有名词');
const zh = codeMetrics({
  reference: '张三: 王小明说下周上线。\n李四: 好。',
  candidate: 'Speaker 1: 王小名说下周上线。\nSpeaker 2: 好。',
  glossary: '王小明\n下周上线',
});
t('指标名是 CER', zh.wer.metric === 'CER', zh.wer.metric);
t('王小明被检出', zh.properNouns.checked >= 1, `${zh.properNouns.checked}`);
t('报出 王小明 → 王小名',
  zh.properNouns.issues.some((i) => i.term === '王小明' && i.wrong.some((w) => w.got === '王小名')),
  JSON.stringify(zh.properNouns.issues));
t('没配 glossary 就认不出来（这是已知限制）',
  codeMetrics({
    reference: '张三: 王小明说下周上线。',
    candidate: 'Speaker 1: 王小名说下周上线。',
  }).properNouns.checked === 0);

// ---------------------------------------------------------------- 4b
group('4b) 非语音内容不能计入：方括号标注和时间码');
// 真值 14 词：Was that the NovaLedger plan(5) / Okay we hit 30 MOIC(5) /
//            And NovaLedger closed Friday(4)
// 候选 16 词：Nova Ledger 把 NovaLedger 拆成两个词，所以两句各多一个
// 差异：NovaLedger→Nova 替换 2 次 + Ledger 插入 2 次 = 4/14 = 28.6%
const noisy = codeMetrics({
  reference: [
    'Alice: [HESITATION] Was that the NovaLedger plan?',
    'Bob: [LAUGH] Okay, we hit 30% MOIC.',
    'Alice: [OVERLAP] And NovaLedger closed Friday.',
  ].join('\n'),
  candidate: [
    '1',
    '00:35:42 --> 00:36:20',
    'Speaker 1: Was that the Nova Ledger plan?',
    '',
    '2',
    '00:36:20 --> 00:37:17',
    'Speaker 2: Okay, we hit 30% MOIC.',
    '',
    '3',
    '00:37:17 --> 00:39:22',
    'Speaker 1: And Nova Ledger closed Friday.',
  ].join('\n'),
});
t('真值 14 词（方括号标注没算进去）', noisy.wer.refTokens === 14, `${noisy.wer.refTokens}`);
t('候选 16 词（时间轴行和序号行没算进去）', noisy.wer.hypTokens === 16, `${noisy.wer.hypTokens}`);
t('S2 D0 I2', noisy.wer.substitutions === 2 && noisy.wer.deletions === 0 && noisy.wer.insertions === 2,
  `S${noisy.wer.substitutions} D${noisy.wer.deletions} I${noisy.wer.insertions}`);
t('WER 28.6%', noisy.wer.wer === 28.6, `${noisy.wer.wer}`);
const noisyTerms = noisy.properNouns.issues.map((i) => i.term);
t('★ [HESITATION]/[LAUGH]/[OVERLAP] 没被当成缩写词',
  !noisyTerms.some((x) => /hesitation|laugh|overlap/i.test(x)), JSON.stringify(noisyTerms));
t('只报出真正的问题 NovaLedger → Nova Ledger',
  noisyTerms.length === 1 &&
    noisy.properNouns.issues[0].wrong.some((w) => w.got === 'Nova Ledger'),
  JSON.stringify(noisy.properNouns.issues));
t('★ 时间码没被当成数字（只有 30% 里那个 30）', noisy.numbers.checked === 1,
  `${noisy.numbers.checked}`);
t('数字一个都没错', noisy.numbers.issues.length === 0, JSON.stringify(noisy.numbers.issues));
// 关键词 5 个：NovaLedger ×2、MOIC、30、Friday。语气词 1 个：Okay
t('关键词正好 5 个（标注和时间码都不在内）', noisy.weighted.keyTokens === 5,
  `${noisy.weighted.keyTokens}`);
t('Okay 算语气词', noisy.weighted.fillerTokens === 1, `${noisy.weighted.fillerTokens}`);
// 12 / 23.1 = 51.9%（5×3 + 8×1 + 1×0.1 = 23.1；错的是 2 个 NovaLedger 和 2 个插入的 Ledger）
t('加权 51.9%', noisy.weighted.wer === 51.9, `${noisy.weighted.wer}`);
t('时间轴行没把说话人搞乱', noisy.speakers.attributionAccuracy === 100,
  `${noisy.speakers.attributionAccuracy}`);

group('4c) 逐类剥离');
const tk = (x) => analyze(x).tokens;
t('方括号标注', tk('A: [HESITATION] Was that it?').join(' ') === 'was that it');
t('中文方括号', tk('张三: 【笑】好。').join('') === '好');
t('VTT 时间轴行整行丢掉', tk('00:35:42 --> 00:36:20').length === 0);
t('SRT 序号行整行丢掉', tk('  17  ').length === 0);
t('行首三段时间码', tk('00:35:42 A: hello there').join(' ') === 'hello there');
t('说话人标签后面的时间码', tk('A: 35:42 hello there').join(' ') === 'hello there',
  JSON.stringify(tk('A: 35:42 hello there')));
t('标签前面的时间码', tk('35:42 A: hello there').join(' ') === 'hello there',
  JSON.stringify(tk('35:42 A: hello there')));
// 行尾的裸 mm:ss 不剥 —— 更可能是台词里真在说时间。宁可漏剥，不要吃掉内容。
t('台词里真在说的时间要留着', tk('A: meet at 10:30').join(' ') === 'meet at 10 30',
  JSON.stringify(tk('A: meet at 10:30')));
t('行尾的裸 mm:ss 当成内容', tk('A: hello there 35:42').join(' ') === 'hello there 35 42',
  JSON.stringify(tk('A: hello there 35:42')));
t('--> 不会剩下一个 -- token',
  !tk('A: we shipped --> done').some((x) => /^-+$/.test(x)),
  JSON.stringify(tk('A: we shipped --> done')));

// ---------------------------------------------------------------- 5
group('5) 数字');
const num = codeMetrics({
  reference: 'Alice: We need 3000 units by Q3 and 12 people.',
  candidate: 'Speaker 1: We need 300 units by Q3 and 12 people.',
});
t('检出 3 个数字（3000 / q3 / 12）', num.numbers.checked === 3, `${num.numbers.checked}`);
t('报出 3000 → 300',
  num.numbers.issues.some((i) => i.term === '3000' && i.wrong.some((w) => w.got === '300')),
  JSON.stringify(num.numbers.issues));
t('数字变了会作为线索给 LLM',
  num.leads.some((l) => l.kind === 'number-changed' && l.detail.includes('3000')),
  JSON.stringify(num.leads));

// ---------------------------------------------------------------- 6
group('6) 说话人归属：标签叫什么无所谓，只要稳定对应一个人');
const refSpk = 'Alice: one two three four\nBob: five six seven eight';
const correct = codeMetrics({
  reference: refSpk,
  candidate: 'Speaker 1: one two three four\nSpeaker 2: five six seven eight',
});
t('对应正确 → 100%', correct.speakers.attributionAccuracy === 100,
  `${correct.speakers.attributionAccuracy}`);
t('映射 Alice→Speaker 1',
  correct.speakers.refSpeakers[0].mappedTo === 'Speaker 1',
  correct.speakers.refSpeakers[0].mappedTo);

// 标签叫什么都行，只要一个标签稳定对应一个真人
const renamed = codeMetrics({
  reference: refSpk,
  candidate: 'Zebra: one two three four\nAardvark: five six seven eight',
});
t('标签换成别的名字仍是 100%', renamed.speakers.attributionAccuracy === 100,
  `${renamed.speakers.attributionAccuracy}`);
t('映射 Alice→Zebra', renamed.speakers.refSpeakers[0].mappedTo === 'Zebra',
  renamed.speakers.refSpeakers[0].mappedTo);

// 切换说话人的位置偏了两个词 —— 真实的 diarization 错误长这样
const drift = codeMetrics({
  reference: refSpk,
  candidate: 'Speaker 1: one two three four five six\nSpeaker 2: seven eight',
});
t('说话人切换点偏移 → 75%（6/8）', drift.speakers.attributionAccuracy === 75,
  `${drift.speakers.attributionAccuracy}`);
t('归错 2 个词', drift.speakers.misattributed === 2, `${drift.speakers.misattributed}`);
t('逐字一个不差（错的只是归属）', drift.wer.wer === 0, `${drift.wer.wer}`);

const merged = codeMetrics({
  reference: refSpk,
  candidate: 'Speaker 1: one two three four\nSpeaker 1: five six seven eight',
});
t('两人被合成一个标签 → 50%', merged.speakers.attributionAccuracy === 50,
  `${merged.speakers.attributionAccuracy}`);
t('报出 merge', merged.speakers.merges.length === 1 &&
  merged.speakers.merges[0].speakers.length === 2, JSON.stringify(merged.speakers.merges));
t('少了一个说话人', merged.speakers.labelCountDelta === -1, `${merged.speakers.labelCountDelta}`);

const split = codeMetrics({
  reference: refSpk,
  candidate: 'Speaker 1: one two\nSpeaker 2: three four\nSpeaker 3: five six seven eight',
});
t('一人被拆成两个标签 → 75%（6/8）', split.speakers.attributionAccuracy === 75,
  `${split.speakers.attributionAccuracy}`);
t('报出 split', split.speakers.splits.some((s) => s.speaker === 'Alice' && s.labels.length === 2),
  JSON.stringify(split.speakers.splits));

const bare = codeMetrics({ reference: refSpk, candidate: 'one two three four five six seven eight' });
t('候选没有任何标签 → 报 N/A 而不是 0 分', bare.speakers.unlabeled === true,
  JSON.stringify(bare.speakers));

// ---------------------------------------------------------------- 7
group('7) 否定词：code 只负责发现，判断意思有没有反交给 LLM');
const neg = codeMetrics({
  reference: "Alice: I don't think the quota is approved.",
  candidate: 'Speaker 1: I think the quota is approved.',
});
t('否定词被漏掉 → 一条线索',
  neg.leads.some((l) => l.kind === 'negation-dropped' && l.detail.includes("don't")),
  JSON.stringify(neg.leads));
t("don't 按关键词加权（权重 3）", neg.weighted.keyTokens >= 1, `${neg.weighted.keyTokens}`);

const negAdd = codeMetrics({
  reference: 'Alice: I think the quota is approved.',
  candidate: "Speaker 1: I don't think the quota is approved.",
});
t('候选多出否定词 → 一条线索',
  negAdd.leads.some((l) => l.kind === 'negation-added'), JSON.stringify(negAdd.leads));

// ---------------------------------------------------------------- 8
group('8) diff 片段：只给出错的地方 + 上下文');
const hunked = codeMetrics({
  reference: 'Alice: alpha bravo charlie delta echo foxtrot golf hotel india juliet',
  candidate: 'Speaker 1: alpha bravo charly delta echo foxtrot golf hotel juliet',
});
t('两处错误相隔 5 个命中 → 拆成 2 段', hunked.hunks.length === 2, `${hunked.hunks.length}`);
t('第 1 段标出 charlie → charly',
  hunked.hunks[0].reference.includes('⟦charlie⟧') &&
    hunked.hunks[0].candidate.includes('⟦charly⟧'),
  JSON.stringify(hunked.hunks[0]));
t('第 2 段标为「候选里没有」', hunked.hunks[1].dropped === true, JSON.stringify(hunked.hunks[1]));
t('片段带上了原文行号和说话人',
  hunked.hunks[0].line === 1 && hunked.hunks[0].speaker === 'Alice',
  JSON.stringify(hunked.hunks[0]));

const nearby = codeMetrics({
  reference: 'Alice: alpha bravo charlie delta echo foxtrot golf',
  candidate: 'Speaker 1: alpha bravx charlie delta echx foxtrot golf',
});
t('两处错误只隔 2 个命中 → 并成 1 段', nearby.hunks.length === 1, `${nearby.hunks.length}`);

// ---------------------------------------------------------------- 9
group('9) 切分和对齐的基本性质');
t('说话人标签不算进 token', analyze('Alice: one two').tokens.length === 2);
t('中文按字切', analyze('张三: 这个方案我有意见。').tokens.length === 8,
  `${analyze('张三: 这个方案我有意见。').tokens.length}`);
t('时间戳被剥掉', analyze('00:01:23 Alice: one two').tokens.join(' ') === 'one two',
  analyze('00:01:23 Alice: one two').tokens.join(' '));
// 平局时必须选命中多的那条路径。这里「3 次替换」和「插入+替换+命中+删除」
// 代价都是 3，选错会得出 launch→Silver、um→launch 这种无意义配对。
const tie = alignTexts('Alice: the Quicksilver launch. Um, are we ready?',
  'Speaker 1: the Quick Silver launch. Are we ready?');
t('平局选命中多的：S1 D1 I1 而不是 S3',
  tie.S === 1 && tie.D === 1 && tie.I === 1 && tie.hits === 5,
  `S${tie.S} D${tie.D} I${tie.I} hits${tie.hits}`);
t('launch 对上了 launch（没被配给 Silver）',
  tie.ops.some((o) => o.t === 'hit' && tie.ref.raw[o.ri] === 'launch'),
  tie.ops.map((o) => `${o.t}:${o.ri >= 0 ? tie.ref.raw[o.ri] : '-'}→${o.hi >= 0 ? tie.hyp.raw[o.hi] : '-'}`).join(' '));
t('um 记为删除（权重 0.1），不是替换',
  tie.ops.some((o) => o.t === 'del' && tie.ref.raw[o.ri] === 'Um'));

const al = alignTexts('Alice: a b c', 'Bob: a x c');
t('对齐操作序列可读', al.ops.map((o) => o.t).join(',') === 'hit,sub,hit',
  al.ops.map((o) => o.t).join(','));
t("don't 不会被抹平成 do not",
  codeMetrics({ reference: "A: I don't know", candidate: 'B: I do not know' }).wer.wer > 0);
t('真值为空 → unavailable',
  codeMetrics({ reference: '', candidate: 'anything' }).unavailable === true);
t('glossary 支持换行和中英文标点分隔',
  parseGlossary('a\nb, c；d、e').length === 5, JSON.stringify(parseGlossary('a\nb, c；d、e')));

// ---------------------------------------------------------------- 10
group('10) 长文本退化为近似对齐');
const big = (n, shift) =>
  'A: ' + Array.from({ length: n }, (_, i) => `w${(i + shift) % 997}`).join(' ');
const t0 = Date.now();
const long = codeMetrics({ reference: big(7000, 0), candidate: big(7000, 0) });
t('7000 token 走近似路径', long.wer.approximate === true);
t(`且足够快（${Date.now() - t0}ms）`, Date.now() - t0 < 5000);

// ---------------------------------------------------------------- 11
group('11) 端到端：两个裁判的证据合并并标注来源');
const FINDINGS = {
  'openai/gpt-5.6-sol': {
    missingContent: [
      {
        hunk: 1,
        reference: 'we should ship Quicksilver on Friday',
        candidate: '(nothing)',
        severity: 'critical',
        why: 'The ship date never appears.',
      },
    ],
    meaningFlips: [
      {
        hunk: 2,
        reference: "I don't think the quota is approved",
        candidate: 'I think the quota is approved',
        severity: 'critical',
        why: 'Reverses whether the quota is approved.',
      },
    ],
    summary: 'Dropped the ship date and flipped the quota.',
  },
  'anthropic/claude-opus-5': {
    // 同一处，但引文略有不同 —— 应该被合并
    missingContent: [
      {
        hunk: -1,
        reference: 'should ship Quicksilver on Friday',
        candidate: '(nothing)',
        severity: 'minor',
        why: 'The commitment to Friday is gone entirely, so nobody knows the date.',
      },
      {
        hunk: 5,
        reference: 'the budget was cut',
        candidate: '(nothing)',
        severity: 'minor',
        why: 'Minor context loss.',
      },
    ],
    meaningFlips: [],
    summary: 'Mostly the missing ship date.',
  },
};

let captured = null;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const p = JSON.parse(body);
    if (!captured) captured = p;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(FINDINGS[p.model]) } }],
        usage: { total_tokens: 1 },
      })
    );
  });
});
await new Promise((r) => fake.listen(0, r));
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
process.env.OPENROUTER_API_KEY = 'sk-test-0123456789abcdefghij';

const { gradeTranscript, QUESTIONS } = await import('../server/judge.js');

t('只剩 2 个问题交给 LLM',
  QUESTIONS.map((q) => q.key).join(',') === 'missingContent,meaningFlips',
  QUESTIONS.map((q) => q.key).join(','));

const graded = await gradeTranscript({
  reference: "Alice: I don't think the quota is approved.\nBob: We should ship Quicksilver on Friday.",
  candidate: 'Speaker 1: I think the quota is approved.',
  glossary: 'Quicksilver',
});

t('两个裁判都跑了', graded.judges.length === 2, `${graded.judges.length}`);
t('结果里带 code 指标', !!graded.metrics?.weighted);
t('diff 片段没被存进结果里（只是喂模型的中间产物）', graded.metrics.hunks === undefined);
t('线索保留下来了', Array.isArray(graded.metrics.leads) && graded.metrics.leads.length > 0);
t('结果里没有任何分数',
  !JSON.stringify(graded.evidence).includes('"score"'));

const mc = graded.evidence.missingContent;
t('missingContent 合并成 2 条', mc.length === 2, `${mc.length}`);
t('同一处被两个裁判都抓到 → 标 both 且排最前',
  mc[0].sources.length === 2, JSON.stringify(mc[0].sources));
t('严重程度取高的那个（critical 胜 minor）', mc[0].severity === 'critical', mc[0].severity);
t('只有一个裁判报的那条标 1 个来源', mc[1].sources.length === 1, JSON.stringify(mc[1].sources));
t('meaningFlips 只有 GPT 报',
  graded.evidence.meaningFlips.length === 1 &&
    graded.evidence.meaningFlips[0].sources.join() === 'gpt',
  JSON.stringify(graded.evidence.meaningFlips));
t('critical 计数 = 2', graded.critical === 2, `${graded.critical}`);

group('12) 喂给模型的 prompt');
const sent = captured.messages[1].content;
t('给了完整真值', sent.includes('THE SCRIPT'));
t('实测数字作为事实写进去了', sent.includes('ALREADY MEASURED'));
t('带上了加权错误率', sent.includes('Weighted'));
t('带上了 diff 片段', sent.includes('DIFF HUNKS') && sent.includes('⟦'));
t('带上了 code 标出的否定词线索', sent.includes('negation-dropped'));
t('没有把完整候选再塞一遍', !sent.includes('CANDIDATE ('));
t('schema 里只有两个问题',
  Object.keys(captured.response_format.json_schema.schema.properties).sort().join(',') ===
    'meaningFlips,missingContent,summary',
  Object.keys(captured.response_format.json_schema.schema.properties).join(','));
t('要求的是证据条目而不是分数',
  captured.response_format.json_schema.schema.properties.missingContent.type === 'array');

group('13) 裁判挂了，实测部分照样出结果');
fake.close();
const noJudge = await gradeTranscript({
  reference: 'Alice: I think the quota is approved.',
  candidate: 'Speaker 1: I think the quota is approved.',
});
t('不抛错', true);
t('标记裁判不可用', noJudge.judgesUnavailable === true);
t('实测指标仍在', noJudge.metrics.wer.wer === 0);
t('两条失败原因都带上了', noJudge.failures.length === 2, `${noJudge.failures.length}`);

console.log(`\n${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
