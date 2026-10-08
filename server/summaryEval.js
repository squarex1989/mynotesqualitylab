// Summary + Action items 评估。
//
// 摘要没有唯一的标准答案，所以不比文本重合度，而是比「原子信息单元」：
//   Precision —— 摘要里的每条原子陈述，有没有原文支撑、意思对不对、该不该出现
//   Recall    —— 脚本里应有的信息单元（server/reference.js 抽的，带重要度），摘要覆盖了多少
//   F1、Critical Error（护栏，不并进 F1）、错误类型分布、名字 / 数字 / 决定状态等诊断项
// Action items 单独评：Precision / Recall / F1，以及负责人、截止时间、交付物、承诺状态
// 各字段的准确率和「编造属性」的比例。
//
// 一次模型调用拿回逐条的结构化结论（verdict + 原文证据 + 错误类型），分数全部由代码算。
// Template Alignment 暂不评估（三家模板不同，没有统一的预期结构）。

import { callJson } from './llm.js';
import { detectLanguage } from './lang.js';

export const VERDICTS = ['supported', 'partially_supported', 'unsupported', 'contradicted', 'irrelevant'];
export const VERDICT_SCORE = {
  supported: 1,
  partially_supported: 0.5,
  unsupported: 0,
  contradicted: 0,
  irrelevant: 0,
};
export const ERROR_TYPES = [
  'none',
  'hallucination',
  'meaning_reversed',
  'decision_status',
  'modality',
  'name',
  'number_date',
  'attribution',
  'terminology',
  'irrelevant',
  'other',
];
export const CRITICAL_TYPES = [
  'none',
  'fabricated_decision_or_commitment',
  'meaning_reversed',
  'wrong_name_or_attribution',
  'wrong_number_date_or_deadline',
  'rejected_presented_as_approved',
  'sensitive_content',
  'other',
];
const COVERAGE = ['covered', 'partial', 'missing'];
const COVERAGE_SCORE = { covered: 1, partial: 0.5, missing: 0 };
const INVALID_REASONS = [
  'none',
  'suggestion_as_task',
  'discussion_as_task',
  'not_in_meeting',
  'cancelled_or_rejected_as_active',
  'other',
];
const ATTR_CHECK = ['correct', 'wrong', 'invented', 'missing', 'not_applicable'];
export const ACTION_FIELDS = ['owner', 'due', 'deliverable', 'status'];

// 脚本里漏掉这些类型的关键单元，本身就算严重错误（「漏掉业务关键的决定或警告」）
const CRITICAL_OMISSION_TYPES = ['decision', 'action_item', 'risk'];

