// 批量导入：一个 transcript 文件 → 一个配置好的房间。
//
// 「配置」来自三处，按可信度从高到低：
//   1. 文件开头的要求头（front matter 或者若干行 `Key: value`），例如
//        ---
//        Title: Weekly sync
//        Speakers: Alice (Indian accent, female), Bob, Carol
//        Accent: British
//        Order: chaotic
//        Noise: cafe
//        ---
//      键名中英文都认（Title/标题、Speakers/人数、Accent/口音、Language/语言、
//      Order/顺序、Noise/环境、Glossary/术语、Pace/语速、Requirements/要求）。
//   2. 台词里说话人名字后面的括号备注：`Alice (Indian accent): ...`
//   3. 文件名：`03_chaotic_cafe_indian-accent.txt` 也能读出无序 + 咖啡厅 + 印度口音。
//
// 读不出来的一律用房间默认值（有序、安静、按内容猜语种），用户之后可以在房间里改。
// 这里只配置、不合成音频 —— 合成仍然要房主在房间里手动点。

import path from 'node:path';
import { parseTranscript } from './parse.js';
import { voices } from './voices.js';
import {
  createRoom,
  deleteRoom,
  setTranscript,
  updateRoomSettings,
  setGlossary,
  normalizeTitle,
  titleWeight,
  TITLE_MAX_WEIGHT,
} from './rooms.js';

export const MAX_IMPORT_FILES = 100;
export const MAX_IMPORT_FILE_BYTES = 4 * 1024 * 1024;

const KEYS = [
  ['title', /^(title|name|room|subject|topic|meeting|标题|主题|会议|房间|房间名|名称)$/i],
  ['speakers', /^(speakers?|participants?|people|persons?|attendees|cast|roles?|人数|参与者|参会人|参会人数|人物|角色|说话人)$/i],
  ['accent', /^(accents?|口音)$/i],
  ['language', /^(lang|language|locale|语言|语种)$/i],
  ['order', /^(order|reading order|mode|style|turn[- ]?taking|顺序|模式|发言顺序|有序\/无序)$/i],
  ['noise', /^(noise|ambience|ambient|background|scene|environment|setting|环境|背景|噪音|环境音|场景)$/i],
  ['glossary', /^(glossary|terms|keywords|术语|关键词|词表)$/i],
  ['pace', /^(pace|speed|语速)$/i],
  ['requirements', /^(requirements?|config|notes?|要求|配置|说明|备注)$/i],
];

