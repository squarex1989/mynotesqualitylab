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

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.js';

const VOICES_FILE = path.join(DATA_DIR, 'voices.fish.json');

// Fish 没有官方的具名音色表 —— voice 是 fish.audio 音色库里的 32 位十六进制
// reference_id。想要一份带描述和标签的表，跑一次：
//     node scripts/voices-from-ids.mjs <你挑好的 id 们>
// 下面这几个只是兜底，让项目在还没拉音色表时也能跑起来。
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
