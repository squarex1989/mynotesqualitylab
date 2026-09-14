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
  { id: '', label: '默认音色', gender: 'neutral', note: '不指定 reference_id，用模型自带的声音' },
  { id: '9a9cf47702da476aa4629e2506d4a857', label: 'Energetic Male', gender: 'male', note: 'Fish 官方 quickstart 示例' },
  { id: 'ca3007f96ae7499ab87d27ea3599956a', label: 'E-Girl', gender: 'female', note: 'Fish 官方 quickstart 示例' },
  { id: 'b347db033a6549378b48d00acb0d06cd', label: 'Demo A', gender: 'neutral', note: '公开文档示例音色' },
  { id: '933563129e564b19a115bedd57b7406a', label: 'Demo B', gender: 'neutral', note: 'fish.audio 官网示例音色' },
  { id: '7f92f8afb8ec43bf81429cc1c9199cb1', label: 'Demo C', gender: 'neutral', note: '社区教程引用的公开音色' },
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
    label: '年龄感',
    options: [
      { value: 'young', label: '年轻', tag: 'youthful voice' },
      { value: 'middle', label: '中年', tag: 'middle-aged voice' },
      { value: 'senior', label: '年长', tag: 'elderly voice' },
    ],
  },
  tone: {
    label: '语气',
    options: [
      { value: 'professional', label: '专业冷静', tag: 'composed and professional' },
      { value: 'warm', label: '热情友好', tag: 'warm and friendly' },
      { value: 'tired', label: '疲惫低落', tag: 'tired, low energy, almost sighing' },
      { value: 'excited', label: '兴奋急促', tag: 'excited, slightly breathless' },
      { value: 'authoritative', label: '严肃权威', tag: 'serious and authoritative' },
      { value: 'gentle', label: '温柔耐心', tag: 'gentle and patient' },
      { value: 'sarcastic', label: '讽刺挖苦', tag: 'dry and sarcastic' },
      { value: 'anxious', label: '紧张焦虑', tag: 'anxious and tense' },
      { value: 'casual', label: '随意轻松', tag: 'casual and relaxed' },
      { value: 'deadpan', label: '一本正经', tag: 'deadpan, matter-of-fact' },
    ],
  },
  accent: {
    label: '口音',
    options: [
      // 标准口音不进标签 —— 少说一句总比和音色本身打架好
      { value: 'us', label: '标准美音', tag: '' },
      { value: 'uk', label: '英式口音', tag: 'British accent' },
      { value: 'au', label: '澳洲口音', tag: 'Australian accent' },
      { value: 'in', label: '印度口音', tag: 'Indian English accent' },
      { value: 'scot', label: '苏格兰口音', tag: 'Scottish accent' },
      { value: 'southern', label: '美国南方口音', tag: 'Southern American drawl' },
      { value: 'nyc', label: '纽约口音', tag: 'New York accent' },
      { value: 'mandarin', label: '标准普通话', tag: '标准普通话，播音腔' },
      { value: 'taiwan', label: '台湾腔', tag: '台湾腔，语尾上扬' },
      { value: 'cantonese-mandarin', label: '粤语腔普通话', tag: '带粤语口音的普通话' },
      { value: 'northeast', label: '东北口音', tag: '东北口音' },
      { value: 'sichuan', label: '四川口音', tag: '四川口音' },
    ],
  },
  pace: {
    label: '语速',
    // Fish 有真正的 prosody.speed 参数（0.5–2.0），比塞进标签可靠，
    // 所以这一项不进标签，改为映射成 speed 数值
    options: [
      { value: 'very-slow', label: '很慢', tag: '', speed: 0.7 },
      { value: 'slow', label: '偏慢', tag: '', speed: 0.85 },
      { value: 'normal', label: '正常', tag: '', speed: 1.0 },
      { value: 'fast', label: '偏快', tag: '', speed: 1.18 },
      { value: 'very-fast', label: '很快', tag: '', speed: 1.35 },
    ],
  },
  emotion: {
    label: '情绪强度',
    options: [
      { value: 'flat', label: '平淡', tag: 'flat, minimal emotion' },
      { value: 'moderate', label: '适中', tag: '' },
      { value: 'strong', label: '强烈', tag: 'highly expressive' },
    ],
  },
  quirk: {
    label: '说话习惯',
    options: [
      { value: 'none', label: '无', tag: '' },
      { value: 'filler', label: '有口头停顿', tag: 'hesitant, with natural pauses' },
      { value: 'clipped', label: '短促干脆', tag: 'clipped and terse' },
      { value: 'trailing', label: '句尾拖长', tag: 'trailing off at sentence ends' },
      { value: 'emphatic', label: '爱强调重点', tag: 'emphasizing the key word' },
      { value: 'smiling', label: '带着笑意', tag: 'smiling' },
      { value: 'whisper', label: '压低声音', tag: 'half-whispering' },
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
