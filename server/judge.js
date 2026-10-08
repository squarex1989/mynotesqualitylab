// Transcript 评估：拿各家产品录出来的转录，和房间里的原始脚本（唯一真值）比对。
//
// 按《How we measure summary and transcript quality》的口径，主指标四个：
//   EWER  —— 只看实体词（人名、公司、产品、地点、术语）的错误率。实体表从脚本里抽一次
//            （server/reference.js），并上 glossary 和说话人名
//   UER   —— 和 μ-bench 同口径：至少含一个「意思变了」错误的句子占比。逐个错误由模型判
//            三档，按句二值化由代码算（server/uer.js）
//   WDER  —— 词级说话人归属错误率：对齐上的词里，落在错误说话人名下的占比
//   Language Correctness —— 逐行比对语种（产品把一句拆成几行也能对上，见 metrics.js）
// Plain WER 留作次要参考。
//
// 模型只回答语义问题，不打分；所有数字都由代码算出来。

import { codeMetrics } from './metrics.js';
import { computeUer } from './uer.js';
import { apiKeyProblem } from './llm.js';

export { apiKeyProblem };

/** 被比较的三个产品。id 进数据库，label 给界面。 */
export const PRODUCTS = [
  { id: 'my-notes', label: 'My Notes' },
  { id: 'granola', label: 'Granola' },
  { id: 'otter', label: 'Otter' },
];

export function isProduct(id) {
  return PRODUCTS.some((p) => p.id === id);
}

/** 说话人归属准确率 → WDER（越低越好）。没做说话人分离的产品单独标出来，不给数 */
export function wderOf(speakers) {
  if (!speakers || speakers.unavailable) return { wder: null, reason: speakers?.reason || 'unavailable' };
  if (speakers.unlabeled) return { wder: null, unlabeled: true };
  if (typeof speakers.attributionAccuracy !== 'number') return { wder: null };
  return {
    wder: Math.round((100 - speakers.attributionAccuracy) * 10) / 10,
    misattributed: speakers.misattributed,
    alignedWords: speakers.alignedTokens,
  };
}

/**
 * @param {{reference: string, candidate: string, glossary?: string, entities?: string[], language?: string}} input
 */
export async function gradeTranscript({ reference, candidate, glossary = '', entities = [], language = null }) {
  const metrics = codeMetrics({ reference, candidate, glossary, entities, language });
  if (metrics.unavailable) {
    return {
      version: 2,
      metrics: strip(metrics),
      uer: { unavailable: true, reason: 'Nothing to compare against' },
      headline: {},
    };
  }

  let uer;
  const problem = apiKeyProblem();
  if (problem) uer = { unavailable: true, reason: problem };
  else {
    try {
      uer = await computeUer(metrics.utterances || []);
    } catch (err) {
      uer = { unavailable: true, reason: err?.message || String(err) };
    }
  }

  const wder = wderOf(metrics.speakers);
  return {
    version: 2,
    metrics: strip(metrics),
    uer,
    headline: {
      ewer: metrics.ewer.ewer,
      uer: uer.unavailable ? null : uer.uer,
      wder: wder.wder,
      wderUnlabeled: wder.unlabeled || undefined,
      language: metrics.languageCheck.correctness,
      wer: metrics.wer.wer,
    },
  };
}

/** 中间产物不进数据库 */
function strip(m) {
  const { hunks: _h, utterances: _u, leads: _l, weighted: _w, ...rest } = m;
  return rest;
}
