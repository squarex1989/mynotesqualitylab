// 综合报告：把多个房间（最多 1000 个）的评估结果汇总成一份。
//
// 汇总全部由代码算：每个产品每个指标的均值 / 中位数 / 95% 置信区间；三家都有结果的
// 「配对」房间上，其它产品相对 My Notes 的差值和置信区间（区间不跨 0 才算稳定的差异）、
// 胜负平；按语言、人数、有序/无序、安静/嘈杂、口音分组；错误类型和严重错误的分布；
// 表现最差的房间；缺了哪些评估。最后让模型读这些数字写一段总结 —— 它只总结，不重新打分。
//
// 生成是异步的：先（可选）补跑缺失的评估，再汇总，再写总结。进度存在 reports.progress。

import crypto from 'node:crypto';
import { db } from './db.js';
import { getRoom, getComparisons, getSpeakers, roomLanguage } from './rooms.js';
import { PRODUCTS } from './judge.js';
import { voices } from './voices.js';
import { evaluateProduct } from './evaluate.js';
import { callJson, apiKeyProblem } from './llm.js';

export const MAX_REPORT_ROOMS = 1000;
const SCORE_CONCURRENCY = Number(process.env.REPORT_SCORE_CONCURRENCY) || 4;
const BASELINE = 'my-notes';
const MIN_STABLE_N = 3;

/** 报告里的指标。better 决定「谁赢」和颜色；kind=rate 是百分比，bool 汇总成占比 */
export const METRICS = [
  { key: 'ewer', label: 'EWER', part: 'transcript', better: 'lower' },
  { key: 'uer', label: 'UER', part: 'transcript', better: 'lower' },
  { key: 'wder', label: 'WDER', part: 'transcript', better: 'lower' },
  { key: 'language', label: 'Language correctness', part: 'transcript', better: 'higher' },
  { key: 'wer', label: 'WER', part: 'transcript', better: 'lower' },
  { key: 'precision', label: 'Summary precision', part: 'summary', better: 'higher' },
  { key: 'recall', label: 'Summary recall (weighted)', part: 'summary', better: 'higher' },
  { key: 'f1', label: 'Summary F1', part: 'summary', better: 'higher' },
  { key: 'criticalRate', label: 'Critical error rate', part: 'summary', better: 'lower' },
  { key: 'actionPrecision', label: 'Action item precision', part: 'summary', better: 'higher' },
  { key: 'actionRecall', label: 'Action item recall', part: 'summary', better: 'higher' },
  { key: 'actionF1', label: 'Action item F1', part: 'summary', better: 'higher' },
  { key: 'actionAllAttrs', label: 'Action items with all attributes correct', part: 'summary', better: 'higher' },
  { key: 'unsupportedAttr', label: 'Invented owner / deadline rate', part: 'summary', better: 'lower' },
];

/* ------------------------------------------------------------------ */
/* 单个房间的数据                                                        */
/* ------------------------------------------------------------------ */

const ACCENT_OF = () => new Map(voices().map((v) => [v.id, v.accents]));

/** 一个房间的分组属性 */
function roomFacts(roomId, accentOf) {
  const room = getRoom(roomId);
  const speakers = getSpeakers(roomId);
  const accents = [...new Set(speakers.flatMap((s) => accentOf.get(s.voice) ?? []))];
  const n = speakers.length;
  return {
    id: room.id,
    title: room.title,
    language: roomLanguage(roomId) || 'unknown',
    speakers: n,
    speakersBucket: n >= 5 ? '5+' : String(n),
    order: room.order_mode,
    noise: room.noise_mode === 'noisy' ? room.ambience_kind : 'quiet',
    accent: accents.length ? 'with accent' : 'no accent',
    accents,
  };
}

