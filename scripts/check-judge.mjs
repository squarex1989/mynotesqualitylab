#!/usr/bin/env node
// 真实调用 OpenRouter，验证两个裁判模型。
//
// 跑法（本地）：    node --env-file-if-exists=.env scripts/check-judge.mjs
// 跑法（Railway）： node scripts/check-judge.mjs
//
// 这里不只是看 API 通不通。候选转录里**故意埋了几种已知错误**，然后检查：
//   1. 契约：strict JSON Schema 里的数组类型到底能不能用（这是最可能踩坑的地方，
//      有些模型对数组 + strict 的支持是残的，会静默降级或直接 400）
//   2. 召回：那几处明显的错误，裁判抓不抓得到
//   3. 误报：漏掉的语气词、换掉的说话人标签，裁判会不会当成问题报上来
//
// 埋的错误（都是手写的，位置明确）：
//   A  否定词被吃掉      "I don't think we can hit that" → "I think we can hit that"
//   B  整句被漏掉        企业 SSO 那句整行消失
//   C  日期被改          April 4 → April 14
//   D  专有名词错 ×3     Acme→Acne, Marcus→Marquis, Quicksilver→Quick Silver
//   E  语气词被漏 ×3     um / uh —— 不该被当成问题
//   F  说话人标签不同    Priya/Daniel → Speaker 1/Speaker 2，且有一处归属错

import { JUDGES, QUESTIONS, apiKeyProblem, gradeTranscript } from '../server/judge.js';
import { codeMetrics } from '../server/metrics.js';

const REFERENCE = [
  "Priya: Let's start with the Quicksilver launch. Um, are we still on for March 14?",
  "Daniel: I don't think we can hit that date. The Acme integration slipped two weeks.",
  "Priya: That's the second slip. Uh, what is the actual blocker?",
  'Daniel: Their API quota. We asked for 5000 requests a minute and they approved 500.',
  'Priya: So we either renegotiate or we ship without Acme.',
  'Daniel: Shipping without Acme means no enterprise SSO, which was the whole pitch.',
  "Priya: Then we move the date. Let's say April 4, and I'll tell the board myself.",
  "Daniel: Agreed. Um, I'll send Marcus the revised timeline today.",
].join('\n');

const CANDIDATE = [
  // E: um 没了；D: Quicksilver → Quick Silver
  "Speaker 1: Let's start with the Quick Silver launch. Are we still on for March 14?",
  // A: 否定被吃掉；D: Acme → Acne
  'Speaker 2: I think we can hit that date. The Acne integration slipped two weeks.',
  // E: uh 没了
  "Speaker 1: That's the second slip. What is the actual blocker?",
  'Speaker 2: Their API quota. We asked for 5000 requests a minute and they approved 500.',
  // F: 这句是 Priya 说的，却挂在了 Speaker 2 下面
  'Speaker 2: So we either renegotiate or we ship without Acne.',
  // B: 企业 SSO 那句整行消失
  // C: April 4 → April 14
  "Speaker 1: Then we move the date. Let's say April 14, and I'll tell the board myself.",
  // D: Marcus → Marquis；E: um 没了
  "Speaker 2: Agreed. I'll send Marquis the revised timeline today.",
].join('\n');

const GLOSSARY = 'Quicksilver\nAcme\nPriya\nDaniel\nMarcus';

let pass = 0;
let fail = 0;
let warn = 0;
const hard = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
};
const soft = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    warn++;
    console.log(`  ⚠ ${name} ${extra}`);
  }
};

const key = process.env.OPENROUTER_API_KEY;
console.log('OPENROUTER_API_KEY:', key ? `${key.length} 字符，前缀 ${key.slice(0, 8)}…` : '没有');
const problem = apiKeyProblem();
if (problem) {
  console.log(`\n✗ ${problem}\n`);
  console.log('  本地跑：把 key 写进 .env，然后');
  console.log('    node --env-file-if-exists=.env scripts/check-judge.mjs\n');
  process.exit(1);
}
console.log('裁判:', JUDGES.map((j) => `${j.label} [${j.model}]`).join('  |  '));

