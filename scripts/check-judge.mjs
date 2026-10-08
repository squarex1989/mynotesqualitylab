#!/usr/bin/env node
// 真实调用 OpenRouter，验证判定模型（EVAL_MODEL）走通整条评估链路。花真钱，手动跑。
//
// 跑法（本地）：    node --env-file-if-exists=.env scripts/check-judge.mjs
// 跑法（Railway）： node scripts/check-judge.mjs
//
// 候选转录和摘要里**故意埋了已知错误**，检查：
//   1. 契约：strict JSON Schema（含数组、枚举）模型真的照着返回，没有 400、没有降级
//   2. 参考：从脚本里抽出了实体词和信息单元，行动项带负责人 / 截止时间
//   3. Transcript：Acme→Acne、Marcus→Marquis 计入 EWER；否定词被吃掉那句 UER 判「意思变了」
//   4. Summary：把「可能」写成「决定了」被判 contradicted 并标为严重；编造的截止时间被抓到

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'live-judge-'));

const { apiKeyProblem, EVAL_MODEL } = await import('../server/llm.js');
const rooms = await import('../server/rooms.js');
const { evaluateProduct } = await import('../server/evaluate.js');
const { getCachedReference } = await import('../server/reference.js');

const problem = apiKeyProblem();
if (problem) {
  console.error(problem);
  process.exit(1);
}

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

const SCRIPT = [
  ['Priya', 'Acme wants the pilot live before April 4.'],
  ['Daniel', "Honestly, I don't think we can hit that date with the current team."],
  ['Priya', 'Then we may consider pushing the launch to May, but nothing is decided yet.'],
  ['Daniel', 'Marcus will send Acme the revised timeline by Friday.'],
  ['Priya', 'The main risk is that Quicksilver still fails the security review.'],
];
const TRANSCRIPT = `Speaker 1: Acne wants the pilot live before April 4.
Speaker 2: Honestly, I think we can hit that date with the current team.
Speaker 1: Then we may consider pushing the launch to May, but nothing is decided yet.
Speaker 2: Marquis will send Acme the revised timeline by Friday.
Speaker 1: The main risk is that Quicksilver still fails the security review.`;
const SUMMARY = `Decisions
- The team decided to push the launch to May.
Risks
- Quicksilver may fail the security review.
Action items
- Marcus sends Acme the revised timeline by Monday.`;

console.log(`\n判定模型: ${EVAL_MODEL()}\n`);
const { id } = rooms.createRoom({ title: 'live judge check' });
rooms.setTranscript(id, {
  speakers: ['Priya', 'Daniel'],
  lines: SCRIPT.map(([speaker, content]) => ({ speaker, content })),
});
rooms.putComparison(id, 'my-notes', { transcript: TRANSCRIPT, summary: SUMMARY });

const started = Date.now();
await evaluateProduct(id, 'my-notes');
console.log(`用时 ${Math.round((Date.now() - started) / 1000)}s\n`);

const ref = getCachedReference(id);
const c = rooms.getComparisons(id)[0];
t('参考抽出来了', ref && ref.entities.length > 0 && ref.units.length > 0, JSON.stringify(ref?.entities));
t('实体里有 Acme / Marcus / Quicksilver', ['acme', 'marcus', 'quicksilver'].every((e) => ref.entities.some((x) => x.text.toLowerCase() === e)),
  ref.entities.map((e) => e.text).join(', '));
const action = ref.units.find((u) => u.type === 'action_item');
t('行动项带负责人和截止时间', action && /marcus/i.test(action.owner) && /friday/i.test(action.due), JSON.stringify(action));
t('「may consider」没被当成决定', !ref.units.some((u) => u.type === 'decision' && /may/i.test(u.text) && /decid/i.test(u.text)));

t('Transcript 评估完成', c.state === 'done', c.error);
const h = c.result?.headline ?? {};
console.log('  transcript headline:', JSON.stringify(h));
t('★ Acme→Acne、Marcus→Marquis 计入 EWER', h.ewer > 0 && c.result.metrics.ewer.errors.some((e) => /acme|marcus/i.test(e.term)));
t('★ 否定词被吃掉那句算「意思变了」→ UER > 0', h.uer > 0, JSON.stringify(c.result?.uer?.errors));

t('Summary 评估完成', c.summaryState === 'done', c.summaryError);
const s = c.summaryResult;
console.log('  summary headline:', JSON.stringify(s?.headline));
const decided = s?.claims.find((x) => /decided/i.test(x.claim));
t('★ 「决定推迟到五月」被判 contradicted / unsupported', decided && ['contradicted', 'unsupported'].includes(decided.verdict), JSON.stringify(decided));
t('★ 并标为严重错误', s?.headline.critical === true, JSON.stringify(s?.critical));
const item = s?.actionItems.items[0];
t('★ 截止时间 Monday 被判 wrong（脚本是 Friday）', item && item.checks.due === 'wrong', JSON.stringify(item));

fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(`\n${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
