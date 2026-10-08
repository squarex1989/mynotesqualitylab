// 给一个房间里的一个产品跑评估：转录（EWER / UER / WDER / 语言 / WER）和摘要（Precision /
// Recall / F1 / Critical / Action items）并行跑，各自记状态，互不拖累。
// 房间里点 Score、报告里「先补跑缺失的评估」都走这里。

import {
  getComparisons,
  getRoom,
  referenceTranscript,
  roomLanguage,
  setComparisonState,
  setSummaryState,
} from './rooms.js';
import { gradeTranscript } from './judge.js';
import { gradeSummary } from './summaryEval.js';
import { ensureReference, numberedScript } from './reference.js';
import { apiKeyProblem } from './llm.js';

/**
 * @param {string} roomId
 * @param {string} product
 * @param {{parts?: ('transcript'|'summary')[], onChange?: () => void}} opts
 * @returns {Promise<{transcript?: string, summary?: string}>} 各部分的最终状态
 */
export async function evaluateProduct(roomId, product, { parts = ['transcript', 'summary'], onChange = () => {} } = {}) {
  const reference = referenceTranscript(roomId);
  if (!reference.trim()) throw new Error('This room has no transcript to compare against');
  const row = getComparisons(roomId).find((c) => c.product === product);
  if (!row) throw new Error("Paste that product's transcript or summary first");

  const doTranscript = parts.includes('transcript') && row.transcript?.trim() && row.state !== 'scoring';
  const doSummary = parts.includes('summary') && row.summary?.trim() && row.summaryState !== 'scoring';
  if (!doTranscript && !doSummary) return {};

  if (doTranscript) setComparisonState(roomId, product, 'scoring');
  if (doSummary) setSummaryState(roomId, product, 'scoring');
  onChange();

  // 实体表和参考信息单元，每个房间只抽一次。抽不出来（比如没配 key）时：
  // 转录照样评（EWER 退回自动识别的专有名词），摘要评不了
  let ref = null;
  let refError = apiKeyProblem();
  if (!refError) {
    try {
      ref = await ensureReference(roomId);
    } catch (err) {
      refError = err.message || String(err);
    }
  }
  const language = roomLanguage(roomId);
  const out = {};

  await Promise.all([
    doTranscript &&
      (async () => {
        try {
          const result = await gradeTranscript({
            reference,
            candidate: row.transcript,
            glossary: getRoom(roomId)?.glossary || '',
            entities: ref?.entities.map((e) => e.text) ?? [],
            language,
          });
          setComparisonState(roomId, product, 'done', { result });
          out.transcript = 'done';
        } catch (err) {
          setComparisonState(roomId, product, 'failed', { error: err.message || String(err) });
          out.transcript = 'failed';
        }
        onChange();
      })(),
    doSummary &&
      (async () => {
        try {
          if (!ref) throw new Error(`Could not build the reference for this room: ${refError}`);
          const result = await gradeSummary({
            script: numberedScript(roomId),
            reference: ref,
            summary: row.summary,
            language,
          });
          setSummaryState(roomId, product, 'done', { result });
          out.summary = 'done';
        } catch (err) {
          setSummaryState(roomId, product, 'failed', { error: err.message || String(err) });
          out.summary = 'failed';
        }
        onChange();
      })(),
  ]);
  return out;
}
