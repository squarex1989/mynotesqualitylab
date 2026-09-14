import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { parseBuffer } from 'music-metadata';
import { db, audioPath } from './db.js';

// Fish Audio 原生 API。契约来自官方 SDK（fishaudio/fish-audio-python）：
//
//   POST https://api.fish.audio/v1/tts
//     Authorization: Bearer <FISH_API_KEY>
//     Content-Type: application/msgpack     ← 不是 JSON，body 要 msgpack 打包
//     model: s2.1-pro-free                  ← 模型走请求头。写进 body 会被
//                                              静默忽略，然后你拿到的是默认模型
//
// 和之前经 OpenRouter 的那层比，原生接口多给了两样有用的东西：
//   1. prosody.speed / volume 是真参数，语速不用塞进风格标签
//   2. 输出可以是 mp3，磁盘占用只有 WAV 的九分之一
//
// 实测（scripts/check-fish.mjs，对着真实 API）：JSON 请求体其实也被接受，
// msgpack 不是硬要求。这里仍然照 SDK 走 msgpack —— 以后做声音克隆时
// references 里装的是原始字节，JSON 得 base64。但 JSON 是现成的退路。

const BASE_URL = () => (process.env.FISH_BASE_URL || 'https://api.fish.audio').replace(/\/$/, '');

// 可选模型。免费和付费是同一个模型、同样质量，区别只在 Fair Use 和有无
// 延迟/可用性保证 —— 所以做成房间级开关，随时能切。
export const TTS_MODELS = [
  {
    id: 's2.1-pro-free',
    label: 'Free',
    note: 'Same model and quality as paid. $0 under fair use, no latency or uptime guarantees.',
  },
  {
    id: 's2.1-pro',
    label: 'Paid',
    note: '$15 per 1M UTF-8 bytes, with latency and uptime guarantees.',
  },
];

export const DEFAULT_TTS_MODEL = TTS_MODELS.some((m) => m.id === process.env.FISH_MODEL)
  ? process.env.FISH_MODEL
  : 's2.1-pro-free';

export function normalizeModel(model) {
  return TTS_MODELS.some((m) => m.id === model) ? model : DEFAULT_TTS_MODEL;
}
const MP3_BITRATE = Number(process.env.FISH_MP3_BITRATE) || 128;
// normal = 质量更好，balanced = 更快。朗读场景不在乎首字延迟，选质量
const LATENCY = process.env.FISH_LATENCY || 'normal';

/**
 * key 有没有明显的毛病。HTTP 头只能放 ASCII —— 如果 .env 里还留着
 * 占位符，底层会抛一个看不懂的 ByteString 错误，最后在界面上显示成
 * "Connection error."，让人以为是网络问题。
 * @returns {string|null} 有问题时返回给人看的原因
 */
export function apiKeyProblem(key = process.env.FISH_API_KEY) {
  if (!key) return 'FISH_API_KEY is not set';
  if (/[^\x20-\x7e]/.test(key)) return 'FISH_API_KEY contains non-ASCII characters — looks like the placeholder was never replaced';
  if (key.length < 20) return `FISH_API_KEY is only ${key.length} characters — that does not look like a real key`;
  return null;
}

/**
 * 音频的身份 = 模型 + 音色 + 风格标签 + 语速 + 文本。
 * 任何一项变了就是另一个文件；都没变就直接命中缓存，不再调 API。
 */
export function audioHash({ model, voice, instructions, speed = 1, text }) {
  return crypto
    .createHash('sha256')
    .update(`${normalizeModel(model)}|${voice}|${instructions}|${speed}|${text}`)
    .digest('hex')
    .slice(0, 32);
}

export function lookupAudio(hash) {
  const row = db.prepare('SELECT * FROM audio WHERE hash = ?').get(hash);
  if (!row) return null;
  if (!fs.existsSync(audioPath(hash))) {
    // 文件被手工删了 / 磁盘换了：清掉记录，让它重新生成
    db.prepare('DELETE FROM audio WHERE hash = ?').run(hash);
    return null;
  }
  return row;
}