/** 一个产品在一个房间的指标值（没有就是 null）。只认新版（version 2）的结果 */
function productValues(c) {
  const t = c?.result?.version === 2 ? c.result.headline : null;
  const s = c?.summaryResult?.version === 2 ? c.summaryResult : null;
  const h = s?.headline;
  return {
    ewer: t?.ewer ?? null,
    uer: t?.uer ?? null,
    wder: t?.wder ?? null,
    language: t?.language ?? null,
    wer: t?.wer ?? null,
    precision: h?.precision ?? null,
    recall: h?.recall ?? null,
    f1: h?.f1 ?? null,
    criticalRate: h ? (h.critical ? 100 : 0) : null,
    actionPrecision: h?.actionPrecision ?? null,
    actionRecall: h?.actionRecall ?? null,
    actionF1: h?.actionF1 ?? null,
    actionAllAttrs: s?.actionItems?.allAttributesCorrect ?? null,
    unsupportedAttr: s?.actionItems?.unsupportedAttributeRate ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* 统计                                                                 */
/* ------------------------------------------------------------------ */

const round1 = (x) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);

export function describe(values) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  const n = xs.length;
  if (!n) return { n: 0, mean: null, median: null, sd: null, ci: null };
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const sorted = [...xs].sort((a, b) => a - b);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const sd = n > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : null;
  const half = sd !== null ? (1.96 * sd) / Math.sqrt(n) : null;
  return {
    n,
    mean: round1(mean),
    median: round1(median),
    sd: round1(sd),
    ci: half !== null ? [round1(mean - half), round1(mean + half)] : null,
  };
}

/** 配对比较：每个房间算差值（其它产品 − 基线），看差值的均值和置信区间 */
function pairedDiff(pairs, better) {
  const diffs = pairs.map(([base, other]) => other - base);
  const d = describe(diffs);
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const [base, other] of pairs) {
    const otherBetter = better === 'lower' ? other < base : other > base;
    if (other === base) ties++;
    else if (otherBetter) wins++;
    else losses++;
  }
  // 样本太小时区间不可信（2 个相同的值标准差是 0，区间缩成一个点），至少 3 个配对房间才谈「稳定」
  const stable = d.n >= MIN_STABLE_N && d.ci ? d.ci[0] > 0 || d.ci[1] < 0 : false;
  return { meanDiff: d.mean, ci: d.ci, n: d.n, otherBetter: wins, baselineBetter: losses, ties, stable };
}

/**
 * 代码汇总。纯函数：输入每个房间的属性和各产品的指标值。
 *
 * @param {{facts: object, values: Record<string, object>, summaries: Record<string, object|null>, transcripts: Record<string, object|null>}[]} rows
 */
