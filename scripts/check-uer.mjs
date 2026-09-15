#!/usr/bin/env node
// UER 的断言。跑法：node scripts/check-uer.mjs
//
// 和 μ-bench 同口径：逐个错误判三档（1 意思变了 / 2 真实差异但意思保留 /
// 3 表面不同语义相同），然后**按句二值化** —— 至少一个 score 1 就算这句错了。
//
// 这里用假的 OpenRouter 端点按规则给分，所以验的是我们这一侧的定义实现：
//   - 二值化：一句里错 1 个和错 10 个，对 UER 的贡献一样
//   - score 3 不算错：NovaLedger → Nova Ledger 这种不能计入
//   - 分母是全部 utterance，不是「有错的 utterance」
//   - 插入（没有对应真值 token）要挂到正确的行上
//   - key 缺失或分类器全挂时，实测指标照样出结果

import http from 'node:http';

let seen = [];
/**
 * 按错误文本给分的假分类器。
 *
 * 注意 \b 锚点：prompt 里空值会打印成「(nothing)」，不锚定的 /not/ 会匹配到
 * 里面的 not，把每一条有空侧的错误都误判成「意思变了」。
 */
const RULES = [
  [/\b(not|no|never)\b/i, 1], // 否定词增删 → 意思变了
  [/^\d+$/, 1], // 数字变了 → 意思变了
  [/nova|ledger|meridian/i, 3], // 同一个名字的不同写法 → 表面差异
  [/^(um|uh|okay|so)$/i, 3], // 语气词 → 表面差异
];
const scoreFor = (e) => {
  for (const [re, v] of RULES) if (re.test(e.script) || re.test(e.transcript)) return v;
  return 2; // 其余按「真实差异但意思保留」
};

const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const p = JSON.parse(body);
    seen.push(p);
    // 从 prompt 里把错误条目解析回来，按规则打分
    const prompt = p.messages[1].content;
    const scores = [];
    const re = /id (\d+): (\w+) — script "([^"]*)" → transcript "([^"]*)"/g;
    let m;
    while ((m = re.exec(prompt))) {
      // 把占位符还原成空串，否则「(nothing)」里的 not 会被规则命中
      const un = (x) => (x === '(nothing)' ? '' : x);
      const e = { id: Number(m[1]), type: m[2], script: un(m[3]), transcript: un(m[4]) };
      scores.push({ id: e.id, score: scoreFor(e), reason: `rule for ${e.script || e.transcript}` });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ scores }) } }],
        usage: { total_tokens: 42 },
      })
    );
  });
});
await new Promise((r) => fake.listen(0, r));
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
process.env.OPENROUTER_API_KEY = 'sk-test-0123456789abcdefghij';

const { buildUtterances, computeUer, UER_MODEL } = await import('../server/uer.js');
const { alignTexts } = await import('../server/wer.js');

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
const utt = (ref, cand) => buildUtterances(alignTexts(ref, cand));
const uerOf = (ref, cand) => computeUer(utt(ref, cand));

// ---------------------------------------------------------------- 1
console.log('\n1) 切句：每个错误挂到真值的哪一行');
const u1 = utt(
  'Priya: We closed NovaLedger on Friday.\nDaniel: I do not think the quota is approved.\nPriya: ARR is 18 million.',
  'Speaker 1: We closed Nova Ledger on Friday.\nSpeaker 2: I think the quota is approved.\nSpeaker 1: ARR is 80 million.'
);
t('三行都在', u1.length === 3, `${u1.length}`);
t('行号从 1 开始', u1.map((u) => u.line).join(',') === '1,2,3', u1.map((u) => u.line).join(','));
t('说话人带上了', u1.map((u) => u.speaker).join(',') === 'Priya,Daniel,Priya',
  u1.map((u) => u.speaker).join(','));
t('★ 插入也挂到了正确的行（Nova 在第 1 行）',
  u1[0].errors.some((e) => e.type === 'insertion' && e.transcript === 'Nova'),
  JSON.stringify(u1[0].errors));
t('第 2 行两个删除（do / not）', u1[1].errors.length === 2, JSON.stringify(u1[1].errors));
t('第 3 行一个替换 18→80',
  u1[2].errors.length === 1 && u1[2].errors[0].transcript === '80',
  JSON.stringify(u1[2].errors));
t('每行带上了两侧原文', u1[2].script === 'ARR is 18 million' && u1[2].transcript === 'ARR is 80 million',
  JSON.stringify([u1[2].script, u1[2].transcript]));

