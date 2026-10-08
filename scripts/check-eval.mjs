#!/usr/bin/env node
// 新评估机制 + 综合报告的断言。判定模型换成本地假服务，按 schema 名字分发，
// 返回固定的逐条结论 —— 这样代码算出来的每个分数都能精确核对。
//
// 跑法：node scripts/check-eval.mjs

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-'));

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

// ---------------------------------------------------------------- 假判定模型
const REFERENCE = {
  entities: [
    { text: 'Alice', type: 'person' },
    { text: 'Quicksilver', type: 'product' },
    { text: 'Acme', type: 'organization' },
  ],
  units: [
    { type: 'decision', importance: 3, text: 'Ship Quicksilver to Acme on Friday', lines: [1], owner: '', due: '', deliverable: '', status: 'none' },
    { type: 'risk', importance: 2, text: 'Budget may be cut', lines: [2], owner: '', due: '', deliverable: '', status: 'none' },
    { type: 'action_item', importance: 3, text: 'Alice sends the contract by Friday', lines: [3], owner: 'Alice', due: 'Friday', deliverable: 'contract', status: 'committed' },
    { type: 'fact', importance: 1, text: 'Acme has 40 seats', lines: [4], owner: '', due: '', deliverable: '', status: 'none' },
  ],
};
const claim = (c, verdict, error_type = 'none', critical = false, critical_type = 'none') => ({
  claim: c, section: '', verdict, evidence_lines: [1], evidence: 'quote', error_type, critical, critical_type,
});
const attrs = (o) => ({ owner_check: 'correct', due_check: 'correct', deliverable_check: 'correct', status_check: 'correct', ...o });
const SUMMARY_VERDICTS = {
  // My Notes：4 条全对；覆盖 U1/U2/U3，漏 U4（次要）；1 个行动项全对
  MN: {
    claims: [claim('a', 'supported'), claim('b', 'supported'), claim('c', 'supported'), claim('d', 'supported')],
    coverage: [
      { unit_id: 'U1', status: 'covered', claim_index: 0 },
      { unit_id: 'U2', status: 'covered', claim_index: 1 },
      { unit_id: 'U3', status: 'covered', claim_index: 2 },
      { unit_id: 'U4', status: 'missing', claim_index: -1 },
    ],
    action_items: [
      { text: 'Alice sends the contract by Friday', owner: 'Alice', due: 'Friday', deliverable: 'contract', status: 'committed', verdict: 'valid', invalid_reason: 'none', matched_unit_id: 'U3', ...attrs({}) },
    ],
  },
  // Granola：2 对、1 条把「可能」写成「决定」（严重）、1 条无关；U1 部分覆盖、漏 U2；
  // 2 个行动项：1 个对上 U3 但负责人是编的，1 个把建议当任务
  GR: {
    claims: [
      claim('a', 'supported'),
      claim('b', 'supported'),
      claim('c', 'contradicted', 'decision_status', true, 'fabricated_decision_or_commitment'),
      claim('d', 'irrelevant', 'irrelevant'),
    ],
    coverage: [
      { unit_id: 'U1', status: 'partial', claim_index: 0 },
      { unit_id: 'U2', status: 'missing', claim_index: -1 },
      { unit_id: 'U3', status: 'covered', claim_index: 1 },
      { unit_id: 'U4', status: 'covered', claim_index: 1 },
    ],
    action_items: [
      { text: 'Bob sends the contract', owner: 'Bob', due: '', deliverable: 'contract', status: 'committed', verdict: 'valid', invalid_reason: 'none', matched_unit_id: 'U3', ...attrs({ owner_check: 'invented', due_check: 'missing' }) },
      { text: 'Maybe revisit pricing', owner: '', due: '', deliverable: '', status: 'tentative', verdict: 'invalid', invalid_reason: 'suggestion_as_task', matched_unit_id: '', ...attrs({ owner_check: 'not_applicable', due_check: 'not_applicable', deliverable_check: 'not_applicable', status_check: 'not_applicable' }) },
    ],
  },
};
const calls = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const p = JSON.parse(body);
    const name = p.response_format.json_schema.name;
    calls.push({ name, model: p.model, user: p.messages[1].content });
    let content;
    if (name === 'meeting_reference') content = REFERENCE;
    else if (name === 'error_scores') {
      const ids = [...p.messages[1].content.matchAll(/id (\d+):/g)].map((m) => Number(m[1]));
      content = { scores: ids.map((id) => ({ id, score: 3, reason: 'surface only' })) };
    } else if (name === 'summary_eval') content = SUMMARY_VERDICTS[p.messages[1].content.includes('GRANOLA-SUMMARY') ? 'GR' : 'MN'];
    else if (name === 'report_summary') content = { markdown: 'My Notes leads on precision.' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 10 } }));
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
process.env.OPENROUTER_API_KEY = 'sk-test-0123456789abcdefghij';

