// Fish Audio S2.1-Pro 的音色表，以及「年龄感 / 语气 / 口音 / 语速 / 情绪 /
// 说话习惯」怎么被拼成风格标签。
//
// Fish 的风格控制没有独立参数 —— 靠一段 [方括号标签] 拼在台词前面，
// 方括号里可以写任意自然语言，标签本身不会被读出来。所以这里每个选项给的是
// 一个短语，最后用逗号连成一行。语速是例外：Fish 有真正的 prosody.speed 参数，
// 比塞进标签可靠，所以它不进标签（tag 留空）。
//
// 这里没有「性别」：性别由 voice 本身决定，再在标签里写一句 "a male speaker"
// 只会和音色打架。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.js';

const VOICES_FILE = path.join(DATA_DIR, 'voices.fish.json');

// Fish 没有官方的具名音色表 —— voice 是 fish.audio 音色库里的 32 位十六进制
// reference_id。想要一份带描述和标签的表，跑一次：
//     node --env-file-if-exists=.env scripts/fetch-fish-voices.mjs
// 它会从公开库拉回来写进 data/voices.fish.json。
//
// 下面这几个是从 Fish / OpenRouter 的公开文档里找到的公开音色，只是兜底，
// 让项目在还没拉音色表时也能跑起来。我验证过它们经 API 不会被拒（不存在的
// ID 会返回 400），但没法确认各自听起来什么样。
const FALLBACK_VOICES = [
  { id: '', label: 'Default voice', gender: 'neutral', note: "No reference_id — the model's own voice" },
  { id: '9a9cf47702da476aa4629e2506d4a857', label: 'Energetic Male', gender: 'male', note: 'Fish quickstart sample' },
  { id: 'ca3007f96ae7499ab87d27ea3599956a', label: 'E-Girl', gender: 'female', note: 'Fish quickstart sample' },
  { id: 'b347db033a6549378b48d00acb0d06cd', label: 'Demo A', gender: 'neutral', note: 'From public docs' },
  { id: '933563129e564b19a115bedd57b7406a', label: 'Demo B', gender: 'neutral', note: 'From fish.audio docs' },
  { id: '7f92f8afb8ec43bf81429cc1c9199cb1', label: 'Demo C', gender: 'neutral', note: 'From a community tutorial' },
];

let cache = null;
let cacheMtime = 0;