export function aggregate(rows) {
  const products = PRODUCTS.map((p) => p.id);
  const label = Object.fromEntries(PRODUCTS.map((p) => [p.id, p.label]));

  // ---------------- 每个产品的总体 ----------------
  const overall = {};
  for (const m of METRICS) {
    overall[m.key] = Object.fromEntries(
      products.map((p) => [p, describe(rows.map((r) => r.values[p]?.[m.key]))])
    );
  }

  // ---------------- 配对：三家都有这个指标的房间 ----------------
  const paired = {};
  for (const m of METRICS) {
    const full = rows.filter((r) => products.every((p) => typeof r.values[p]?.[m.key] === 'number'));
    paired[m.key] = {
      rooms: full.length,
      means: Object.fromEntries(products.map((p) => [p, describe(full.map((r) => r.values[p][m.key])).mean])),
      vsBaseline: Object.fromEntries(
        products
          .filter((p) => p !== BASELINE)
          .map((p) => [p, pairedDiff(full.map((r) => [r.values[BASELINE][m.key], r.values[p][m.key]]), m.better)])
      ),
    };
  }

  // ---------------- 分组 ----------------
  const DIMENSIONS = [
    ['language', 'Language'],
    ['speakersBucket', 'Speakers'],
    ['order', 'Reading order'],
    ['noise', 'Ambience'],
    ['accent', 'Accent'],
  ];
  const groups = DIMENSIONS.map(([key, title]) => {
    const values = [...new Set(rows.map((r) => r.facts[key]))].sort();
    return {
      key,
      title,
      buckets: values.map((v) => {
        const inBucket = rows.filter((r) => r.facts[key] === v);
        return {
          value: v,
          rooms: inBucket.length,
          metrics: Object.fromEntries(
            METRICS.map((m) => [
              m.key,
              Object.fromEntries(products.map((p) => [p, describe(inBucket.map((r) => r.values[p]?.[m.key]))])),
            ])
          ),
        };
      }),
    };
  });

  // ---------------- 错误分布 ----------------
  const errors = {};
  for (const p of products) {
    const errorTypes = {};
    const criticalTypes = {};
    const entityErrors = new Map();
    let summaries = 0;
    for (const r of rows) {
      const s = r.summaries[p];
      if (s) {
        summaries++;
        for (const [k, v] of Object.entries(s.errorTypes || {})) errorTypes[k] = (errorTypes[k] || 0) + v;
        for (const [k, v] of Object.entries(s.critical?.types || {})) criticalTypes[k] = (criticalTypes[k] || 0) + v;
      }
      for (const e of r.transcripts[p]?.metrics?.ewer?.errors || []) {
        const key = e.term;
        const rec = entityErrors.get(key) || { term: e.term, wrong: 0, dropped: 0, gotAs: new Map(), rooms: 0 };
        rec.rooms++;
        rec.dropped += e.dropped;
        for (const w of e.wrong) {
          rec.wrong += w.count;
          rec.gotAs.set(w.got, (rec.gotAs.get(w.got) || 0) + w.count);
        }
        entityErrors.set(key, rec);
      }
    }
    errors[p] = {
      summaries,
      errorTypes,
      criticalTypes,
      topEntityErrors: [...entityErrors.values()]
        .sort((a, b) => b.wrong + b.dropped - (a.wrong + a.dropped))
        .slice(0, 20)
        .map((e) => ({
          term: e.term,
          errors: e.wrong + e.dropped,
          dropped: e.dropped,
          rooms: e.rooms,
          gotAs: [...e.gotAs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([got, count]) => ({ got, count })),
        })),
    };
  }

  // ---------------- 最差的房间 / 缺失 ----------------
  const worst = {};
  const missing = {};
  for (const p of products) {
    const by = (key, dir) =>
      rows
        .filter((r) => typeof r.values[p]?.[key] === 'number')
        .sort((a, b) => (dir === 'asc' ? a.values[p][key] - b.values[p][key] : b.values[p][key] - a.values[p][key]))
        .slice(0, 10)
        .map((r) => ({ id: r.facts.id, title: r.facts.title, value: r.values[p][key] }));
    worst[p] = {
      highestEwer: by('ewer', 'desc'),
      highestUer: by('uer', 'desc'),
      lowestF1: by('f1', 'asc'),
      withCritical: rows
        .filter((r) => r.values[p]?.criticalRate === 100)
        .slice(0, 50)
        .map((r) => ({ id: r.facts.id, title: r.facts.title, count: r.summaries[p]?.headline?.criticalCount ?? 1 })),
    };
    missing[p] = {
      transcript: rows.filter((r) => r.values[p]?.ewer === null && r.values[p]?.wer === null).map((r) => r.facts.id),
      summary: rows.filter((r) => r.values[p]?.precision === null).map((r) => r.facts.id),
    };
  }

  return {
    rooms: rows.length,
    products: products.map((id) => ({ id, label: label[id] })),
    baseline: BASELINE,
    metrics: METRICS,
    overall,
    paired,
    groups,
    errors,
    worst,
    missing,
    perRoom: rows.map((r) => ({ ...r.facts, values: r.values })),
  };
}

/** 从数据库收集一组房间的汇总输入 */
export function collectRows(roomIds) {
  const accentOf = ACCENT_OF();
  return roomIds
    .map((id) => getRoom(id))
    .filter(Boolean)
    .map((room) => {
      const comps = new Map(getComparisons(room.id).map((c) => [c.product, c]));
      const values = {};
      const summaries = {};
      const transcripts = {};
      for (const p of PRODUCTS) {
        const c = comps.get(p.id);
        values[p.id] = productValues(c);
        summaries[p.id] = c?.summaryResult?.version === 2 ? c.summaryResult : null;
        transcripts[p.id] = c?.result?.version === 2 ? c.result : null;
      }
      return { facts: roomFacts(room.id, accentOf), values, summaries, transcripts };
    });
}

/* ------------------------------------------------------------------ */
/* AI 总结                                                              */
/* ------------------------------------------------------------------ */