// ---------------------------------------------------------------- 1
console.log('\n1) code 侧先把能算的算出来');
const m = codeMetrics({ reference: REFERENCE, candidate: CANDIDATE, glossary: GLOSSARY });
console.log(
  `   ${m.wer.metric} ${m.wer.wer}% / 加权 ${m.weighted.wer}% / 关键词错 ${m.weighted.keyErrorRate}% ` +
    `(S${m.wer.substitutions} D${m.wer.deletions} I${m.wer.insertions}，真值 ${m.wer.refTokens} 词)`
);
const nounIssues = m.properNouns.issues.map(
  (i) =>
    `${i.term}→${[...i.wrong.map((w) => w.got), ...(i.dropped ? [`(漏掉${i.dropped > 1 ? ' ×' + i.dropped : ''})`] : [])].join('/')}`
);
console.log('   专有名词问题:', nounIssues.join(', ') || '无');
console.log(
  '   说话人归属:',
  m.speakers.attributionAccuracy + '%',
  '| 归错', m.speakers.misattributed, '词',
  '| 映射', (m.speakers.refSpeakers || []).map((r) => `${r.name}→${r.mappedTo}`).join(' ')
);
console.log('   线索:', m.leads.map((l) => l.kind).join(', ') || '无');
console.log('   diff 片段:', m.hunks.length);

hard('D: Acme → Acne 被抓到', nounIssues.some((s) => /^Acme→Acne/.test(s)), nounIssues.join(','));
hard('D: Marcus → Marquis 被抓到', nounIssues.some((s) => /^Marcus→Marquis/.test(s)), nounIssues.join(','));
hard('C: 日期 4 → 14 被抓到',
  m.numbers.issues.some((i) => i.term === '4' && i.wrong.some((w) => w.got === '14')),
  JSON.stringify(m.numbers.issues));
hard("A: don't 被吃掉 → 有 negation 线索",
  m.leads.some((l) => l.kind === 'negation-dropped'), JSON.stringify(m.leads.map((l) => l.detail)));
hard('F: 说话人标签不同不扣分，但归属错要扣',
  m.speakers.attributionAccuracy < 100 && m.speakers.attributionAccuracy > 70,
  `${m.speakers.attributionAccuracy}%`);
// E 用差分验证：把 3 个语气词加回候选，普通 WER 会明显变好，加权几乎不动
const withFillers = CANDIDATE.replace("Speaker 1: Let's start with the Quick Silver launch. Are we",
  "Speaker 1: Let's start with the Quick Silver launch. Um, are we")
  .replace("That's the second slip. What is", "That's the second slip. Uh, what is")
  .replace("Speaker 2: Agreed. I'll send", "Speaker 2: Agreed. Um, I'll send");
const mF = codeMetrics({ reference: REFERENCE, candidate: withFillers, glossary: GLOSSARY });
const plainGain = Math.round((m.wer.wer - mF.wer.wer) * 10) / 10;
const weightedGain = Math.round((m.weighted.wer - mF.weighted.wer) * 10) / 10;
console.log(`   把 3 个语气词加回去：普通 ${m.wer.wer}%→${mF.wer.wer}%（-${plainGain}）`
  + `，加权 ${m.weighted.wer}%→${mF.weighted.wer}%（-${weightedGain}）`);
hard('E: 漏语气词对普通 WER 有明显影响', plainGain >= 2, `${plainGain}`);
hard('E: 但对加权几乎没影响（权重 0.1 生效）', weightedGain <= 0.5, `${weightedGain}`);

// ---------------------------------------------------------------- 2
console.log('\n2) 真实调用两个裁判（reasoning=high，可能要等一两分钟）');
const t0 = Date.now();
const r = await gradeTranscript({ reference: REFERENCE, candidate: CANDIDATE, glossary: GLOSSARY });
const secs = ((Date.now() - t0) / 1000).toFixed(1);

