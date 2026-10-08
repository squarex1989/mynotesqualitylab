// 脚本模式：导入的是 script.json（《会议脚本重写规范》），而不是一份普通 transcript。
//
// 和普通房间的区别只有一件事 —— 每句话什么时候开口由脚本决定，不由房间的
// 「有序 / 无序」随机生成：
//
//   timing.mode = 'after'   在 ref 那句「说完最后一个词」之后 gap_ms 毫秒开口（负数 = 抢话）
//   timing.mode = 'during'  在 ref 那句念到 at_text 这几个字时开口（附和、打断）
//
// 「说完」「念到」都按说话算，不按音频文件算：TTS 音频首尾有静音，at_text 落在
// 句子中间哪一毫秒更是只有逐词时间戳才知道。所以脚本房间合成时走 Fish 的
// /v1/tts/stream/with-timestamp，把逐词时间存进 audio.alignment（见 tts.js）。
// 拿不到时间戳时（接口没给 / 老缓存）按字数比例估，排期照样能跑，只是没那么准。
//
// 被打断的句子（cut_off）可以带 tts_continuation：合成时把后半句一起念，播放时
// 在 text 的最后一个词念完处淡出停掉 —— 这样语调是「话没说完」，而不是 TTS
// 给半句话配的句末降调。GT 只有 text，续接的那几个词谁也听不到。

/* ------------------------------------------------------------------ */
/* 解析                                                                 */
/* ------------------------------------------------------------------ */

const KINDS = new Set(['speech', 'backchannel', 'nonspeech']);

/** 看起来是不是 script.json（或 {script, answer_key} 打包） */
export function isScriptObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const script = Array.isArray(obj.utterances) ? obj : obj.script;
  return Boolean(script && Array.isArray(script.utterances));
}

function normalizeTiming(t) {
  if (!t || typeof t !== 'object') return null;
  const mode = t.mode === 'during' ? 'during' : 'after';
  const out = { mode };
  if ('ref' in t) out.ref = t.ref == null ? null : String(t.ref);
  if (mode === 'after') {
    const gap = Number(t.gap_ms);
    out.gap_ms = Number.isFinite(gap) ? Math.max(-5000, Math.min(30000, Math.round(gap))) : null;
  } else {
    out.at_text = String(t.at_text ?? '');
    const delay = Number(t.delay_ms);
    out.delay_ms = Number.isFinite(delay) ? Math.max(-3000, Math.min(10000, Math.round(delay))) : 0;
  }
  return out;
}

/**
 * script.json → 和 parseTranscript 同形的结果，外加 script（meta / speakers / answerKey）。
 * 不合并同一人的连续句、不切长句：脚本里分成几条就是几条，那是刻意的。
 */
