// 本地假 Fish Audio，用来在不花额度的前提下跑通整条链路。
// 它模拟真实接口的契约：/v1/tts、msgpack 请求体、model 请求头、mp3 输出。
// 返回的是合法的静音 MP3，时长按文本长度估，所以排期、抢话、重叠、缓存都能验证。
//
// /v1/tts/stream/with-timestamp 也有：SSE，每个事件一块 base64 音频 + 该 chunk_seq 的
// 累积对齐快照（后一个替换前一个），逐词时间按同样的语速估。首尾各留一段静音，
// 和真实音频一样 —— 排期必须按「说话」而不是按「文件」算，这一点才测得出来。
//
//   node scripts/mock-tts.js            # 另开一个终端
//   FISH_API_KEY=mock-key-for-local-testing-only \
//     FISH_BASE_URL=http://127.0.0.1:4010 npm run dev

import http from 'node:http';
import { decode as msgpackDecode } from '@msgpack/msgpack';

const PORT = Number(process.env.MOCK_TTS_PORT) || 4010;

// MPEG-1 Layer III / 128kbps / 44.1kHz / stereo —— 每帧 417 字节、1152 个采样
const FRAME = Buffer.alloc(417);
FRAME[0] = 0xff;
FRAME[1] = 0xfb;
FRAME[2] = 0x90;
FRAME[3] = 0x00;
const FRAME_SEC = 1152 / 44100;

function silentMp3(seconds) {
  const frames = Math.max(1, Math.round(seconds / FRAME_SEC));
  return Buffer.concat(Array.from({ length: frames }, () => FRAME));
}

let count = 0;

const fail = (res, status, message) => {
  console.log(`[mock-fish] ${status} ${message}`);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ message }));
};

// 估时用的语速：中文 4.5 字/秒，拉丁词 0.32 秒/词
const CJK_SEC = 1 / 4.5;
const WORD_SEC = 0.32;
const LEAD_SEC = 0.15; // 开口前的静音
const TAIL_SEC = 0.25; // 说完后的静音

/** 去掉 [标签] 后切成「词」：中日文一个字一个词，拉丁字母数字连在一起算一个词（不带标点，和 Fish 一样） */
function tokensOf(text) {
  const spoken = text.replace(/\[[^\]]*\]/g, ' ');
  return spoken.match(/[一-鿿぀-ヿ]|[A-Za-z0-9']+/g) || [];
}

function timedWords(text, speed) {
  let t = LEAD_SEC;
  return tokensOf(text).map((tok) => {
    const d = (/[一-鿿぀-ヿ]/.test(tok) ? CJK_SEC : WORD_SEC) / speed;
    const w = { text: tok.replace(/'/g, ''), start: +t.toFixed(3), end: +(t + d).toFixed(3) };
    t += d;
    return w;
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.startsWith('/v1/tts')) {
    return fail(res, 404, `没有这个端点：${req.method} ${req.url}`);
  }
  if (!(req.headers.authorization || '').startsWith('Bearer ')) {
    return fail(res, 401, '缺少 Authorization: Bearer <key>');
  }
  // 真实接口用 model 请求头选模型，body 里没有这一项 —— 少传会拿不到预期结果
  const model = req.headers.model;
  if (!model) return fail(res, 400, '缺少 model 请求头');

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const ct = req.headers['content-type'] || '';

    let payload;
    if (ct.includes('msgpack')) {
      try {
        payload = msgpackDecode(body);
      } catch (err) {
        return fail(res, 400, `msgpack 解不开：${err.message}`);
      }
    } else {
      // 真实接口的 SDK 只发 msgpack。这里明确拒绝 JSON，
      // 免得本地能跑、线上却不行。
      return fail(res, 415, `content-type 必须是 application/msgpack，收到 ${ct || '(空)'}`);
    }

    const text = String(payload?.text ?? '');
    if (!text) return fail(res, 400, 'text 是空的');

    const fmt = payload.format || 'mp3';
    if (fmt !== 'mp3') return fail(res, 400, `这个 mock 只实现了 mp3，收到 ${fmt}`);

    // 方括号标签不会被读出来（开头的风格标签、句中的 [break] 都一样），估时长时要先去掉
    const spoken = text.replace(/\[[^\]]*\]/g, ' ').trim();
    const tag = /^\s*\[([^\]]*)\]/.exec(text)?.[1];

    // 中文按 4.5 字/秒，拉丁词按 0.32 秒/词，两者分开数 —— 混排时才不会互相减掉
    const speed = payload.prosody?.speed || 1;
    const words = timedWords(text, speed);
    const speechEnd = words.length ? words[words.length - 1].end : LEAD_SEC;
    const seconds = Math.max(1.2, speechEnd + TAIL_SEC);

    count++;
    console.log(
      `[mock-fish] #${count} model=${model} voice=${payload.reference_id || '(默认)'} ` +
        `speed=${speed} ${spoken.length}字 -> ${seconds.toFixed(1)}s` +
        (tag ? ` | 标签[${tag}]` : ' | 无标签')
    );

    const buf = silentMp3(seconds);

    if (req.url.startsWith('/v1/tts/stream/with-timestamp')) {
      // 切成三块发：前两块的快照只覆盖一部分词，最后一块才完整 —— 客户端必须「替换」而不是「追加」
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const parts = 3;
      const step = Math.ceil(buf.length / 417 / parts) * 417;
      for (let i = 0; i < parts; i++) {
        const chunk = buf.subarray(i * step, Math.min(buf.length, (i + 1) * step));
        if (!chunk.length) continue;
        const upto = i === parts - 1 ? words.length : Math.floor((words.length * (i + 1)) / parts);
        const event = {
          audio_base64: chunk.toString('base64'),
          content: text,
          chunk_seq: 0,
          chunk_audio_offset_sec: 0,
          alignment: { audio_duration: +seconds.toFixed(3), segments: words.slice(0, upto) },
        };
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      return res.end();
    }

    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': buf.length });
    res.end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-fish] http://127.0.0.1:${PORT}  （给 FISH_BASE_URL 用）`);
});