const rooms = await import('../server/rooms.js');
const { evaluateProduct } = await import('../server/evaluate.js');
const { scoreSummary } = await import('../server/summaryEval.js');
const { describe } = await import('../server/report.js');
const { createApiRouter } = await import('../server/api.js');

const SCRIPT = [
  { speaker: 'Alice', content: 'We will ship Quicksilver to Acme on Friday.' },
  { speaker: 'Bob', content: 'The budget may be cut next quarter.' },
  { speaker: 'Alice', content: 'I will send the contract by Friday.' },
  { speaker: 'Bob', content: 'Acme has 40 seats today.' },
];
const makeRoom = () => {
  const r = rooms.createRoom({ title: 'eval room' });
  rooms.setTranscript(r.id, { speakers: ['Alice', 'Bob'], lines: SCRIPT });
  return r;
};

// ---------------------------------------------------------------- 1
console.log('\n1) 房间参考：实体词 + 信息单元，每个房间只抽一次');
const room = makeRoom();
rooms.putComparison(room.id, 'my-notes', {
  transcript: 'Speaker 1: We will ship Quicksilver to Acme on Friday.\nSpeaker 2: The budget may be cut next quarter.\nSpeaker 1: I will send the contract by Friday.\nSpeaker 2: Acme has 40 seats today.',
  summary: 'MY-NOTES-SUMMARY: ship Friday; budget risk; Alice sends contract.',
});
rooms.putComparison(room.id, 'granola', {
  transcript: 'Speaker 1: We will ship Quick Silver to Acne on Friday.\nSpeaker 2: The budget may be cut next quarter.\nSpeaker 1: I will send the contract by Friday.\nSpeaker 2: Acme has 40 seats today.',
  summary: 'GRANOLA-SUMMARY: decided to cut budget.',
});
rooms.putComparison(room.id, 'otter', {
  transcript: 'Speaker 1: We will ship Quicksilver to Acme on Friday.\nSpeaker 1: The budget may be cut next quarter.\nSpeaker 1: I will send the contract by Friday.\nSpeaker 1: Acme has 40 seats today.',
});

await Promise.all(['my-notes', 'granola', 'otter'].map((p) => evaluateProduct(room.id, p)));
t('★ 三个产品并发评估，参考只抽了一次', calls.filter((c) => c.name === 'meeting_reference').length === 1,
  String(calls.filter((c) => c.name === 'meeting_reference').length));
t('所有调用都用同一个判定模型', new Set(calls.map((c) => c.model)).size === 1 && calls[0].model === 'anthropic/claude-opus-5');
const ref = (await import('../server/reference.js')).getCachedReference(room.id);
t('参考的单元编了号、行动项带属性', ref.units.map((u) => u.id).join() === 'U1,U2,U3,U4' && ref.units[2].owner === 'Alice');

const comps = () => new Map(rooms.getComparisons(room.id).map((c) => [c.product, c]));