const HEADER_LINE = /^\s*(?:#+\s*|[-*]\s+|\[)?\s*([^:：=\]\n]{1,30}?)\s*[:：=]\s*(.*?)\s*\]?\s*$/;

function keyOf(raw) {
  const k = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  return KEYS.find(([, re]) => re.test(k))?.[0] ?? null;
}

/**
 * 把文件开头的要求头剥下来。返回 { meta, body }：meta 是 键 → 值 的表
 * （requirements 收集所有不认识的键和自由文本），body 是剩下的台词。
 */
export function extractHeader(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const meta = {};
  const extra = [];
  const add = (key, value) => {
    if (!value) return;
    meta[key] = meta[key] ? `${meta[key]}, ${value}` : value;
  };

  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;

  // front matter：--- 之间的每一行都算要求，不认识的键也收进 requirements
  if (/^-{3,}\s*$/.test(lines[i] ?? '')) {
    const end = lines.findIndex((l, n) => n > i && /^-{3,}\s*$/.test(l));
    if (end > i) {
      for (const l of lines.slice(i + 1, end)) {
        const m = l.match(HEADER_LINE);
        const key = m && keyOf(m[1]);
        if (key) add(key, m[2]);
        else if (l.trim()) extra.push(l.trim());
      }
      i = end + 1;
    }
  }

  // 再吃掉紧跟着的 `Key: value` 行（只认已知的键，免得把第一句台词当成要求）
  let sawTitleLine = false;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    const m = l.match(HEADER_LINE);
    const key = m && keyOf(m[1]);
    if (key) {
      add(key, m[2]);
      continue;
    }
    // Markdown 标题行当房间名
    const h = l.match(/^\s*#{1,3}\s+(.+?)\s*$/);
    if (h && !sawTitleLine && !meta.title) {
      sawTitleLine = true;
      meta.title = h[1];
      continue;
    }
    break;
  }

  if (extra.length) add('requirements', extra.join(', '));
  return { meta, body: lines.slice(i).join('\n') };
}

/* ------------------------------------------------------------------ */
/* 各项要求的识别                                                        */
/* ------------------------------------------------------------------ */

const LANGUAGE_NAMES = [
  ['en', /^(en|eng|english|英文|英语|英語)$/i],
  ['zh', /^(zh|cn|chinese|mandarin|中文|汉语|普通话|国语|中)$/i],
  ['ja', /^(ja|jp|japanese|日语|日文|日本语|日本語)$/i],
  ['fr', /^(fr|french|français|法语|法文)$/i],
  ['de', /^(de|german|deutsch|德语|德文)$/i],
  ['es', /^(es|spanish|español|西班牙语|西语)$/i],
  ['pt', /^(pt|portuguese|português|葡萄牙语|葡语)$/i],
  ['it', /^(it|italian|italiano|意大利语)$/i],
  ['nl', /^(nl|dutch|nederlands|荷兰语)$/i],
];

const STOPWORDS = {
  en: ['the', 'and', 'is', 'you', 'that', 'to', 'of', 'we', 'it', 'this', 'what', 'i'],
  fr: ['le', 'la', 'les', 'et', 'est', 'vous', 'nous', 'que', 'pas', 'une', 'je', 'des'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'wir', 'ich', 'sie', 'ein', 'zu', 'es'],
  es: ['el', 'los', 'que', 'y', 'es', 'no', 'una', 'por', 'para', 'está', 'las', 'pero'],
  pt: ['o', 'os', 'que', 'não', 'é', 'uma', 'para', 'você', 'está', 'com', 'mas', 'isso'],
  it: ['il', 'che', 'non', 'è', 'per', 'una', 'sono', 'gli', 'della', 'ma', 'questo', 'io'],
  nl: ['de', 'het', 'een', 'en', 'niet', 'dat', 'ik', 'je', 'wij', 'van', 'is', 'we'],
};

function languageFromName(raw) {
  const v = String(raw || '').trim();
  return LANGUAGE_NAMES.find(([, re]) => re.test(v))?.[0] ?? null;
}

/** 没写语言时按内容猜：有假名是日语，有汉字是中文，拉丁字母按常用词打分 */
export function detectLanguage(text) {
  const sample = String(text || '').slice(0, 20000);
  const kana = (sample.match(/[぀-ヿ]/g) || []).length;
  const han = (sample.match(/[一-鿿]/g) || []).length;
  const latin = (sample.match(/[a-zA-ZÀ-ɏ]/g) || []).length;
  if (kana > 10 && kana * 10 > han) return 'ja';
  if (han > latin / 3 && han > 10) return kana > 10 ? 'ja' : 'zh';

  const words = sample.toLowerCase().match(/[\p{L}]+/gu) || [];
  const freq = new Map();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  let best = 'en';
  let bestScore = 0;
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const score = list.reduce((n, w) => n + (freq.get(w) || 0), 0);
    if (score > bestScore) {
      best = lang;
      bestScore = score;
    }
  }
  return best;
}

const ORDER_TOKEN = [
  ['chaotic', /^(无序|乱序|混乱|抢话|chaotic|chaos|unordered|disordered|messy|random)$/i],
  ['ordered', /^(有序|顺序|轮流|ordered|orderly|order|sequential)$/i],
];
const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/**
 * 文件名约定：语言 + 会议主题 + 人数 + 有序/无序，例如
 *   英文_产品评审_3人_有序.txt
 *   EN-Weekly sync-4p-chaotic.txt
 *   zh 季度复盘 5 无序.md
 * 分隔符用 _ - 空格 · | 都行，四段的顺序也不强求：认得出的语言、人数、有序/无序
 * 各取第一个，剩下的拼起来就是主题。语言的两字母缩写（en/de/it…）只在开头认，
 * 免得把主题里的 "it" "de" 当成语言；开头的「01」这种序号会跳过。
 */
