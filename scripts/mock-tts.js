// 本地假 Fish Audio，用来在不花额度的前提下跑通整条链路。
// 它模拟真实接口的契约：/v1/tts、msgpack 请求体、model 请求头、mp3 输出。
// 返回的是合法的静音 MP3，时长按文本长度估，所以排期、抢话、重叠、缓存都能验证。
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

    // 方括号标签不会被读出来，估时长时要先去掉
    const spoken = text.replace(/^\s*\[[^\]]*\]\s*/, '');
    const tag = /^\s*\[([^\]]*)\]/.exec(text)?.[1];

    // 中文按 4.5 字/秒，拉丁词按 0.32 秒/词，两者分开数 —— 混排时才不会互相减掉
    const cjk = (spoken.match(/[一-鿿぀-ヿ]/g) || []).length;
    const latinWords = (spoken.replace(/[一-鿿぀-ヿ]/g, ' ').match(/[A-Za-z0-9']+/g) || []).length;
    const speed = payload.prosody?.speed || 1;
    const seconds = Math.max(1.2, (cjk / 4.5 + latinWords * 0.32) / speed);

    count++;
    console.log(
      `[mock-fish] #${count} model=${model} voice=${payload.reference_id || '(默认)'} ` +
        `speed=${speed} ${spoken.length}字 -> ${seconds.toFixed(1)}s` +
        (tag ? ` | 标签[${tag}]` : ' | 无标签')
    );

    const buf = silentMp3(seconds);
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': buf.length });
    res.end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-fish] http://127.0.0.1:${PORT}  （给 FISH_BASE_URL 用）`);
});