const SUMMARY_SYSTEM = `You write the executive summary of a quality report comparing meeting-notes products (My Notes is our product; Granola and Otter are competitors) on transcripts and summaries.
All numbers were computed by code. Use ONLY the numbers given — never invent or recompute numbers.
Metrics: EWER (entity word error rate), UER (share of lines with a meaning-changing error), WDER (words attributed to the wrong speaker), language correctness; summary precision (valid share of summary claims), weighted recall (share of important meeting information covered), F1, critical error rate (summaries with at least one trust-damaging error — a guardrail, worse is never offset by better F1), action item precision/recall/F1 and attribute accuracy.
"paired" = only rooms where all three products have the metric; vsBaseline = other product minus My Notes, with a 95% CI; "stable" means the CI excludes 0. Treat non-stable differences as inconclusive and say so. Mention sample sizes.
Write concise markdown: a 2-3 sentence verdict, then "Strengths", "Weaknesses", "Where it breaks down" (groups / error types / entities), and "Recommended next steps". Write in English.`;

async function aiSummary(data) {
  const compact = {
    rooms: data.rooms,
    overall: data.overall,
    paired: data.paired,
    groups: data.groups.map((g) => ({
      dimension: g.title,
      buckets: g.buckets.map((b) => ({
        value: b.value,
        rooms: b.rooms,
        means: Object.fromEntries(
          Object.entries(b.metrics).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([p, d]) => [p, d.mean]))])
        ),
      })),
    })),
    errors: data.errors,
    missing: Object.fromEntries(
      Object.entries(data.missing).map(([p, m]) => [p, { transcript: m.transcript.length, summary: m.summary.length }])
    ),
  };
  const { data: out } = await callJson({
    name: 'report_summary',
    system: SUMMARY_SYSTEM,
    user: JSON.stringify(compact).slice(0, 200000),
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['markdown'],
      properties: { markdown: { type: 'string' } },
    },
    temperature: 0.2,
  });
  return String(out.markdown || '').trim();
}

/* ------------------------------------------------------------------ */
/* 报告生命周期                                                          */
/* ------------------------------------------------------------------ */

const setProgress = (id, progress) =>
  db.prepare('UPDATE reports SET progress = ? WHERE id = ?').run(JSON.stringify(progress), id);

/** 能用来出报告的房间：登录用户只能选自己的房间；没登录（本地开发不要求登录）时不限 */
export function allowedRoomIds(roomIds, userId) {
  const ids = [...new Set((Array.isArray(roomIds) ? roomIds : []).map((x) => String(x).toUpperCase()))];
  return ids.filter((id) => {
    const room = getRoom(id);
    return room && room.locked && (!userId || room.owner_id === userId);
  });
}

export function createReport({ ownerId = null, roomIds, title, scoreMissing = false }) {
  if (!roomIds.length) throw new Error('Pick at least one room that has a transcript');
  if (roomIds.length > MAX_REPORT_ROOMS) throw new Error(`At most ${MAX_REPORT_ROOMS} rooms per report`);
  const id = crypto.randomBytes(9).toString('base64url');
  const now = Date.now();
  db.prepare(
    `INSERT INTO reports (id, owner_id, title, room_ids, options, state, progress, created_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`
  ).run(
    id,
    ownerId,
    String(title || '').trim().slice(0, 120) || `Report · ${roomIds.length} rooms`,
    JSON.stringify(roomIds),
    JSON.stringify({ scoreMissing: Boolean(scoreMissing) }),
    JSON.stringify({ phase: 'queued', done: 0, total: 0 }),
    now
  );
  void runReport(id).catch((err) => {
    db.prepare("UPDATE reports SET state = 'failed', error = ?, finished_at = ? WHERE id = ?").run(
      err.message || String(err),
      Date.now(),
      id
    );
  });
  return id;
}