export function parseFileName(stem) {
  const tokens = String(stem || '')
    .split(/[_\-–—\s·|,，、+]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const out = { language: null, count: null, order: null, topic: '' };

  // 人数：优先带单位的（3人、4p、5 people）；没有的话取主题之后最后一个裸数字。
  // 开头的「01」这种是序号，不算。
  const COUNT = /^(\d{1,2}|[一二两三四五六七八九十])\s*(人|位|名|p|ppl|people|persons?|speakers?|pax)?$/i;
  const toNum = (v) => Number(v) || CN_NUM[v];
  let countAt = tokens.findIndex((t) => COUNT.exec(t)?.[2]);
  if (countAt < 0) {
    for (let i = tokens.length - 1; i > 0; i--) {
      if (COUNT.test(tokens[i]) && !languageFromName(tokens[i])) {
        countAt = i;
        break;
      }
    }
  }
  if (countAt >= 0) out.count = toNum(COUNT.exec(tokens[countAt])[1]);

  // 两字母缩写只在「第一个非序号」的位置认；完整名称（English、中文…）哪里都认
  const head = tokens.findIndex((t) => !/^\d+$/.test(t));
  const rest = [];
  tokens.forEach((tok, i) => {
    if (i === countAt) return;
    if (!out.language) {
      const lang = languageFromName(tok);
      if (lang && (i === head || tok.length > 3 || /[^\x00-\x7f]/.test(tok))) {
        out.language = lang;
        return;
      }
    }
    if (!out.order) {
      const hit = ORDER_TOKEN.find(([, re]) => re.test(tok));
      if (hit) {
        out.order = hit[0];
        return;
      }
    }
    rest.push(tok);
  });
  // 开头的纯数字序号不进主题
  while (rest.length > 1 && /^\d+$/.test(rest[0])) rest.shift();
  out.topic = rest.join(' ');
  return out;
}

export function detectOrder(text) {
  const t = String(text || '');
  if (/chao|无序|混乱|抢话|打断|插话|interrupt|overlap|messy|unordered|random|cross[- ]?talk/i.test(t)) return 'chaotic';
  if (/order|有序|轮流|依次|sequential|turn/i.test(t)) return 'ordered';
  return null;
}

/** { noiseMode, ambienceKind } 里能读出来的那部分 */
export function detectNoise(text) {
  const t = String(text || '');
  const out = {};
  if (/airport|机场|terminal|候机/i.test(t)) out.ambienceKind = 'airport';
  else if (/caf[eé]|coffee|咖啡|restaurant|餐厅|bar\b/i.test(t)) out.ambienceKind = 'cafe';

  if (/quiet|安静|静音|silent|no[- ]?noise|无噪|无背景|\bnone\b|\boff\b/i.test(t)) out.noiseMode = 'quiet';
  else if (out.ambienceKind || /noisy|noise|嘈杂|吵|噪|ambien|background|背景音|环境音/i.test(t)) out.noiseMode = 'noisy';
  return out;
}

export function detectPace(text) {
  return /fast|quick|快/i.test(String(text || '')) ? 'fast' : null;
}

/** 口音关键词 → 音色库 accents 里的子串 */
const ACCENTS = [
  ['indian', /indian|india|印度/i],
  ['chinese', /chinese|china|中式|中国/i],
  ['british', /british|\buk\b|england|英式|英国/i],
  ['west coast', /west coast|american|\bus\b|california|美式|美国|西海岸/i],
  ['japanese', /japan|日式|日本/i],
  ['mexican', /mexic|墨西哥/i],
  ['taiwanese', /taiwan|台湾/i],
  ['german', /german|德式|德国/i],
];

/** 一段文字里提到了哪些口音（按出现顺序，可重复：「Indian, Indian」= 两个人） */
export function accentKeys(text) {
  const parts = String(text || '')
    .split(/[,，、;；/&+\n]|\band\b|和|与/i)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const p of parts) {
    const hit = ACCENTS.find(([, re]) => re.test(p));
    if (!hit) continue;
    // 「2 Indian」「两个印度口音」→ 重复。数字必须紧挨着口音词，文件名开头的序号不算
    const before = p.slice(0, p.search(hit[1]));
    const m = before.match(/(\d{1,2}|[两二三四])\s*(?:x|×|个|位|名)?\s*$/);
    const n = m ? Number(m[1]) || { 两: 2, 二: 2, 三: 3, 四: 4 }[m[1]] : 1;
    for (let k = 0; k < Math.min(n, 12); k++) out.push(hit[0]);
  }
  return out;
}

/** 自由文本里「xx accent / xx口音」这种片段 */
function accentPhrases(text) {
  const t = String(text || '');
  const out = [];
  for (const m of t.matchAll(/((?:\d+\s*)?[\p{L}][\p{L} -]{0,20}?)[\s_-]*(?:accents?|口音)/giu)) out.push(m[1]);
  return accentKeys(out.join(', '));
}

function genderOf(text) {
  const t = String(text || '');
  if (/female|woman|女/i.test(t)) return 'female';
  if (/\bmale\b|\bman\b|男/i.test(t)) return 'male';
  return null;
}

