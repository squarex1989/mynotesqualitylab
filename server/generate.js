import { EventEmitter } from 'node:events';
import { ensureAudio } from './tts.js';
import { lineTargets, generationProgress } from './rooms.js';

export const genEvents = new EventEmitter();

const CONCURRENCY = Math.max(1, Number(process.env.TTS_CONCURRENCY) || 4);

/** roomId -> { running, rerun, failures: Map<idx, string> } */
const jobs = new Map();

export function jobStatus(roomId) {
  const job = jobs.get(roomId);
  const progress = generationProgress(roomId);
  return {
    ...progress,
    generating: Boolean(job?.running),
    failures: job ? [...job.failures.entries()].map(([idx, message]) => ({ idx, message })) : [],
  };
}

function emit(roomId) {
  genEvents.emit('progress', roomId, jobStatus(roomId));
}

/**
 * 补齐这个房间所有缺失的音频。
 * 已经在跑就只打个标记 —— 跑完会再扫一遍，把期间改过的角色带上。
 */
export function ensureGeneration(roomId) {
  let job = jobs.get(roomId);
  if (job?.running) {
    job.rerun = true;
    return;
  }
  job = { running: true, rerun: false, failures: job?.failures ?? new Map() };
  jobs.set(roomId, job);
  run(roomId, job).catch((err) => {
    console.error(`[generate] room ${roomId} 崩了:`, err);
    job.running = false;
    emit(roomId);
  });
}

async function run(roomId, job) {
  do {
    job.rerun = false;

    const targets = lineTargets(roomId);
    const progress = generationProgress(roomId);
    const missing = targets.filter((t, i) => t.hash && !progress.mask[i]);

    // 之前失败的，这一轮重新试一次
    job.failures.clear();
    emit(roomId);

    if (missing.length) {
      let cursor = 0;
      let done = 0;
      let lastEmit = 0;

      const worker = async () => {
        while (cursor < missing.length) {
          const target = missing[cursor++];
          try {
            await ensureAudio({
              voice: target.voice,
              instructions: target.instructions,
              speed: target.speed,
              text: target.content,
            });
          } catch (err) {
            const message = err?.message || String(err);
            job.failures.set(target.idx, message);
            console.error(`[generate] ${roomId} 第 ${target.idx + 1} 句失败: ${message}`);
          }
          done++;
          // 每完成 1 句或每 500ms 推一次进度，别把 socket 打满
          const now = Date.now();
          if (now - lastEmit > 400 || done === missing.length) {
            lastEmit = now;
            emit(roomId);
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, missing.length) }, () => worker())
      );
    }

    emit(roomId);
  } while (job.rerun);

  job.running = false;
  emit(roomId);
}
