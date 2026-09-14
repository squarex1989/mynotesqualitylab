import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { db, audioPath } from './db.js';

export const TTS_MODEL = process.env.TTS_MODEL || 'google/gemini-3.1-flash-tts-preview';
const BASE_URL = () =>
  (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');

// /audio/speech 就是「POST JSON、回原始音频字节」一个请求，用 fetch 直连比套 SDK 简单，
// 重试和超时本来也是我们自己控制的。

/**
 * key 有没有明显的毛病。HTTP 头只能放 ASCII —— 如果 .env 里还留着
 * `sk-你的key` 这种占位符，底层会抛一个看不懂的 ByteString 错误，
 * 最后在界面上显示成 "Connection error."，让人以为是网络问题。
 * @returns {string|null} 有问题时返回给人看的原因
 */
export function apiKeyProblem(key = process.env.OPENROUTER_API_KEY) {
  if (!key) return '没有配置 OPENROUTER_API_KEY';
  if (/[^\x20-\x7e]/.test(key))
    return 'OPENROUTER_API_KEY 里有非 ASCII 字符，看起来还是占位符没换成真 key';
  if (key.length < 20) return `OPENROUTER_API_KEY 只有 ${key.length} 个字符，不像是一个真的 key`;
  return null;
}

/**
 * 音频的身份 = 模型 + 音色 + 风格标签 + 文本。
 * 任何一项变了就是另一个文件；都没变就直接命中缓存，不再调 API。
 */
export function audioHash({ voice, instructions, text }) {
  return crypto
    .createHash('sha256')
    .update(`${TTS_MODEL}|${voice}|${instructions}|${text}`)
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gemini TTS 只回 response_format="pcm"：16-bit 小端、裸流、没有任何文件头。
// 浏览器的 decodeAudioData 解不了裸 PCM，所以落盘前套一个 44 字节 WAV 头 ——
// 无损、零依赖，而且时长能按字节数精确算出来，比任何探测都准。
const DEFAULT_RATE = 24000;
const DEFAULT_CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;

/** 从 `audio/pcm;rate=24000;channels=1` 里取出采样率和声道数 */
function parsePcmFormat(contentType) {
  const rate = Number(/rate=(\d+)/i.exec(contentType || '')?.[1]);
  const channels = Number(/channels=(\d+)/i.exec(contentType || '')?.[1]);
  return {
    rate: Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_RATE,
    channels: Number.isFinite(channels) && channels > 0 ? channels : DEFAULT_CHANNELS,
  };
}

function wrapPcmAsWav(pcm, { rate, channels }) {
  const byteRate = rate * channels * BYTES_PER_SAMPLE;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4); // 整个文件减去前 8 字节
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt 块长度
  header.writeUInt16LE(1, 20); // 1 = 无压缩 PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32); // block align
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34); // 位深
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function pcmDurationMs(byteLength, { rate, channels }) {
  return Math.round((byteLength / (rate * channels * BYTES_PER_SAMPLE)) * 1000);
}

async function synthesize({ voice, instructions, text }) {
  const problem = apiKeyProblem();
  if (problem) throw new Error(`${problem} —— 改好 .env 后重启服务`);

  // 这个接口没有 instructions 参数 —— 风格标签得拼在正文前面，
  // 模型据此决定语气，方括号里的内容本身不会被读出来。
  const body = {
    model: TTS_MODEL,
    voice,
    input: instructions ? `[${instructions}] ${text}` : text,
    // Gemini TTS 只认 pcm —— 传 mp3 会被 400 顶回来
    response_format: 'pcm',
  };

  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${BASE_URL()}/audio/speech`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });

      if (res.ok) {
        const contentType = res.headers.get('content-type') || '';
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length) throw new Error('返回了 0 字节音频');
        // 出错时有些网关会回 JSON 而不是音频，content-type 能识破
        if (contentType.includes('application/json')) {
          throw new Error(`期望音频却收到 JSON：${buf.toString('utf8').slice(0, 200)}`);
        }
        return { pcm: buf, format: parsePcmFormat(contentType) };
      }

      const raw = (await res.text().catch(() => '')) || '';
      // OpenAI 的错误体是 JSON，直接甩给用户看是一团括号
      let message = raw.slice(0, 300);
      let code = '';
      try {
        const parsed = JSON.parse(raw);
        message = parsed?.error?.message || message;
        code = parsed?.error?.code || parsed?.error?.type || '';
      } catch {
        /* 不是 JSON 就用原文 */
      }

      const err = new Error(message);
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
      // 余额耗尽 / 配额用完也是 429，但重试一万次也不会变好 —— 直接失败，
      // 别让一份长稿在每句上都白等四轮退避。
      const hopeless = /insufficient_quota|credit_balance_exhausted|billing|insufficient_credits|requires more credits/i.test(
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
export async function ensureAudio({ voice, instructions, text }) {
  const hash = audioHash({ voice, instructions, text });

  const hit = lookupAudio(hash);
  if (hit) return { hash, durationMs: hit.duration_ms, cached: true };

  if (inflight.has(hash)) return inflight.get(hash);

  const task = (async () => {
    const { pcm, format } = await synthesize({ voice, instructions, text });
    const durationMs = pcmDurationMs(pcm.length, format);
    const wav = wrapPcmAsWav(pcm, format);
    const tmp = `${audioPath(hash)}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, wav);
    await fsp.rename(tmp, audioPath(hash)); // 原子落盘，避免读到写了一半的文件
    db.prepare(
      'INSERT OR REPLACE INTO audio (hash, duration_ms, bytes, created_at) VALUES (?, ?, ?, ?)'
    ).run(hash, durationMs, wav.length, Date.now());
    return { hash, durationMs, cached: false };
  })().finally(() => inflight.delete(hash));

  inflight.set(hash, task);
  return task;
}