/** 「Alice (Indian accent, female), Bob」→ [{name, note}]；纯数字返回 count */
function parseSpeakerList(raw) {
  const v = String(raw || '').trim();
  const count = Number(v.match(/^\D{0,6}(\d{1,2})\b/)?.[1]) || null;
  const items = [];
  for (const m of v.matchAll(/([^,，、;；()（）]+?)\s*(?:[（(]([^）)]*)[）)])?\s*(?:[,，、;；]|$)/g)) {
    const name = m[1].trim();
    if (!name || /^\d+(\s*(people|persons?|speakers?|人|位|名))?$/i.test(name)) continue;
    items.push({ name, note: (m[2] || '').trim() });
  }
  return { count, items };
}

/* ------------------------------------------------------------------ */
/* 音色分配                                                             */
/* ------------------------------------------------------------------ */

const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const hasAccent = (v, key) => v.accents.some((a) => a.toLowerCase().includes(key));

/**
 * 给每个说话人挑音色。
 *   hints:   name -> { accent?, gender? }   单独指定的
 *   accents: 没指名道姓的口音，按顺序分给前几个还没指定口音的说话人
 * 同一房间里尽量不重复；本语种的无口音音色用完了才重复。
 */
export function planVoices(speakers, { language, hints = {}, accents = [] }) {
  const all = voices();
  let pool = all.filter((v) => v.country === language);
  if (!pool.length) pool = all.filter((v) => v.country === 'en');
  const used = new Set();
  const plan = {};

  const pick = (candidates, gender) => {
    const free = candidates.filter((v) => !used.has(v.id));
    const list = free.length ? free : candidates;
    if (!list.length) return null;
    const preferred = gender ? list.filter((v) => v.gender === gender) : [];
    const v = shuffle(preferred.length ? preferred : list)[0];
    used.add(v.id);
    return v.id;
  };

  const accentVoices = (key) => {
    const local = pool.filter((v) => hasAccent(v, key));
    return local.length ? local : all.filter((v) => hasAccent(v, key));
  };

  // 1. 指名道姓要了口音的
  for (const name of speakers) {
    const h = hints[name];
    if (h?.accent) plan[name] = pick(accentVoices(h.accent), h.gender);
  }

  // 2. 没指名的口音，依次给还没定的说话人
  const queue = [...accents];
  for (const name of speakers) {
    if (!queue.length) break;
    if (plan[name] || hints[name]?.accent) continue;
    plan[name] = pick(accentVoices(queue.shift()), hints[name]?.gender);
  }

  // 3. 其余的用本语种的无口音音色
  const plain = pool.filter((v) => !v.accents.length);
  for (const name of speakers) {
    if (plan[name]) continue;
    plan[name] = pick(plain.length ? plain : pool, hints[name]?.gender);
  }
  return plan;
}

/* ------------------------------------------------------------------ */
/* 房间命名                                                             */
/* ------------------------------------------------------------------ */

const cap = (s) => s.replace(/(^|\s)\S/g, (c) => c.toUpperCase()).replace(/\s+/g, '');
const SEP = ' | ';
const MIN_BASE_WEIGHT = 12; // 房间名本身至少留这么多，不然全是标签认不出是哪个文件

/**
 * 「Weekly sync | EN·3p·Indian·Chaos·Cafe」，总长不超过房间名上限。
 * 默认值（有序、安静）不写，省地方；放不下时先省口音标签。
 */