/** 当前可用音色表。文件改了会自动重新读，不用重启。 */
export function voices() {
  try {
    const stat = fs.statSync(VOICES_FILE);
    if (cache && stat.mtimeMs === cacheMtime) return cache;

    const parsed = JSON.parse(fs.readFileSync(VOICES_FILE, 'utf8'));
    const clean = (Array.isArray(parsed) ? parsed : parsed.voices || [])
      .filter((v) => v && typeof v.id === 'string' && v.label)
      .map((v) => ({
        id: v.id.trim(),
        label: String(v.label),
        gender: ['male', 'female', 'neutral'].includes(v.gender) ? v.gender : 'neutral',
        note: String(v.note || ''),
        tags: Array.isArray(v.tags) ? v.tags : [],
        languages: Array.isArray(v.languages) ? v.languages : [],
      }));

    if (clean.length) {
      cache = clean;
      cacheMtime = stat.mtimeMs;
      return cache;
    }
    console.warn(`[voices] ${VOICES_FILE} 里没有有效音色，用内置兜底表`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[voices] 读取 ${VOICES_FILE} 失败：${err.message}，用内置兜底表`);
    }
  }
  return FALLBACK_VOICES;
}

export function usingFallbackVoices() {
  return !fs.existsSync(VOICES_FILE);
}

// 每个维度：value 给机器，label 给 UI，tag 拼进方括号（空字符串 = 这一项不进标签）
export const DIMENSIONS = {
  age: {
    label: 'Age',
    options: [
      { value: 'young', label: 'Young', tag: 'youthful voice' },
      { value: 'middle', label: 'Middle-aged', tag: 'middle-aged voice' },
      { value: 'senior', label: 'Older', tag: 'elderly voice' },
    ],
  },
  tone: {
    label: 'Tone',
    options: [
      { value: 'professional', label: 'Professional', tag: 'composed and professional' },
      { value: 'warm', label: 'Warm', tag: 'warm and friendly' },
      { value: 'tired', label: 'Tired', tag: 'tired, low energy, almost sighing' },
      { value: 'excited', label: 'Excited', tag: 'excited, slightly breathless' },
      { value: 'authoritative', label: 'Authoritative', tag: 'serious and authoritative' },
      { value: 'gentle', label: 'Gentle', tag: 'gentle and patient' },
      { value: 'sarcastic', label: 'Sarcastic', tag: 'dry and sarcastic' },
      { value: 'anxious', label: 'Anxious', tag: 'anxious and tense' },
      { value: 'casual', label: 'Casual', tag: 'casual and relaxed' },
      { value: 'deadpan', label: 'Deadpan', tag: 'deadpan, matter-of-fact' },
    ],
  },
  accent: {
    label: 'Accent',
    options: [
      // 标准口音不进标签 —— 少说一句总比和音色本身打架好
      { value: 'us', label: 'General American', tag: '' },
      { value: 'uk', label: 'British', tag: 'British accent' },
      { value: 'au', label: 'Australian', tag: 'Australian accent' },
      { value: 'in', label: 'Indian English', tag: 'Indian English accent' },
      { value: 'scot', label: 'Scottish', tag: 'Scottish accent' },
      { value: 'southern', label: 'Southern US', tag: 'Southern American drawl' },
      { value: 'nyc', label: 'New York', tag: 'New York accent' },
      { value: 'mandarin', label: 'Mandarin (standard)', tag: '标准普通话，播音腔' },
      { value: 'taiwan', label: 'Mandarin (Taiwan)', tag: '台湾腔，语尾上扬' },
      { value: 'cantonese-mandarin', label: 'Mandarin (Cantonese accent)', tag: '带粤语口音的普通话' },
      { value: 'northeast', label: 'Mandarin (Northeastern)', tag: '东北口音' },
      { value: 'sichuan', label: 'Mandarin (Sichuan)', tag: '四川口音' },
    ],
  },
  pace: {
    label: 'Pace',
    // Fish 有真正的 prosody.speed 参数（0.5–2.0），比塞进标签可靠，
    // 所以这一项不进标签，改为映射成 speed 数值
    options: [
      { value: 'very-slow', label: 'Very slow', tag: '', speed: 0.7 },
      { value: 'slow', label: 'Slow', tag: '', speed: 0.85 },
      { value: 'normal', label: 'Normal', tag: '', speed: 1.0 },
      { value: 'fast', label: 'Fast', tag: '', speed: 1.18 },
      { value: 'very-fast', label: 'Very fast', tag: '', speed: 1.35 },
    ],
  },
  emotion: {
    label: 'Emotion',
    options: [
      { value: 'flat', label: 'Flat', tag: 'flat, minimal emotion' },
      { value: 'moderate', label: 'Moderate', tag: '' },
      { value: 'strong', label: 'Strong', tag: 'highly expressive' },
    ],
  },
  quirk: {
    label: 'Delivery quirk',
    options: [
      { value: 'none', label: 'None', tag: '' },
      { value: 'filler', label: 'Hesitant pauses', tag: 'hesitant, with natural pauses' },
      { value: 'clipped', label: 'Clipped', tag: 'clipped and terse' },
      { value: 'trailing', label: 'Trailing off', tag: 'trailing off at sentence ends' },
      { value: 'emphatic', label: 'Emphatic', tag: 'emphasizing the key word' },
      { value: 'smiling', label: 'Smiling', tag: 'smiling' },
      { value: 'whisper', label: 'Half-whisper', tag: 'half-whispering' },
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
 * 把下拉配置拼成方括号里的那段文字。几个短语用逗号连成一行 ——
 * 调用时会变成 `[youthful voice, dry and sarcastic, brisk] 台词内容`。
 */
export function buildInstructions(config) {
  return DIMENSION_KEYS.map((key) => optionFor(key, config[key])?.tag)
    .filter(Boolean)
    .join(', ');
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

  const config = {
    age: pick(DIMENSIONS.age.options, rng).value,
    tone: pick(DIMENSIONS.tone.options, rng).value,
    // 口音随机时偏向“无口音”，否则整屋子人都在飙口音，听起来像杂技
    accent: rng() < 0.55 ? 'us' : pick(DIMENSIONS.accent.options, rng).value,
    pace: pick(
      DIMENSIONS.pace.options.filter((o) => o.value !== 'very-fast' && o.value !== 'very-slow'),
      rng
    ).value,
    emotion: pick(DIMENSIONS.emotion.options, rng).value,
    quirk: rng() < 0.6 ? 'none' : pick(DIMENSIONS.quirk.options, rng).value,
  };

  return { voice, config, instructions: buildInstructions(config) };
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

export function normalizeVoice(voice) {
  const all = voices();
  return all.some((v) => v.id === voice) ? voice : all[0].id;
}