async function runReport(id) {
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  const roomIds = JSON.parse(row.room_ids);
  const options = JSON.parse(row.options || '{}');

  // 1. 可选：先把缺的评估补上（只补有内容、还没有新版结果的）
  if (options.scoreMissing) {
    const jobs = [];
    for (const roomId of roomIds) {
      for (const c of getComparisons(roomId)) {
        const parts = [];
        if (c.transcript?.trim() && c.result?.version !== 2) parts.push('transcript');
        if (c.summary?.trim() && c.summaryResult?.version !== 2) parts.push('summary');
        if (parts.length) jobs.push({ roomId, product: c.product, parts });
      }
    }
    let done = 0;
    setProgress(id, { phase: 'scoring', done, total: jobs.length });
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(SCORE_CONCURRENCY, jobs.length) }, async () => {
        while (next < jobs.length) {
          const job = jobs[next++];
          try {
            await evaluateProduct(job.roomId, job.product, { parts: job.parts });
          } catch {
            /* 单个失败不影响报告，缺的会列在 missing 里 */
          }
          setProgress(id, { phase: 'scoring', done: ++done, total: jobs.length });
        }
      })
    );
  }

  // 2. 代码汇总
  setProgress(id, { phase: 'aggregating', done: 0, total: roomIds.length });
  const data = aggregate(collectRows(roomIds));
  db.prepare('UPDATE reports SET data = ? WHERE id = ?').run(JSON.stringify(data), id);

  // 3. AI 总结（失败不影响报告本身）
  setProgress(id, { phase: 'summarizing', done: 0, total: 1 });
  let summary = null;
  let summaryError = apiKeyProblem();
  if (!summaryError) {
    try {
      summary = await aiSummary(data);
    } catch (err) {
      summaryError = err.message || String(err);
    }
  }
  db.prepare(
    "UPDATE reports SET state = 'done', ai_summary = ?, error = ?, progress = ?, finished_at = ? WHERE id = ?"
  ).run(
    summary,
    summary ? null : `AI summary unavailable: ${summaryError}`,
    JSON.stringify({ phase: 'done', done: 1, total: 1 }),
    Date.now(),
    id
  );
}

const rowToReport = (r, full) => ({
  id: r.id,
  title: r.title,
  roomCount: JSON.parse(r.room_ids).length,
  state: r.state,
  progress: r.progress ? JSON.parse(r.progress) : null,
  error: r.error,
  createdAt: r.created_at,
  finishedAt: r.finished_at,
  ...(full
    ? {
        roomIds: JSON.parse(r.room_ids),
        options: JSON.parse(r.options || '{}'),
        data: r.data ? JSON.parse(r.data) : null,
        aiSummary: r.ai_summary,
      }
    : {}),
});

export function listReports(ownerId) {
  const rows = ownerId
    ? db.prepare('SELECT * FROM reports WHERE owner_id = ? ORDER BY created_at DESC LIMIT 500').all(ownerId)
    : db.prepare('SELECT * FROM reports WHERE owner_id IS NULL ORDER BY created_at DESC LIMIT 500').all();
  return rows.map((r) => rowToReport(r, false));
}

export function getReport(id, ownerId) {
  const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!r || (r.owner_id || null) !== (ownerId || null)) return null;
  return rowToReport(r, true);
}

export function deleteReport(id, ownerId) {
  const r = getReport(id, ownerId);
  if (!r) return false;
  db.prepare('DELETE FROM reports WHERE id = ?').run(id);
  return true;
}

/** 重启时跑到一半的报告不会再继续了 */
export function failInterruptedReports() {
  db.prepare(
    "UPDATE reports SET state = 'failed', error = 'Interrupted by a server restart — generate it again' WHERE state = 'running'"
  ).run();
}

/* ------------------------------------------------------------------ */
/* 下载                                                                 */
/* ------------------------------------------------------------------ */