for (const f of r.failures) console.log(`   ✗ ${f.label}: ${f.message}`);
hard('两个裁判都成功返回', r.judges.length === 2, `只有 ${r.judges.length} 个`);
if (!r.judges.length) {
  console.log(`\n${pass} 通过 / ${fail} 失败 / ${warn} 警告 —— 裁判全挂，后面跳过\n`);
  process.exit(1);
}

let cost = 0;
for (const j of r.judges) {
  const u = j.usage || {};
  console.log(
    `   ${j.label}: ${u.prompt_tokens ?? '?'} in / ${u.completion_tokens ?? '?'} out` +
      (u.cost !== undefined ? ` = $${Number(u.cost).toFixed(4)}` : '')
  );
  if (u.cost !== undefined) cost += Number(u.cost);
}
console.log(`   用时 ${secs}s，合计 $${cost.toFixed(4)}`);

// ---------------------------------------------------------------- 3
console.log('\n3) 契约：strict schema 下的数组类型真的能用');
hard('返回的是数组而不是被降级成字符串',
  QUESTIONS.every((q) => Array.isArray(r.evidence[q.key])),
  JSON.stringify(Object.fromEntries(QUESTIONS.map((q) => [q.key, typeof r.evidence[q.key]]))));
hard('每条证据字段齐全',
  QUESTIONS.every((q) =>
    r.evidence[q.key].every(
      (x) => x.reference && x.candidate && ['critical', 'minor'].includes(x.severity) && x.sources.length
    )
  ));
hard('两份简报都有', r.judges.every((j) => j.summary.length > 20));

// ---------------------------------------------------------------- 4
console.log('\n4) 召回：埋的错误抓到了吗');
const all = [...r.evidence.missingContent, ...r.evidence.meaningFlips];
const quotes = all.map((x) => `${x.reference} ⇢ ${x.candidate}`.toLowerCase());
const has = (...words) => quotes.some((q) => words.every((w) => q.includes(w.toLowerCase())));

console.log(`   missingContent ${r.evidence.missingContent.length} 条，meaningFlips ${r.evidence.meaningFlips.length} 条，critical ${r.critical}`);
for (const q of QUESTIONS) {
  for (const it of r.evidence[q.key]) {
    console.log(
      `   [${q.key}/${it.severity}/${it.sources.join('+')}] #${it.hunk}\n` +
        `      script: ${it.reference}\n      cand:   ${it.candidate}\n      why:    ${it.why}`
    );
  }
}

hard("A: 抓到否定被吃掉（don't think → think）", has("don't think"), quotes.join(' || ').slice(0, 300));
hard('B: 抓到整句被漏（enterprise SSO）', has('sso'), quotes.join(' || ').slice(0, 300));
soft('C: 抓到日期被改（April 4 → 14）', has('april'), '（code 已经确定报出了，模型漏了不致命）');
soft('A 被两个裁判都抓到',
  all.some((x) => x.reference.toLowerCase().includes("don't think") && x.sources.length === 2),
  '（只有一个裁判抓到）');

// ---------------------------------------------------------------- 5
console.log('\n5) 误报：不该报的有没有报上来');
const fillerNoise = all.filter((x) => /^\W*(um|uh|uhm|er)\W*$/i.test(x.reference.trim()));
hard('没把漏掉的语气词当成问题', fillerNoise.length === 0, JSON.stringify(fillerNoise));
const labelNoise = all.filter((x) => /speaker\s*\d/i.test(x.reference) || /speaker\s*\d/i.test(x.why));
soft('没把说话人标签不同当成问题', labelNoise.length === 0, JSON.stringify(labelNoise.map((x) => x.why)));
const fabricated = all.filter((x) => {
  // 引文必须真的在真值里（允许大小写和标点差异）
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const needle = norm(x.reference);
  return needle.length > 12 && !norm(REFERENCE).includes(needle);
});
hard('没有编造引文（每条 reference 都能在真值里找到）',
  fabricated.length === 0,
  JSON.stringify(fabricated.map((x) => x.reference)));

console.log(`\n${pass} 项通过，${fail} 项失败，${warn} 项警告\n`);
process.exit(fail ? 1 : 0);