export function parseScript(input) {
  const script = Array.isArray(input.utterances) ? input : input.script;
  const answerKey = input.answer_key ?? input.answerKey ?? null;
  const warnings = [];

  const speakersRaw = Array.isArray(script.speakers) ? script.speakers : [];
  const nameOf = new Map();
  const taken = new Set();
  for (const s of speakersRaw) {
    const id = String(s?.id ?? '').trim();
    if (!id) continue;
    let name = String(s.display_name || s.name || id).trim().slice(0, 40);
    // 房间里的角色按名字区分，重名的话用 id 补一下
    if (taken.has(name)) name = `${name} (${id})`;
    taken.add(name);
    nameOf.set(id, name);
  }

  const lines = [];
  const seenUid = new Set();
  for (const [i, u] of script.utterances.entries()) {
    if (!u || typeof u !== 'object') continue;
    const uid = String(u.id ?? `u${String(i + 1).padStart(4, '0')}`);
    const kind = KINDS.has(u.type) ? u.type : 'speech';
    const speaker = nameOf.get(String(u.speaker)) || String(u.speaker ?? '').trim().slice(0, 40);
    if (!speaker) {
      warnings.push(`${uid}: no speaker, skipped`);
      continue;
    }
    const content = kind === 'nonspeech' ? '' : String(u.text ?? '').trim();
    const ttsText = u.tts_text != null && String(u.tts_text).trim() ? String(u.tts_text).trim() : null;
    if (kind !== 'nonspeech' && !content) {
      warnings.push(`${uid}: empty text, skipped`);
      continue;
    }
    if (kind === 'nonspeech' && !ttsText) {
      warnings.push(`${uid}: nonspeech without tts_text has nothing to synthesize, skipped`);
      continue;
    }
    if (seenUid.has(uid)) warnings.push(`${uid}: duplicate utterance id — timing refs to it hit the first one`);
    seenUid.add(uid);
    const cutOff = Boolean(u.cut_off);
    lines.push({
      speaker,
      content,
      uid,
      kind,
      ttsText,
      ttsContinuation: cutOff && u.tts_continuation ? String(u.tts_continuation).trim() || null : null,
      timing: normalizeTiming(u.timing),
      cutOff,
      clean: typeof u.clean === 'string' ? u.clean : null,
    });
  }

  // 角色顺序跟脚本里 speakers 的顺序走，没声明过的说话人排在后面
  const speaking = new Set(lines.map((l) => l.speaker));
  const declared = [...nameOf.values()].filter((n) => speaking.has(n));
  const speakers = [...declared, ...[...speaking].filter((n) => !declared.includes(n))];

  if (!lines.length) warnings.unshift('The script has no utterances');
  return {
    lines,
    speakers,
    warnings,
    format: 'script',
    candidates: [],
    script: {
      meta: script.meta && typeof script.meta === 'object' ? script.meta : {},
      speakers: speakersRaw,
      speakerNames: Object.fromEntries(nameOf), // 脚本里的 speaker id → 房间里的角色名
      answerKey,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 送给 TTS 的文本                                                       */
/* ------------------------------------------------------------------ */

// 行尾是中日文（或全角标点）时，续接不加空格
const CJK_END = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}，。、？！]$/u;

/**
 * 一句话实际送给 TTS 的文本：tts_text（没有就用 text），被打断的句子再拼上续接。
 * 拼续接时去掉行尾的逗号 —— 否则 TTS 会在打断点先停顿一下，正好露馅。
 * 普通房间的行没有这些字段，结果就是 content，音频哈希和以前一样。
 */
export function ttsInputOf(line) {
  const base = String(line.tts_text ?? line.ttsText ?? '') || String(line.content ?? '');
  const cut = Boolean(line.cut_off ?? line.cutOff);
  const cont = cut ? String(line.tts_continuation ?? line.ttsContinuation ?? '').trim() : '';
  if (!cont) return base;
  const head = base.trim().replace(/[，,、;；]+$/u, '');
  return CJK_END.test(head) ? `${head}${cont}` : `${head} ${cont}`;
}

/** 不含续接的那部分（播放到它为止） */
function spokenPartOf(line) {
  return String(line.tts_text ?? line.ttsText ?? '') || String(line.content ?? '');
}

/* ------------------------------------------------------------------ */
/* 逐词时间戳                                                             */
/* ------------------------------------------------------------------ */

const TAG = /\[[^\[\]\n]{0,60}\]/g;

/** 对齐用的归一化：去掉 [标签]、标点和空白，只留字母数字（Fish 返回的词也不带标点） */
export function normForAlign(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(TAG, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Fish 的 SSE 快照 → 存库的形状：
 *   { durationMs, speechStartMs, speechEndMs, words: [{t, s, e}] }   s/e 是毫秒
 * snapshots: Map(chunk_seq -> { offset(秒), segments:[{text,start,end}] })
 */
export function alignmentFromSnapshots(snapshots, audioDurationSec) {
  const words = [];
  for (const [, snap] of [...snapshots.entries()].sort((a, b) => a[0] - b[0])) {
    const offset = Number(snap.offset) || 0;
    for (const seg of snap.segments || []) {
      const start = Number(seg?.start);
      const end = Number(seg?.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      words.push({
        t: String(seg.text ?? ''),
        s: Math.round((start + offset) * 1000),
        e: Math.round((Math.max(end, start) + offset) * 1000),
      });
    }
  }
  if (!words.length) return null;
  words.sort((a, b) => a.s - b.s);
  return {
    durationMs: Number.isFinite(audioDurationSec) ? Math.round(audioDurationSec * 1000) : null,
    speechStartMs: words[0].s,
    speechEndMs: Math.max(...words.map((w) => w.e)),
    words,
  };
}

/**
 * /v1/tts/stream/with-timestamp 的 SSE：每个 message 事件是一段 JSON，
 * 带一块 base64 音频；alignment 是该 chunk_seq 截至目前的累积快照 ——
 * 新快照替换旧的，不能追加（官方文档特意强调过）。音频块按到达顺序拼起来。
 */
export function parseTimestampStream(text) {
  const chunks = [];
  const snapshots = new Map();
  for (const block of String(text).replace(/\r\n?/g, '\n').split('\n\n')) {
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data || data === '[DONE]') continue;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event?.error || event?.event === 'error') {
      throw new Error(`Timestamp stream error: ${JSON.stringify(event.error ?? event.message ?? event).slice(0, 200)}`);
    }
    if (event?.audio_base64) chunks.push(Buffer.from(event.audio_base64, 'base64'));
    if (event?.alignment) {
      snapshots.set(Number(event.chunk_seq) || 0, {
        offset: Number(event.chunk_audio_offset_sec) || 0,
        segments: event.alignment.segments || [],
        duration: Number(event.alignment.audio_duration),
      });
    }
  }
  const buffer = Buffer.concat(chunks);
  if (!buffer.length) throw new Error('The timestamp stream carried no audio');
  return { buffer, snapshots };
}

const usable = (a) => Boolean(a && !a.unavailable && Array.isArray(a.words) && a.words.length);

/**
 * fullInput 这段音频里，念到 prefix 的最后一个字时是第几毫秒。
 *
 * 不要求 Fish 返回的词和原文逐字对得上（数字归一化、标签、断词方式都可能让它们
 * 有出入）：按「prefix 占全文多少比例」去词序列里找同样比例的位置，落在某个词
 * 中间就在那个词里插值。两边对得上时这就是精确位置，对不上时误差也只在一两个词。
 * 没有时间戳时退化成按比例落在 [0, durationMs] 上。
 */
export function locateInClip(alignment, fullInput, prefix, durationMs) {
  const total = normForAlign(fullInput).length;
  const ratio = total ? Math.min(1, normForAlign(prefix).length / total) : 1;
  if (!usable(alignment)) return Math.round(ratio * durationMs);

  const words = alignment.words;
  const lens = words.map((w) => normForAlign(w.t).length || 1);
  const sum = lens.reduce((a, b) => a + b, 0);
  const target = ratio * sum;
  if (target <= 0) return words[0].s;
  let acc = 0;
  for (let i = 0; i < words.length; i++) {
    if (acc + lens[i] >= target) {
      const w = words[i];
      return Math.round(w.s + ((w.e - w.s) * (target - acc)) / lens[i]);
    }
    acc += lens[i];
  }
  return words[words.length - 1].e;
}

/* ------------------------------------------------------------------ */
/* 排期                                                                 */
/* ------------------------------------------------------------------ */

const DEFAULT_GAP_MS = 450;
const CUT_FADE_MS = 80; // 被打断的句子在最后一个词念完后淡出的时长
const OVERLAP_MIN_MS = 150; // 少于这么多的重叠不算（时间戳本身有几十毫秒的误差）

/** 一句话在自己音频里的说话区间、播放截止点 */
function clipFacts(line, audio) {
  const durationMs = audio.durationMs;
  const a = audio.alignment;
  const full = ttsInputOf(line);
  let speechStart = usable(a) ? a.speechStartMs : 0;
  let speechEnd = usable(a) ? Math.min(a.speechEndMs, durationMs) : durationMs;
  let stopAtMs = null;

  const hasCont = full !== spokenPartOf(line) && Boolean(line.cut_off ?? line.cutOff);
  if (hasCont) {
    const cutEnd = locateInClip(a, full, spokenPartOf(line), durationMs);
    speechEnd = Math.max(speechStart + 200, Math.min(cutEnd, durationMs));
    stopAtMs = Math.min(durationMs, speechEnd + CUT_FADE_MS);
  }
  speechStart = Math.min(speechStart, speechEnd);
  return { durationMs, speechStart, speechEnd, stopAtMs, full };
}

/** ref 那句念到 at_text 结尾时，在它自己音频里是第几毫秒 */
function anchorInRef(refLine, refFacts, refAudio, atText) {
  const at = String(atText || '').trim();
  if (!at) return null;
  // 先在送给 TTS 的文本里找（时间戳就是按它算的），找不到再退到 text 上按比例
  const spoken = spokenPartOf(refLine).replace(TAG, '');
  let pos = spoken.indexOf(at);
  if (pos >= 0) {
    return locateInClip(refAudio.alignment, refFacts.full, spoken.slice(0, pos + at.length), refFacts.durationMs);
  }
  const text = String(refLine.content || '');
  pos = text.indexOf(at);
  if (pos < 0) return null;
  const ratio = (pos + at.length) / Math.max(1, text.length);
  return Math.round(refFacts.speechStart + ratio * (refFacts.speechEnd - refFacts.speechStart));
}

const parseTiming = (raw) => {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/**
 * 脚本房间的时间线。和 buildSchedule 同一个返回形状，外加 warnings。
 * 时间线上的位置都是「音频文件从第几毫秒开始放」；说话区间用 speechStartMs / speechEndMs
 * （相对于本句音频）另外记下来，导出 GT 时间戳和统计重叠都用它。
 */
export function buildScriptSchedule(room, lines, speakerMap, audioMap, fallbackDevice) {
  const gapDefault = room.gap_ms ?? DEFAULT_GAP_MS;
  const duckGain = room.duck_gain ?? 0.5;
  const placed = []; // 和 lines 对齐的中间结果
  const byUid = new Map();
  const warnings = { unresolvedRefs: [], missingAnchors: [], sameDeviceOverlaps: [] };

  for (const line of lines) {
    const audio = audioMap.get(line.idx);
    if (!audio) continue;
    const sp = speakerMap.get(line.speaker);
    const deviceId = sp?.device_id || fallbackDevice || null;
    const volume = Math.max(0, Math.min(1, (sp?.volume ?? 100) / 100));
    const facts = clipFacts(line, audio);
    const timing = parseTiming(line.timing);

    let speechAt; // 这句在时间线上开口的时刻
    const prev = placed[placed.length - 1];
    if (!prev) {
      speechAt = 0;
    } else {
      let ref = prev;
      if (timing && 'ref' in timing && timing.ref != null) {
        ref = byUid.get(String(timing.ref));
        if (!ref) {
          warnings.unresolvedRefs.push(line.uid || line.idx);
          ref = prev;
        }
      }
      if (timing?.mode === 'during') {
        const at = anchorInRef(ref.line, ref.facts, ref.audio, timing.at_text);
        if (at == null) warnings.missingAnchors.push(line.uid || line.idx);
        const anchor = at ?? Math.round((ref.facts.speechStart + ref.facts.speechEnd) / 2);
        speechAt = ref.startMs + anchor + (Number(timing.delay_ms) || 0);
      } else {
        const gap = Number.isFinite(timing?.gap_ms) ? timing.gap_ms : gapDefault;
        speechAt = ref.startMs + ref.facts.speechEnd + gap;
      }
    }

    const entry = { line, audio, facts, deviceId, volume, startMs: speechAt - facts.speechStart };
    placed.push(entry);
    if (line.uid && !byUid.has(String(line.uid))) byUid.set(String(line.uid), entry);
  }

  // 第一句的音频前面可能有静音，开口点又被定在 0 —— 整体平移回从 0 开始
  const minStart = placed.reduce((m, p) => Math.min(m, p.startMs), 0);
  const items = placed.map((p) => ({
    idx: p.line.idx,
    uid: p.line.uid ?? null,
    kind: p.line.kind || 'speech',
    speaker: p.line.speaker,
    deviceId: p.deviceId,
    hash: p.audio.hash,
    startMs: Math.round(p.startMs - minStart),
    // 被打断的句子只放到截止点，后面的续接不出声
    durationMs: p.facts.stopAtMs ?? p.facts.durationMs,
    stopAtMs: p.facts.stopAtMs,
    fadeMs: p.facts.stopAtMs != null ? CUT_FADE_MS : null,
    speechStartMs: p.facts.speechStart,
    speechEndMs: p.facts.speechEnd,
    overlapMs: 0,
    duckFromMs: null, // 真人被打断是停下，不是变小声：脚本房间不压音量
    duckGain,
    volume: p.volume,
  }));

  items.sort((a, b) => a.startMs - b.startMs || a.idx - b.idx);

  // 开口时别人还在说 → 这句是插进来的（附和 / 抢话 / 打断）
  const speech = (it) => [it.startMs + it.speechStartMs, it.startMs + it.speechEndMs];
  for (let i = 0; i < items.length; i++) {
    const [s0] = speech(items[i]);
    let overlap = 0;
    for (let j = 0; j < items.length; j++) {
      if (j === i || items[j].speaker === items[i].speaker) continue;
      const [a0, a1] = speech(items[j]);
      if (a0 <= s0 && a1 > s0) overlap = Math.max(overlap, a1 - s0);
    }
    items[i].overlapMs = overlap >= OVERLAP_MIN_MS ? Math.round(overlap) : 0;
  }

  // 两个人的话叠在一起却由同一台设备放：声音从同一个位置出来，收音端分不清是两个人
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (!a.deviceId || a.deviceId !== b.deviceId || a.speaker === b.speaker) continue;
      const [a0, a1] = speech(a);
      const [b0, b1] = speech(b);
      if (Math.min(a1, b1) - Math.max(a0, b0) >= OVERLAP_MIN_MS) {
        warnings.sameDeviceOverlaps.push([a.uid || a.idx, b.uid || b.idx]);
      }
    }
  }

  const totalMs = items.reduce((max, it) => Math.max(max, it.startMs + it.durationMs), 0);
  const overlaps = items.filter((i) => i.overlapMs > 0).length;
  return { items, totalMs, overlaps, warnings };
}

/* ------------------------------------------------------------------ */
/* 时间线导出（GT 时间戳）                                                */
/* ------------------------------------------------------------------ */

const fmtClock = (ms) => {
  const t = Math.max(0, ms) / 1000;
  const m = Math.floor(t / 60);
  return `${String(m).padStart(2, '0')}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
};

/**
 * 时间线 + 台词 + 逐词时间戳 → 每句话在整场会议里的说话区间。
 * items 来自一次排期（session.items 或现算的），lines/alignments 按 idx / hash 查。
 */
export function timelineRows(items, lineByIdx, alignmentByHash) {
  return items
    .map((it) => {
      const line = lineByIdx.get(it.idx);
      if (!line) return null;
      const a = alignmentByHash.get(it.hash);
      const speechStart = it.speechStartMs ?? 0;
      const speechEnd = it.speechEndMs ?? it.durationMs;
      const words = usable(a)
        ? a.words
            // 被打断的句子：从截止点开始的词（续接）没播。留几毫秒余量，免得取整误差把下一个词带进来
            .filter((w) => w.s < speechEnd - 5)
            .map((w) => ({ text: w.t, startMs: it.startMs + w.s, endMs: it.startMs + Math.min(w.e, speechEnd) }))
        : [];
      return {
        idx: it.idx,
        uid: line.uid ?? null,
        kind: line.kind || 'speech',
        speaker: it.speaker,
        text: line.content,
        clean: line.clean ?? null,
        startMs: it.startMs + speechStart,
        endMs: it.startMs + speechEnd,
        clipStartMs: it.startMs,
        cutOff: Boolean(line.cut_off),
        words,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.startMs - b.startMs || a.idx - b.idx);
}

/** 带时间戳的参考转写：[mm:ss.s] 说话人: 原文（非语言声音不进） */
export function timelineText(rows) {
  return rows
    .filter((r) => r.kind !== 'nonspeech' && r.text)
    .map((r) => `[${fmtClock(r.startMs)}] ${r.speaker}: ${r.text}`)
    .join('\n');
}

/** 说话人分离的 GT（RTTM），可以直接喂给 pyannote / dscore 算 DER */
export function timelineRttm(rows, fileId = 'meeting') {
  const id = String(fileId).replace(/\s+/g, '_');
  return rows
    .filter((r) => r.kind !== 'nonspeech')
    .map((r) => {
      const who = String(r.speaker).replace(/\s+/g, '_');
      const start = (r.startMs / 1000).toFixed(3);
      const dur = (Math.max(0, r.endMs - r.startMs) / 1000).toFixed(3);
      return `SPEAKER ${id} 1 ${start} ${dur} <NA> <NA> ${who} <NA> <NA>`;
    })
    .join('\n');
}