const fmt = (v) => (v === null || v === undefined ? '—' : `${v}%`);
const fmtDiff = (v) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v} pp`);

export function reportMarkdown(report) {
  const d = report.data;
  const out = [`# ${report.title}`, '', `Generated ${new Date(report.finishedAt || report.createdAt).toISOString()} · ${report.roomCount} rooms`, ''];
  if (!d) return out.concat(['(no data)']).join('\n');
  const products = d.products;
  const names = Object.fromEntries(products.map((p) => [p.id, p.label]));

  if (report.aiSummary) out.push('## Summary', '', report.aiSummary, '');

  out.push('## Overall (all rooms with a result)', '', `| Metric | ${products.map((p) => p.label).join(' | ')} |`, `|---|${products.map(() => '---').join('|')}|`);
  for (const m of d.metrics) {
    out.push(`| ${m.label} (${m.better} is better) | ${products.map((p) => {
      const s = d.overall[m.key][p.id];
      return s.n ? `${fmt(s.mean)} (n=${s.n}${s.ci ? `, ±${round1((s.ci[1] - s.ci[0]) / 2)}` : ''})` : '—';
    }).join(' | ')} |`);
  }
  out.push('');

  out.push('## Paired comparison vs My Notes (rooms where all products have the metric)', '', `| Metric | Rooms | ${products.map((p) => p.label).join(' | ')} | ${products.filter((p) => p.id !== d.baseline).map((p) => `${p.label} − My Notes (95% CI)`).join(' | ')} |`, `|---|---|${products.map(() => '---').join('|')}|${products.filter((p) => p.id !== d.baseline).map(() => '---').join('|')}|`);
  for (const m of d.metrics) {
    const pr = d.paired[m.key];
    if (!pr.rooms) continue;
    out.push(`| ${m.label} | ${pr.rooms} | ${products.map((p) => fmt(pr.means[p.id])).join(' | ')} | ${products
      .filter((p) => p.id !== d.baseline)
      .map((p) => {
        const v = pr.vsBaseline[p.id];
        return `${fmtDiff(v.meanDiff)}${v.ci ? ` [${v.ci[0]}, ${v.ci[1]}]` : ''}${v.stable ? ' ✱' : ''}`;
      })
      .join(' | ')} |`);
  }
  out.push('', '✱ = the 95% confidence interval excludes 0 (a stable difference).', '');

  out.push('## By group', '');
  const key = ['ewer', 'uer', 'f1', 'criticalRate'];
  for (const g of d.groups) {
    out.push(`### ${g.title}`, '', `| ${g.title} | Rooms | ${key.map((k) => products.map((p) => `${d.metrics.find((m) => m.key === k).label} · ${p.label}`).join(' | ')).join(' | ')} |`, `|---|---|${key.flatMap(() => products.map(() => '---')).join('|')}|`);
    for (const b of g.buckets) {
      out.push(`| ${b.value} | ${b.rooms} | ${key.map((k) => products.map((p) => fmt(b.metrics[k][p.id].mean)).join(' | ')).join(' | ')} |`);
    }
    out.push('');
  }

  out.push('## Errors', '');
  for (const p of products) {
    const e = d.errors[p.id];
    out.push(`### ${p.label}`, '');
    out.push(`- Summary error types: ${Object.entries(e.errorTypes).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
    out.push(`- Critical error types: ${Object.entries(e.criticalTypes).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
    if (e.topEntityErrors.length) {
      out.push('- Most frequent entity errors:');
      for (const t of e.topEntityErrors.slice(0, 10))
        out.push(`  - "${t.term}" ×${t.errors} in ${t.rooms} room(s)${t.gotAs.length ? ` → ${t.gotAs.map((g) => `"${g.got}"`).join(', ')}` : ''}${t.dropped ? `, dropped ${t.dropped}` : ''}`);
    }
    const m = d.missing[p.id];
    out.push(`- Missing evaluations: transcript ${m.transcript.length}, summary ${m.summary.length}`, '');
  }

  out.push('## Per room', '', `| Room | Title | Lang | Speakers | Order | Ambience | ${products.map((p) => `${names[p.id]} EWER / UER / F1`).join(' | ')} |`, `|---|---|---|---|---|---|${products.map(() => '---').join('|')}|`);
  for (const r of d.perRoom) {
    out.push(`| ${r.id} | ${String(r.title || '').replace(/\|/g, '/')} | ${r.language} | ${r.speakers} | ${r.order} | ${r.noise} | ${products
      .map((p) => {
        const v = r.values[p.id];
        return `${fmt(v.ewer)} / ${fmt(v.uer)} / ${fmt(v.f1)}`;
      })
      .join(' | ')} |`);
  }
  return out.join('\n');
}

export function reportCsv(report) {
  const d = report.data;
  if (!d) return '';
  const cols = d.metrics.map((m) => m.key);
  const header = ['room', 'title', 'language', 'speakers', 'order', 'ambience', 'accent', 'product', ...cols];
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  for (const r of d.perRoom) {
    for (const p of d.products) {
      lines.push(
        [r.id, r.title, r.language, r.speakers, r.order, r.noise, r.accents.join('/') || 'none', p.label, ...cols.map((c) => r.values[p.id][c])]
          .map(esc)
          .join(',')
      );
    }
  }
  return lines.join('\n');
}
