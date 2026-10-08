// 每个房间的「参考」：从原始脚本（唯一真值）里抽一次，三个产品共用，缓存起来。
//
//   entities —— 人名、公司、产品、地点、术语。EWER 只看这些词（数字日期单独统计）。
//   units    —— 会议里「应该出现在摘要里」的原子信息单元：决定、结论、风险、待解问题、
//               重要事实、状态变化、讨论要点、行动项。每个单元带重要度（3 关键 / 2 重要 /
//               1 次要），Summary Recall 按重要度加权。行动项另带负责人、截止时间、交付物、
//               承诺状态，用来核对产品抽出来的行动项的各个字段。
//
// 脚本没变就一直用缓存（按脚本内容的哈希判断）；脚本是锁定的，所以实际上每个房间只抽一次。

import crypto from 'node:crypto';
import { db } from './db.js';
import { getLines } from './rooms.js';
import { callJson, EVAL_MODEL } from './llm.js';

export const UNIT_TYPES = [
  'decision',
  'conclusion',
  'risk',
  'open_question',
  'fact',
  'status_change',
  'discussion_point',
  'action_item',
];
export const ENTITY_TYPES = ['person', 'organization', 'product', 'place', 'term', 'other'];
export const COMMITMENT = ['committed', 'tentative', 'blocked', 'completed', 'cancelled', 'none'];

const MAX_SCRIPT_CHARS = 150000;

const SYSTEM = `You prepare the reference for evaluating meeting summaries and transcripts.
You get the exact script of a meeting (numbered lines, "Speaker: text"). Return two things.

1. entities: every named entity that a transcription product must get right — people's names, organizations, products, places, and domain terms / acronyms / jargon. Use the exact spelling from the script. List each distinct entity once. Do NOT include plain numbers, dates, or common words.

2. units: the atomic information units a good summary of this meeting should contain.
- One unit = one self-contained piece of information (a single decision, risk, fact, open question, action item...). Split compound statements.
- type: decision | conclusion | risk | open_question | fact | status_change | discussion_point | action_item.
  * decision = something the group actually decided (not a proposal).
  * action_item = a genuine commitment or follow-up task. A suggestion, open question or hypothetical next step is NOT an action item unless the conversation establishes a commitment.
- importance: 3 = critical (final decisions, commitments, blockers, key numbers/deadlines), 2 = important, 1 = minor detail.
- text: a concise statement in the script's language, preserving modality (may / will / suggested / rejected / decided) and exact names, numbers and dates.
- lines: the script line numbers supporting the unit.
- owner / due / deliverable: for action items only, exactly as stated in the script; "" when not stated (never infer). For other types use "".
- status: for action items: committed | tentative | blocked | completed | cancelled; for other types: none.
Skip greetings, filler and small talk. Prefer fewer, meaningful units over many trivial ones.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['entities', 'units'],
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'type'],
        properties: { text: { type: 'string' }, type: { type: 'string', enum: ENTITY_TYPES } },
      },
    },
    units: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'importance', 'text', 'lines', 'owner', 'due', 'deliverable', 'status'],
        properties: {
          type: { type: 'string', enum: UNIT_TYPES },
          importance: { type: 'integer', enum: [1, 2, 3] },
          text: { type: 'string' },
          lines: { type: 'array', items: { type: 'integer' } },
          owner: { type: 'string' },
          due: { type: 'string' },
          deliverable: { type: 'string' },
          status: { type: 'string', enum: COMMITMENT },
        },
      },
    },
  },
};

/** 编号的脚本文本，判定时引用行号用 */
export function numberedScript(roomId) {
  return getLines(roomId)
    .map((l) => `${l.idx + 1}. ${l.speaker}: ${l.content}`)
    .join('\n');
}

const hashOf = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);

/** 清洗模型输出：去空、去重、编号 */
export function cleanReference(data) {
  const seen = new Set();
  const entities = (Array.isArray(data?.entities) ? data.entities : [])
    .map((e) => ({ text: String(e?.text || '').trim(), type: ENTITY_TYPES.includes(e?.type) ? e.type : 'other' }))
    .filter((e) => e.text && e.text.length <= 80 && !/^\d[\d\s.,:/-]*$/.test(e.text))
    .filter((e) => {
      const k = e.text.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 300);
  const units = (Array.isArray(data?.units) ? data.units : [])
    .filter((u) => u && String(u.text || '').trim())
    .slice(0, 200)
    .map((u, i) => {
      const type = UNIT_TYPES.includes(u.type) ? u.type : 'fact';
      return {
        id: `U${i + 1}`,
        type,
        importance: [1, 2, 3].includes(Number(u.importance)) ? Number(u.importance) : 2,
        text: String(u.text).trim(),
        lines: (Array.isArray(u.lines) ? u.lines : []).map(Number).filter(Number.isFinite).slice(0, 12),
        owner: type === 'action_item' ? String(u.owner || '').trim() : '',
        due: type === 'action_item' ? String(u.due || '').trim() : '',
        deliverable: type === 'action_item' ? String(u.deliverable || '').trim() : '',
        status: type === 'action_item' && COMMITMENT.includes(u.status) && u.status !== 'none' ? u.status : 'none',
      };
    });
  return { entities, units };
}

export function getCachedReference(roomId) {
  const row = db.prepare('SELECT * FROM room_reference WHERE room_id = ?').get(roomId);
  if (!row) return null;
  return { ...JSON.parse(row.data), model: row.model, createdAt: row.created_at, scriptHash: row.script_hash };
}

const inflight = new Map();

/** 拿这个房间的参考；没有或脚本变了就抽一次。同一个房间并发调用只抽一次。 */
export async function ensureReference(roomId) {
  const script = numberedScript(roomId);
  if (!script.trim()) throw new Error('This room has no script');
  const hash = hashOf(script);
  const cached = getCachedReference(roomId);
  if (cached && cached.scriptHash === hash) return cached;

  if (inflight.has(roomId)) return inflight.get(roomId);
  const job = (async () => {
    const { data, model } = await callJson({
      name: 'meeting_reference',
      system: SYSTEM,
      user: `Script:\n${script.slice(0, MAX_SCRIPT_CHARS)}`,
      schema: SCHEMA,
    });
    const ref = cleanReference(data);
    const now = Date.now();
    db.prepare(
      `INSERT INTO room_reference (room_id, script_hash, data, model, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(room_id) DO UPDATE SET script_hash = excluded.script_hash, data = excluded.data,
         model = excluded.model, created_at = excluded.created_at`
    ).run(roomId, hash, JSON.stringify(ref), model || EVAL_MODEL(), now);
    return { ...ref, model, createdAt: now, scriptHash: hash };
  })();
  inflight.set(roomId, job);
  try {
    return await job;
  } finally {
    inflight.delete(roomId);
  }
}