const SYSTEM = `You evaluate a meeting summary written by a meeting-notes product, against the exact script of the meeting (the ground truth) and a list of reference information units extracted from that script.

Return three lists. Do NOT give any overall score — only per-item verdicts with evidence.

1. claims — decompose the summary into atomic claims (one fact / decision / point each; split compound sentences; skip headings and pure formatting). For each claim:
   - section: the summary heading it appears under ("" if none).
   - verdict: supported | partially_supported | unsupported | contradicted | irrelevant
     * supported: the script supports it with the same meaning.
     * partially_supported: mostly right but something is missing, imprecise or slightly off.
     * unsupported: not in the script (hallucinated or inferred beyond what was said).
     * contradicted: the script says something different (wrong name/number/date, reversed meaning, changed decision status or modality — e.g. "may consider" written as "decided").
     * irrelevant: true but not worth being in a summary (small talk, trivia).
   - evidence: the script line numbers and a short quote that support or contradict it.
   - error_type: none | hallucination | meaning_reversed | decision_status | modality | name | number_date | attribution | terminology | irrelevant | other.
   - critical + critical_type: true only for errors that would seriously damage user trust — fabricated decisions or commitments, reversing an important statement, wrong person name or speaker attribution, wrong number/date/amount/deadline, a rejected proposal presented as approved, exposing sensitive content.

2. coverage — for EVERY reference unit id you are given: covered | partial | missing in the summary, and the index (0-based) of the claim that covers it (-1 if missing). A unit is covered if the summary conveys the same information, in any wording.

3. action_items — every action item / next step / to-do the summary presents (in an action-item section or phrased as a task). For each:
   - text, owner, due, deliverable, status as written in the summary ("" if absent; status: committed | tentative | blocked | completed | cancelled | none).
   - verdict: valid if it is a genuine commitment from the meeting, otherwise invalid with invalid_reason: suggestion_as_task | discussion_as_task | not_in_meeting | cancelled_or_rejected_as_active | other.
   - matched_unit_id: the reference action_item unit it corresponds to ("" if none).
   - owner_check / due_check / deliverable_check / status_check, each:
     correct (matches the script) | wrong (contradicts the script) | invented (given in the summary but not stated in the script — inferred) | missing (the script states it but the summary omits it) | not_applicable (neither has it).`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['claims', 'coverage', 'action_items'],
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'section', 'verdict', 'evidence_lines', 'evidence', 'error_type', 'critical', 'critical_type'],
        properties: {
          claim: { type: 'string' },
          section: { type: 'string' },
          verdict: { type: 'string', enum: VERDICTS },
          evidence_lines: { type: 'array', items: { type: 'integer' } },
          evidence: { type: 'string' },
          error_type: { type: 'string', enum: ERROR_TYPES },
          critical: { type: 'boolean' },
          critical_type: { type: 'string', enum: CRITICAL_TYPES },
        },
      },
    },
    coverage: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['unit_id', 'status', 'claim_index'],
        properties: {
          unit_id: { type: 'string' },
          status: { type: 'string', enum: COVERAGE },
          claim_index: { type: 'integer' },
        },
      },
    },
    action_items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'text',
          'owner',
          'due',
          'deliverable',
          'status',
          'verdict',
          'invalid_reason',
          'matched_unit_id',
          'owner_check',
          'due_check',
          'deliverable_check',
          'status_check',
        ],
        properties: {
          text: { type: 'string' },
          owner: { type: 'string' },
          due: { type: 'string' },
          deliverable: { type: 'string' },
          status: { type: 'string' },
          verdict: { type: 'string', enum: ['valid', 'invalid'] },
          invalid_reason: { type: 'string', enum: INVALID_REASONS },
          matched_unit_id: { type: 'string' },
          owner_check: { type: 'string', enum: ATTR_CHECK },
          due_check: { type: 'string', enum: ATTR_CHECK },
          deliverable_check: { type: 'string', enum: ATTR_CHECK },
          status_check: { type: 'string', enum: ATTR_CHECK },
        },
      },
    },
  },
};

function userPrompt({ script, units, summary }) {
  const unitLines = units
    .map(
      (u) =>
        `${u.id} [${u.type}, importance ${u.importance}] ${u.text}` +
        (u.type === 'action_item'
          ? ` (owner: ${u.owner || '-'}; due: ${u.due || '-'}; deliverable: ${u.deliverable || '-'}; status: ${u.status})`
          : '')
    )
    .join('\n');
  return `SCRIPT (ground truth, numbered lines):
${script.slice(0, 150000)}

REFERENCE UNITS (what a good summary should cover):
${unitLines || '(none)'}

SUMMARY TO EVALUATE:
${summary.slice(0, 60000)}`;
}

const r1 = (x) => (x === null || x === undefined ? null : Math.round(x * 1000) / 10); // 0..1 → 百分比，一位小数
const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);

/**
 * 把模型的逐条结论变成分数。纯函数，测试直接喂假的结论。
 *
 * @param {{claims, coverage, action_items}} verdicts 模型输出
 * @param {{units: object[]}} reference
 * @param {{summary: string, language: string|null}} ctx
 */
