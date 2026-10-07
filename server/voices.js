// 音色表 + 朗读语速。
//
// 这里刻意只剩两样东西：挑哪个音色、读多快。
//
// 早先版本还有年龄感 / 语气 / 口音 / 情绪 / 说话习惯五个下拉，会拼成一段
// [方括号标签] 贴在台词前面。去掉是因为音色现在是从 fish.audio 上按耳朵挑的 ——
// 每个音色本身就有确定的性格，再叠一层「专业冷静 + 英式口音」只会和它打架。
// 角色之间的差异靠换音色，不靠给同一个音色贴标签。
//
// 于是 instructions 恒为空字符串，tts.js 那边就不会往正文前面拼任何东西。

import { VOICE_LIBRARY } from './voice-library.js';

import { VOICE_TAGS } from './voice-tags.js';

// 音色库按国家（语种）分组，见 voice-library.js。展平成一张表，
// 每条带上所属国家，前端先选国家、再从该国家的音色里选。

// 标签里的国家 / 语种名不展示 —— 国家已经是上一级下拉了
const COUNTRY_TAGS = new Set([
  'chinese', 'english', 'french', 'german', 'japanese', 'portuguese',
  'brazilian portuguese', 'spanish', 'italian', 'dutch',
]);
const ACCENT_RE = /accent|taiwanese|british/i;
const MAX_TAGS = 4;

/**
 * 展示用标签：最多 4 个，口音一律排在最后（单独返回，前端放括号里）。
 * 人工标注的 accent 优先于 fish.audio 标签里的口音。
 */
function describe(v) {
  const raw = VOICE_TAGS[v.id]?.tags ?? [];
  const accents = v.accent ? [v.accent] : raw.filter((t) => ACCENT_RE.test(t));
  const plain = raw.filter((t) => !ACCENT_RE.test(t) && !COUNTRY_TAGS.has(t.toLowerCase()));
  return { tags: plain.slice(0, MAX_TAGS - accents.length), accents };
}

/** fish.audio 标签里第一个出现的 male / female；都没有算 neutral */
function genderOf(v) {
  const raw = VOICE_TAGS[v.id]?.tags ?? [];
  return raw.find((t) => t === 'male' || t === 'female') || 'neutral';
}

// 每个国家内：带口音的排在后面，别让口音音色成为默认的第一个
const ALL_VOICES = VOICE_LIBRARY.flatMap((c) => {
  const items = c.voices.map((v) => ({ v, ...describe(v) }));
  const sorted = [...items.filter((x) => !x.accents.length), ...items.filter((x) => x.accents.length)];
  return sorted.map(({ v, tags, accents }, i) => ({
    id: v.id,
    label: `${c.label} ${i + 1}`,
    gender: genderOf(v),
    note: accents.join(', '),
    tags,
    accents,
    country: c.code,
    languages: [c.code],
  }));
});

const COUNTRIES = VOICE_LIBRARY.map((c) => ({
  code: c.code,
  label: c.label,
  labelZh: c.labelZh,
  count: c.voices.length,
}));

export function voices() {
  return ALL_VOICES;
}

export function countries() {
  return COUNTRIES;
}

// 只剩语速这一个维度。speed 是 Fish 的真参数（prosody.speed，范围 0.5–2.0），
// 不是塞进文本的提示词。
export const DIMENSIONS = {
  pace: {
    label: 'Pace',
    options: [
      { value: 'normal', label: 'Normal', speed: 1.0 },
      { value: 'fast', label: 'Fast', speed: 1.18 },
    ],
  },
};

export const DIMENSION_KEYS = Object.keys(DIMENSIONS);

function optionFor(key, value) {
  return DIMENSIONS[key]?.options.find((o) => o.value === value) || null;
}

export function labelFor(key, value) {
  return optionFor(key, value)?.label ?? value;
}

/**
 * 风格标签 —— 现在恒为空。
 * 保留这个函数是因为 speakers 表里还有 instructions 字段、音频哈希也算它，
 * 留着接口不变，将来想加回风格控制时只改这里。
 */
export function buildInstructions() {
  return '';
}

/** 这套配置对应的 prosody.speed（Fish 允许 0.5–2.0） */
export function speedFor(config) {
  const s = optionFor('pace', config?.pace)?.speed;
  return Number.isFinite(s) ? s : 1;
}

function pick(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

/** 随机生成一个角色配置。优先挑还没被占用的音色，免得一屋子人是同一个声音。 */
export function randomSpeakerConfig({ avoidVoices = [], rng = Math.random } = {}) {
  const all = voices();
  const fresh = all.filter((v) => !avoidVoices.includes(v.id));
  const voice = pick(fresh.length ? fresh : all, rng).id;
  return { voice, config: { pace: 'normal' }, instructions: buildInstructions() };
}

/** 把任意输入规整成合法配置，非法值回落到第一个选项。 */
export function normalizeConfig(input = {}) {
  const out = {};
  for (const key of DIMENSION_KEYS) {
    const dim = DIMENSIONS[key];
    const hit = dim.options.find((o) => o.value === input[key]);
    out[key] = hit ? hit.value : dim.options[0].value;
  }
  return out;
}

/** 音色 ID 必须在当前音色表里；不在就回落到第一个 */
export function normalizeVoice(voice) {
  const all = voices();
  return all.some((v) => v.id === voice) ? voice : all[0].id;
}