export function composeTitle(base, { language, speakerCount, accents, orderMode, noiseMode, ambienceKind }) {
  const head = [language.toUpperCase(), `${speakerCount}p`];
  const accentTags = [...new Set(accents)].map(cap);
  const tail = [
    ...(orderMode === 'chaotic' ? ['Chaos'] : []),
    ...(noiseMode === 'noisy' ? [ambienceKind === 'airport' ? 'Airport' : 'Cafe'] : []),
  ];
  const suffixOf = () => [...head, ...accentTags, ...tail].join('·');
  while (accentTags.length && titleWeight(suffixOf()) > TITLE_MAX_WEIGHT - SEP.length - MIN_BASE_WEIGHT) {
    accentTags.pop();
  }
  const suffix = suffixOf();

  const clean = String(base || '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return normalizeTitle(suffix);
  let kept = '';
  for (const ch of clean) {
    if (titleWeight(kept + ch + SEP + suffix) > TITLE_MAX_WEIGHT) break;
    kept += ch;
  }
  return normalizeTitle(kept.trim() ? `${kept.trim()}${SEP}${suffix}` : suffix);
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/** 只做解析和规划，不落库 —— 测试和预览都用它 */
export function planImport({ name, text }) {
  const stem = path.basename(String(name || ''), path.extname(String(name || ''))).trim();
  const { meta, body } = extractHeader(text);
  const parsed = parseTranscript(body, { mergeConsecutive: true });
  if (!parsed.lines.length) throw new Error(parsed.warnings[0] || 'No lines were parsed');

  // 文件名是主要的要求来源：语言 + 会议主题 + 人数 + 有序/无序
  const fromName = parseFileName(stem);
  const fileWords = stem.replace(/[_.]+/g, ' ');
  const freeText = [meta.requirements, fileWords].filter(Boolean).join(', ');
  const warnings = [...parsed.warnings];

  const language =
    languageFromName(meta.language) ||
    fromName.language ||
    detectLanguage(parsed.lines.map((l) => l.content).join('\n'));

  const orderMode = detectOrder(meta.order) || fromName.order || detectOrder(freeText) || 'ordered';
  const noise = { ...detectNoise(freeText), ...(meta.noise ? detectNoise(meta.noise) : {}) };
  if (meta.noise && !noise.noiseMode) noise.noiseMode = 'noisy'; // 「Noise: 有」之类
  const noiseMode = noise.noiseMode || 'quiet';
  const ambienceKind = noise.ambienceKind || 'cafe';
  const pace = detectPace(meta.pace) || 'normal';

  // 说话人级别的提示：要求头里的名单备注 + 台词里名字后的括号备注 + 「Accent: Alice: Indian」
  const hints = {};
  const hint = (who, note) => {
    if (!parsed.speakers.includes(who) || !note) return;
    const accent = accentKeys(note)[0] || accentPhrases(note)[0];
    const gender = genderOf(note);
    hints[who] = { accent: hints[who]?.accent || accent, gender: hints[who]?.gender || gender };
  };
  const list = parseSpeakerList(meta.speakers);
  list.items.forEach((it) => hint(it.name, it.note));
  Object.entries(parsed.notes || {}).forEach(([who, note]) => hint(who, note));

  const globalAccents = [];
  for (const part of String(meta.accent || '').split(/[,，;；]/)) {
    const m = part.match(/^\s*([^:：=]+?)\s*[:：=]\s*(.+)$/);
    if (m && parsed.speakers.includes(m[1].trim())) hint(m[1].trim(), `${m[2]} accent`);
    else globalAccents.push(...accentKeys(part));
  }
  if (!meta.accent) globalAccents.push(...accentPhrases(freeText));

  const wantCount = list.count || fromName.count;
  if (wantCount && wantCount !== parsed.speakers.length) {
    warnings.push(`Requirements say ${wantCount} speakers but the transcript has ${parsed.speakers.length}`);
  }

  const voicePlan = planVoices(parsed.speakers, { language, hints, accents: globalAccents });
  const accentsUsed = [
    ...Object.values(hints).map((h) => h.accent).filter(Boolean),
    ...globalAccents,
  ];

  const settings = { orderMode, noiseMode, ambienceKind };
  const title = composeTitle(meta.title || fromName.topic || stem, {
    language,
    speakerCount: parsed.speakers.length,
    accents: accentsUsed,
    ...settings,
  });

  return { parsed, title, language, settings, pace, voicePlan, accents: accentsUsed, glossary: meta.glossary || '', warnings };
}

/** 建房间 + 写 transcript + 应用配置。失败时把半成品房间删掉。 */
export function importTranscript({ name, text }) {
  const plan = planImport({ name, text });
  const { id, hostToken } = createRoom({ title: plan.title });
  try {
    setTranscript(id, plan.parsed, { voices: plan.voicePlan, config: { pace: plan.pace } });
    updateRoomSettings(id, plan.settings);
    if (plan.glossary) setGlossary(id, plan.glossary.replace(/\s*[,，;；]\s*/g, '\n'));
  } catch (err) {
    deleteRoom(id);
    throw err;
  }
  return {
    file: name,
    ok: true,
    id,
    hostToken,
    title: plan.title,
    language: plan.language,
    speakerCount: plan.parsed.speakers.length,
    lineCount: plan.parsed.lines.length,
    settings: plan.settings,
    accents: plan.accents,
    warnings: plan.warnings,
  };
}