export function scoreSummary(verdicts, reference, { summary = '', language = null } = {}) {
  const units = reference?.units ?? [];

  // ---------------- Precision ----------------
  const claims = (Array.isArray(verdicts?.claims) ? verdicts.claims : []).slice(0, 200).map((c, i) => ({
    index: i,
    claim: String(c?.claim || '').trim(),
    section: String(c?.section || '').trim(),
    verdict: pick(c?.verdict, VERDICTS, 'unsupported'),
    evidenceLines: (Array.isArray(c?.evidence_lines) ? c.evidence_lines : []).map(Number).filter(Number.isFinite),
    evidence: String(c?.evidence || '').trim(),
    errorType: pick(c?.error_type, ERROR_TYPES, 'other'),
    critical: Boolean(c?.critical),
    criticalType: pick(c?.critical_type, CRITICAL_TYPES, 'other'),
  })).filter((c) => c.claim);
  for (const c of claims) {
    if (c.verdict === 'supported') c.errorType = 'none';
    else if (c.errorType === 'none') c.errorType = c.verdict === 'irrelevant' ? 'irrelevant' : 'other';
    if (!c.critical) c.criticalType = 'none';
  }
  const precision = claims.length
    ? claims.reduce((s, c) => s + VERDICT_SCORE[c.verdict], 0) / claims.length
    : null;

  // ---------------- Recall（按重要度加权） ----------------
  const cov = new Map();
  for (const x of Array.isArray(verdicts?.coverage) ? verdicts.coverage : []) {
    if (x?.unit_id) cov.set(String(x.unit_id), pick(x.status, COVERAGE, 'missing'));
  }
  const unitResults = units.map((u) => ({ ...u, coverage: cov.get(u.id) ?? 'missing' }));
  const weighted = (list) => {
    const den = list.reduce((s, u) => s + u.importance, 0);
    return den ? list.reduce((s, u) => s + u.importance * COVERAGE_SCORE[u.coverage], 0) / den : null;
  };
  const recall = weighted(unitResults);
  const byType = {};
  for (const u of unitResults) (byType[u.type] ||= []).push(u);
  const recallByType = Object.fromEntries(
    Object.entries(byType).map(([t, list]) => [t, { recall: r1(weighted(list)), units: list.length }])
  );
  const f1 = precision !== null && recall !== null && precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : null;

  // ---------------- Critical Error ----------------
  const criticalClaims = claims.filter((c) => c.critical && c.verdict !== 'supported');
  const criticalOmissions = unitResults.filter(
    (u) => u.importance === 3 && CRITICAL_OMISSION_TYPES.includes(u.type) && u.coverage === 'missing'
  );
  const criticalTypes = {};
  for (const c of criticalClaims) criticalTypes[c.criticalType] = (criticalTypes[c.criticalType] || 0) + 1;
  if (criticalOmissions.length) criticalTypes.omitted_critical_unit = criticalOmissions.length;

  // ---------------- 错误类型分布 / 诊断项 ----------------
  const errorTypes = {};
  for (const c of claims) if (c.errorType !== 'none') errorTypes[c.errorType] = (errorTypes[c.errorType] || 0) + 1;
  const rateOf = (type) => (claims.length ? r1(1 - (errorTypes[type] || 0) / claims.length) : null);
  const summaryLanguage = summary.trim() ? detectLanguage(summary) : null;

  // ---------------- Action items ----------------
  const items = (Array.isArray(verdicts?.action_items) ? verdicts.action_items : []).slice(0, 100).map((a) => ({
    text: String(a?.text || '').trim(),
    owner: String(a?.owner || '').trim(),
    due: String(a?.due || '').trim(),
    deliverable: String(a?.deliverable || '').trim(),
    status: String(a?.status || '').trim(),
    valid: a?.verdict === 'valid',
    invalidReason: a?.verdict === 'valid' ? 'none' : pick(a?.invalid_reason, INVALID_REASONS, 'other'),
    matchedUnit: String(a?.matched_unit_id || ''),
    checks: Object.fromEntries(ACTION_FIELDS.map((f) => [f, pick(a?.[`${f}_check`], ATTR_CHECK, 'not_applicable')])),
  })).filter((a) => a.text);
  const refActions = units.filter((u) => u.type === 'action_item');
  const valid = items.filter((a) => a.valid);
  const matched = new Set(valid.map((a) => a.matchedUnit).filter((id) => refActions.some((u) => u.id === id)));
  const actionPrecision = items.length ? valid.length / items.length : null;
  const actionDen = refActions.reduce((s, u) => s + u.importance, 0);
  const actionRecall = actionDen
    ? refActions.filter((u) => matched.has(u.id)).reduce((s, u) => s + u.importance, 0) / actionDen
    : null;
  const actionF1 = actionPrecision !== null && actionRecall !== null && actionPrecision + actionRecall > 0
    ? (2 * actionPrecision * actionRecall) / (actionPrecision + actionRecall)
    : null;
  const attributeAccuracy = Object.fromEntries(
    ACTION_FIELDS.map((f) => {
      const judged = valid.filter((a) => a.checks[f] !== 'not_applicable');
      return [f, judged.length ? r1(judged.filter((a) => a.checks[f] === 'correct').length / judged.length) : null];
    })
  );
  const bad = (a) => ACTION_FIELDS.some((f) => ['wrong', 'invented', 'missing'].includes(a.checks[f]));
  const invented = (a) => a.checks.owner === 'invented' || a.checks.due === 'invented';
  const actionCritical = valid.filter((a) => a.checks.owner === 'wrong' || invented(a)).length +
    items.filter((a) => a.invalidReason === 'cancelled_or_rejected_as_active').length;

  return {
    version: 2,
    headline: {
      precision: r1(precision),
      recall: r1(recall),
      f1: r1(f1),
      critical: criticalClaims.length + criticalOmissions.length > 0,
      criticalCount: criticalClaims.length + criticalOmissions.length,
      languageOk: language && summaryLanguage ? summaryLanguage === language : null,
      actionPrecision: r1(actionPrecision),
      actionRecall: r1(actionRecall),
      actionF1: r1(actionF1),
    },
    precision: {
      claims: claims.length,
      byVerdict: Object.fromEntries(VERDICTS.map((v) => [v, claims.filter((c) => c.verdict === v).length])),
    },
    recall: { units: units.length, byType: recallByType },
    critical: {
      claims: criticalClaims.map((c) => c.index),
      omissions: criticalOmissions.map((u) => u.id),
      types: criticalTypes,
    },
    errorTypes,
    diagnostics: {
      nameCorrectness: rateOf('name'),
      numberDateCorrectness: rateOf('number_date'),
      decisionCorrectness: rateOf('decision_status'),
      attributionCorrectness: rateOf('attribution'),
      terminologyCorrectness: rateOf('terminology'),
      language: { expected: language, got: summaryLanguage },
    },
    actionItems: {
      extracted: items.length,
      valid: valid.length,
      referenceActions: refActions.length,
      matched: matched.size,
      attributeAccuracy,
      allAttributesCorrect: valid.length ? r1(valid.filter((a) => !bad(a)).length / valid.length) : null,
      unsupportedAttributeRate: valid.length ? r1(valid.filter(invented).length / valid.length) : null,
      criticalCount: actionCritical,
      items,
      missed: refActions.filter((u) => !matched.has(u.id)).map((u) => u.id),
    },
    claims,
    units: unitResults.map(({ id, type, importance, text, coverage }) => ({ id, type, importance, text, coverage })),
    templateAlignment: { evaluated: false },
  };
}

/** 跑一次评估：模型给逐条结论，代码算分 */
export async function gradeSummary({ script, reference, summary, language }) {
  const { data, model, usage } = await callJson({
    name: 'summary_eval',
    system: SYSTEM,
    user: userPrompt({ script, units: reference.units, summary }),
    schema: SCHEMA,
  });
  return { ...scoreSummary(data, reference, { summary, language }), model, tokensUsed: usage };
}