// ---------------------------------------------------------------- 2
console.log('\n2) Transcript：EWER / UER / WDER / 语言 / WER');
{
  const mn = comps().get('my-notes').result.headline;
  const gr = comps().get('granola').result;
  const ot = comps().get('otter').result.headline;
  t('My Notes 全对：EWER 0 / UER 0 / WDER 0 / 语言 100 / WER 0', mn.ewer === 0 && mn.uer === 0 && mn.wder === 0 && mn.language === 100 && mn.wer === 0,
    JSON.stringify(mn));
  t('★ Granola：Acme→Acne 算实体错误，Quick Silver 算写法差异不算错', gr.headline.ewer > 0 &&
    gr.metrics.ewer.errors.some((e) => e.term === 'Acme') && !gr.metrics.ewer.errors.some((e) => e.term === 'Quicksilver'),
    JSON.stringify(gr.metrics.ewer));
  t('EWER 的实体表来自参考（不是自动识别）', gr.metrics.ewer.source === 'reference');
  t('★ Otter 把两个人合成一个标签 → WDER > 0', ot.wder > 0, String(ot.wder));
}

// ---------------------------------------------------------------- 3
console.log('\n3) Summary：Precision / 加权 Recall / F1 / Critical / Action items');
{
  const mn = comps().get('my-notes').summaryResult;
  const gr = comps().get('granola').summaryResult;
  const otter = comps().get('otter');
  t('My Notes precision 100（4/4）', mn.headline.precision === 100);
  t('★ My Notes 加权 recall = (3+2+3)/9 = 88.9（漏的是次要单元）', mn.headline.recall === 88.9, String(mn.headline.recall));
  t('My Notes F1 = 94.1', mn.headline.f1 === 94.1, String(mn.headline.f1));
  t('My Notes 没有严重错误', mn.headline.critical === false);
  t('My Notes action items P/R 100/100，属性全对', mn.headline.actionPrecision === 100 && mn.headline.actionRecall === 100 &&
    mn.actionItems.allAttributesCorrect === 100);

  t('★ Granola precision = (1+1+0+0)/4 = 50', gr.headline.precision === 50, String(gr.headline.precision));
  t('★ Granola 加权 recall = (1.5+0+3+1)/9 = 61.1', gr.headline.recall === 61.1, String(gr.headline.recall));
  t('Granola 有严重错误（编造决定）', gr.headline.critical === true && gr.critical.types.fabricated_decision_or_commitment === 1);
  t('错误类型分布：decision_status 1、irrelevant 1', gr.errorTypes.decision_status === 1 && gr.errorTypes.irrelevant === 1);
  t('决定正确率诊断项 75%', gr.diagnostics.decisionCorrectness === 75, String(gr.diagnostics.decisionCorrectness));
  t('Granola action precision 50（建议当成了任务）', gr.headline.actionPrecision === 50);
  t('Granola action recall 100（U3 对上了）', gr.headline.actionRecall === 100);
  t('★ 编造负责人 → unsupported attribute rate 100、负责人准确率 0', gr.actionItems.unsupportedAttributeRate === 100 &&
    gr.actionItems.attributeAccuracy.owner === 0, JSON.stringify(gr.actionItems.attributeAccuracy));
  t('Otter 没贴摘要 → 不评摘要', otter.summaryState === 'idle' && otter.summaryResult === null);
  t('Template alignment 标为未评估', mn.templateAlignment.evaluated === false);

  const lostKey = scoreSummary(
    { claims: [claim('x', 'supported')], coverage: [{ unit_id: 'U1', status: 'missing', claim_index: -1 }], action_items: [] },
    { units: [{ id: 'U1', type: 'decision', importance: 3, text: 'd' }] }
  );
  t('★ 漏掉关键决定本身就算严重错误', lostKey.headline.critical === true && lostKey.critical.omissions[0] === 'U1');

  rooms.putComparison(room.id, 'granola', { summary: 'GRANOLA-SUMMARY: edited.' });
  t('改了摘要 → 摘要分数作废，转录分数保留', comps().get('granola').summaryResult === null && comps().get('granola').result !== null);
  await evaluateProduct(room.id, 'granola', { parts: ['summary'] });
}