// ---------------------------------------------------------------- 2
console.log('\n2) 定义：按句二值化，score 3 不算错');
const r2 = await uerOf(
  'Priya: We closed NovaLedger on Friday.\nDaniel: I do not think the quota is approved.\nPriya: ARR is 18 million.',
  'Speaker 1: We closed Nova Ledger on Friday.\nSpeaker 2: I think the quota is approved.\nSpeaker 1: ARR is 80 million.'
);
console.log('   ', JSON.stringify({ uer: r2.uer, ...r2.counts, 分母: r2.utterances }));
t('★ NovaLedger → Nova Ledger 判 3，第 1 行不算错',
  !r2.errors.some((e) => e.line === 1), JSON.stringify(r2.errors.map((e) => e.line)));
t('第 2 行（否定被吃）算错', r2.errors.some((e) => e.line === 2));
t('第 3 行（数字变了）算错', r2.errors.some((e) => e.line === 3));
t('3 行里 2 行有意思变化 → UER 66.7%', r2.uer === 66.7, `${r2.uer}`);
t('分母是全部 3 行', r2.utterances === 3, `${r2.utterances}`);
t('有错的行是 3 行（第 1 行有错但不 significant）',
  r2.utterancesWithErrors === 3, `${r2.utterancesWithErrors}`);
t('模型名记下来了', r2.model === UER_MODEL());

console.log('\n3) ★ 一句里错 1 个和错 10 个，UER 一样（这是 μ-bench 的定义）');
const one = await uerOf('A: I do not agree.', 'Speaker 1: I agree.');
const many = await uerOf(
  'A: I do not agree with 18 or 42 or 91 or 77.',
  'Speaker 1: I agree with 80 or 24 or 19 or 70.'
);
t('一处意思变化 → 100%', one.uer === 100, `${one.uer}`);
t('五处意思变化 → 还是 100%', many.uer === 100, `${many.uer}`);
t('但错误条数是不一样的（所以要并排看加权 WER）',
  many.counts.significant > one.counts.significant,
  `${many.counts.significant} vs ${one.counts.significant}`);

console.log('\n4) 完全一致 / 全是表面差异');
const clean = await uerOf('A: ARR is 18 million.', 'Speaker 1: ARR is 18 million.');
t('一字不差 → UER 0%，而且不调模型', clean.uer === 0 && clean.counts.significant === 0);
const before = seen.length;
await uerOf('A: ARR is 18 million.', 'Speaker 1: ARR is 18 million.');
t('确实没发请求', seen.length === before, `${seen.length - before} 个请求`);

const surface = await uerOf(
  'A: We closed NovaLedger.\nB: Meridian\'s team signed.',
  "Speaker 1: We closed Nova Ledger.\nSpeaker 2: Meridian team signed."
);
t('★ 两行都只是写法差异 → UER 0%', surface.uer === 0, `${surface.uer}`);
t('但确实有错误被分类了', surface.counts.none > 0, JSON.stringify(surface.counts));

// ---------------------------------------------------------------- 5
console.log('\n5) prompt 和 schema');
const last = seen[seen.length - 1];
t('温度压到 0（分类任务要稳）', last.temperature === 0, `${last.temperature}`);
t('用 strict json_schema', last.response_format?.json_schema?.strict === true);
t('score 限定 1/2/3',
  JSON.stringify(last.response_format.json_schema.schema.properties.scores.items.properties.score.enum) ===
    '[1,2,3]');
t('三档的判据都写进 system 了',
  ['MEANING CHANGED', 'MEANING PRESERVED', 'NO ERROR'].every((x) =>
    last.messages[0].content.includes(x)
  ));
t('rubric 里点名了同名不同写法要判 3',
  last.messages[0].content.includes('Nova Ledger'));
t('每条错误都带上了所在 utterance 的上下文',
  last.messages[1].content.includes('script:') && last.messages[1].content.includes('transcript:'));

// ---------------------------------------------------------------- 6
console.log('\n6) 分类器不可用时');
fake.close();
const dead = await uerOf('A: I do not agree.', 'Speaker 1: I agree.');
t('不抛错，返回 unavailable', dead.unavailable === true, JSON.stringify(dead));
t('带上原因', typeof dead.reason === 'string' && dead.reason.length > 0, dead.reason);

const { gradeTranscript } = await import('../server/judge.js');
const graded = await gradeTranscript({
  reference: 'A: I do not agree with 18 million.',
  candidate: 'Speaker 1: I agree with 80 million.',
});
t('★ 裁判和分类器全挂，实测指标照样出', graded.metrics.wer.wer > 0, `${graded.metrics.wer.wer}`);
t('uer 标为 unavailable', graded.uer.unavailable === true, JSON.stringify(graded.uer));
t('utterances 是中间产物，不进结果', graded.metrics.utterances === undefined);

console.log(`\n${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
