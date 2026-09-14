// 把 lines + 音频时长 + 房间基调，排成一条带绝对偏移量的时间线。
// 所有设备拿到同一份 schedule，各自只播 deviceId 等于自己的那些条目。

const MIN_OVERLAP_MS = 400;

/**
 * @param {object} room      rooms 表的一行
 * @param {Array}  lines     [{idx, speaker, content}]
 * @param {Map}    speakerMap speaker -> {voice, instructions, device_id}
 * @param {Map}    audioMap  idx -> {hash, durationMs}
 * @param {string} fallbackDevice 没分配设备的角色兜底到谁（host）
 */
export function buildSchedule(room, lines, speakerMap, audioMap, fallbackDevice) {
  const chaotic = room.order_mode === 'chaotic';
  const gap = room.gap_ms ?? 450;
  const period = room.chaos_period_ms ?? 20000;
  const duckGain = room.duck_gain ?? 0.5;

  const items = [];
  let lastChaosAt = 0; // 上一次抢话发生在时间线的哪一刻；从 0 起算，所以第一次抢话在 ~20s 后

  for (const line of lines) {
    const audio = audioMap.get(line.idx);
    if (!audio) continue; // 还没生成好的直接跳过，开始前会拦住，这里只是防御

    const sp = speakerMap.get(line.speaker);
    const deviceId = sp?.device_id || fallbackDevice || null;
    const duration = audio.durationMs;

    if (items.length === 0) {
      items.push({
        idx: line.idx,
        speaker: line.speaker,
        deviceId,
        hash: audio.hash,
        startMs: 0,
        durationMs: duration,
        overlapMs: 0,
        duckFromMs: null,
        duckGain,
      });
      continue;
    }

    const prev = items[items.length - 1];
    const prevEnd = prev.startMs + prev.durationMs;

    let overlap = 0;
    // 同一台设备不能自己抢自己的话 —— 一个人不会同时说两句
    const differentDevice = deviceId && prev.deviceId && deviceId !== prev.deviceId;

    // 周期上加 ±25% 抖动：否则句长规整的脚本会让抢话总是落在同一个角色头上
    const jittered = period * (0.75 + Math.random() * 0.5);

    // 抢话只能发生在句子交界处，所以实际间隔一定会被句长“量化”。
    // 如果一律等到跨过周期才触发，就永远是向上取整 —— 设成 20 秒会跑成 30 秒一次。
    // 允许提前半句触发，让它落到离目标最近的那个交界上。
    const tolerance = prev.durationMs / 2;

    if (chaotic && differentDevice && prevEnd - lastChaosAt >= jittered - tolerance) {
      const wanted = 1000 + Math.random() * 2000; // 提前 1-3 秒开口
      overlap = Math.round(Math.min(wanted, prev.durationMs * 0.6, duration * 0.8));
      if (overlap < MIN_OVERLAP_MS) {
        overlap = 0; // 前一句太短，压不出抢话感，留到下一次机会
      } else {
        lastChaosAt = prevEnd;
      }
    }

    const startMs = Math.round(overlap > 0 ? prevEnd - overlap : prevEnd + gap);

    if (overlap > 0) {
      // 被抢的那句从重叠开始处压低音量。这里必须和 startMs 用同一个取整后的
      // overlap，否则客户端算出的压音点会和下一句的起点差上零点几毫秒。
      prev.duckFromMs = Math.max(0, prev.durationMs - overlap);
    }

    items.push({
      idx: line.idx,
      speaker: line.speaker,
      deviceId,
      hash: audio.hash,
      startMs,
      durationMs: duration,
      overlapMs: overlap,
      duckFromMs: null,
      duckGain,
    });
  }

  const totalMs = items.reduce((max, it) => Math.max(max, it.startMs + it.durationMs), 0);
  const overlaps = items.filter((i) => i.overlapMs > 0).length;

  return { items, totalMs, overlaps };
}