// ---------------------------------------------------------------- 4
console.log('\n4) 综合报告');
const room2 = makeRoom();
for (const p of ['my-notes', 'granola', 'otter']) {
  rooms.putComparison(room2.id, p, {
    transcript: comps().get(p).transcript,
    summary: p === 'granola' ? 'GRANOLA-SUMMARY: second' : 'OTHER-SUMMARY: second',
  });
}
const noScore = makeRoom(); // 没有任何评估的房间

const app = express();
app.use('/api', createApiRouter({ broadcast: () => {} }));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const json = async (p, init) => (await fetch(base + p, init)).json();

const tooMany = await fetch(`${base}/api/reports`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ roomIds: Array.from({ length: 1001 }, (_, i) => `R${i}`) }),
});
t('超过 1000 个房间被拒', tooMany.status === 400);

const created = await json('/api/reports', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ roomIds: [room.id, room2.id, noScore.id], title: 'Weekly', scoreMissing: true }),
});
t('报告创建成功', typeof created.id === 'string' && created.rooms === 3, JSON.stringify(created));

let report;
for (let i = 0; i < 100; i++) {
  report = (await json(`/api/reports/${created.id}`)).report;
  if (report.state !== 'running') break;
  await new Promise((r) => setTimeout(r, 100));
}
t('报告跑完了', report.state === 'done', `${report.state} ${report.error}`);
const d = report.data;
t('★ 勾了「先补跑」：第二个房间的三家都评了', comps().size && rooms.getComparisons(room2.id).every((c) => c.result?.version === 2));
t('My Notes precision 两个房间都是 100 → 均值 100，n=2', d.overall.precision['my-notes'].mean === 100 && d.overall.precision['my-notes'].n === 2,
  JSON.stringify(d.overall.precision['my-notes']));
t('Granola critical rate 100%', d.overall.criticalRate.granola.mean === 100);
t('★ 配对比较：Otter 第二个房间才有摘要 → 摘要指标只有 1 个配对房间', d.paired.precision.rooms === 1,
  String(d.paired.precision.rooms));
t('配对差值：Granola − My Notes precision = −50', d.paired.precision.vsBaseline.granola.meanDiff === -50,
  JSON.stringify(d.paired.precision.vsBaseline.granola));
t('胜负平按「越高越好」算：My Notes 胜', d.paired.precision.vsBaseline.granola.baselineBetter === 1);
t('转录指标三家都有 → 配对 2 个房间', d.paired.ewer.rooms === 2, String(d.paired.ewer.rooms));
t('★ 没有评估的房间列在 missing 里', d.missing['my-notes'].transcript.includes(noScore.id));
t('按语言 / 人数 / 顺序 / 环境 / 口音分组', d.groups.map((g) => g.key).join() === 'language,speakersBucket,order,noise,accent');
t('实体错误汇总：Granola 的 Acme', d.errors.granola.topEntityErrors.some((e) => e.term === 'Acme'));
t('AI 总结只拿到代码算好的数字', report.aiSummary === 'My Notes leads on precision.' &&
  calls.filter((c) => c.name === 'report_summary').every((c) => !c.user.includes('Acme has 40 seats')));

const md = await (await fetch(`${base}/api/reports/${created.id}/download?format=md`)).text();
t('下载 Markdown', md.startsWith('# Weekly') && md.includes('## Paired comparison') && md.includes('## Per room'));
const csvRes = await fetch(`${base}/api/reports/${created.id}/download?format=csv`);
const csv = await csvRes.text();
t('下载 CSV：每个房间 × 每个产品一行', csv.split('\n').length === 1 + 3 * 3 && csvRes.headers.get('content-disposition').includes('.csv'));

const list = await json('/api/reports');
t('Reports 列表里有它', list.reports.some((r) => r.id === created.id) && list.maxRooms === 1000);

const ci = describe([10, 20, 30]);
t('统计：均值 20、中位数 20、95% CI', ci.mean === 20 && ci.median === 20 && ci.ci[0] === 8.7 && ci.ci[1] === 31.3, JSON.stringify(ci));

server.close();
fake.close();
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(`\n${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