async function probeDurationMs(buffer) {
  try {
    const meta = await parseBuffer(buffer, { mimeType: 'audio/mpeg' }, { duration: true });
    const sec = meta?.format?.duration;
    if (sec && Number.isFinite(sec)) return Math.round(sec * 1000);
  } catch {
    /* 落到下面的估算 */
  }
  // 兜底：按固定码率估。宁可估长一点，也别让排期把下一句压到前一句身上。
  return Math.max(1000, Math.round((buffer.length / ((MP3_BITRATE * 1000) / 8)) * 1000));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function synthesize({ model, voice, instructions, speed, text }) {
  const problem = apiKeyProblem();
  if (problem) throw new Error(`${problem} — fix .env and restart the server`);

  // S2.1-Pro 的风格控制是 [方括号标签] 拼在正文前面，标签本身不会被读出来
  const payload = {
    text: instructions ? `[${instructions}] ${text}` : text,
    format: 'mp3',
    mp3_bitrate: MP3_BITRATE,
    normalize: true,
    latency: LATENCY,
    chunk_length: 200,
  };
  if (voice) payload.reference_id = voice;
  if (speed && speed !== 1) payload.prosody = { speed, volume: 0 };

  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${BASE_URL()}/v1/tts`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${process.env.FISH_API_KEY}`,
          'content-type': 'application/msgpack',
          model: normalizeModel(model),
        },
        body: msgpackEncode(payload),
        signal: AbortSignal.timeout(120000),
      });

      if (res.ok) {
        const contentType = res.headers.get('content-type') || '';
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length) throw new Error('The API returned 0 bytes of audio');
        // 出错时有些网关会回 JSON 而不是音频，content-type 能识破
        if (contentType.includes('application/json')) {
          throw new Error(`Expected audio, got JSON: ${buf.toString('utf8').slice(0, 200)}`);
        }
        return buf;
      }

      const raw = (await res.text().catch(() => '')) || '';
      let message = raw.slice(0, 300);
      let code = '';
      try {
        const parsed = JSON.parse(raw);
        message = parsed?.message || parsed?.detail || parsed?.error?.message || message;
        code = parsed?.code || parsed?.error?.code || '';
      } catch {
        /* 不是 JSON 就用原文 */
      }

      const err = new Error(message || `HTTP ${res.status}`);
      err.status = res.status;
      err.code = code;
      if (res.status === 429) {
        const after = Number(res.headers.get('retry-after'));
        err.retryAfterMs = Number.isFinite(after) ? after * 1000 : null;
      }
      throw err;
    } catch (err) {
      lastErr = err;
      const status = err?.status;
      // 余额/配额问题重试一万次也不会变好 —— 直接失败，
      // 别让一份长稿在每句上都白等四轮退避。
      const hopeless =
        status === 401 ||
        status === 402 ||
        status === 403 ||
        /insufficient|quota|credit|balance|billing|payment/i.test(
          `${err?.code || ''} ${err?.message || ''}`
        );
      const retryable =
        !hopeless &&
        (status === 429 || status === 408 || (status >= 500 && status < 600) || status === undefined);
      if (!retryable || attempt === 3) break;
      await sleep(err.retryAfterMs ?? 900 * 2 ** attempt + Math.random() * 400);
    }
  }
  throw lastErr;
}

// 同一个 hash 并发请求时只跑一次
const inflight = new Map();

/**
 * 拿到这句话的音频；已缓存就直接返回，没有才调 TTS。
 * @returns {Promise<{hash: string, durationMs: number, cached: boolean}>}
 */
export async function ensureAudio({ model, voice, instructions, speed = 1, text }) {
  const hash = audioHash({ model, voice, instructions, speed, text });

  const hit = lookupAudio(hash);
  if (hit) return { hash, durationMs: hit.duration_ms, cached: true };

  if (inflight.has(hash)) return inflight.get(hash);

  const task = (async () => {
    const buffer = await synthesize({ model, voice, instructions, speed, text });
    const durationMs = await probeDurationMs(buffer);
    const tmp = `${audioPath(hash)}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, buffer);
    await fsp.rename(tmp, audioPath(hash)); // 原子落盘，避免读到写了一半的文件
    db.prepare(
      'INSERT OR REPLACE INTO audio (hash, duration_ms, bytes, created_at) VALUES (?, ?, ?, ?)'
    ).run(hash, durationMs, buffer.length, Date.now());
    return { hash, durationMs, cached: false };
  })().finally(() => inflight.delete(hash));

  inflight.set(hash, task);
  return task;
}
