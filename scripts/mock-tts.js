// 本地假 TTS，用来在不花 API 额度的前提下跑通整条链路。
// 返回的是合法的静音 MP3，时长按文本长度估，所以排期、抢话、重叠都能真实验证。
//
//   node scripts/mock-tts.js            # 另开一个终端
//   OPENAI_API_KEY=mock OPENAI_BASE_URL=http://127.0.0.1:4010/v1 npm run dev

import http from 'node:http';

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

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.includes('/audio/speech')) {
    res.writeHead(404).end();
    return;
  }

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let input = '';
    let voice = '?';
    try {
      const json = JSON.parse(body);
      input = json.input || '';
      voice = json.voice || '?';
    } catch {
      /* 无所谓 */
    }

    // 中文按 4.5 字/秒，拉丁词按 0.32 秒/词，两者分开数 —— 混排的时候才不会互相减掉
    const cjk = (input.match(/[一-鿿぀-ヿ]/g) || []).length;
    const latinWords = (input.replace(/[一-鿿぀-ヿ]/g, ' ').match(/[A-Za-z0-9']+/g) || [])
      .length;
    const seconds = Math.max(1.2, cjk / 4.5 + latinWords * 0.32);

    count++;
    console.log(`[mock-tts] #${count} voice=${voice} ${input.length}字 -> ${seconds.toFixed(1)}s`);

    const buf = silentMp3(seconds);
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': buf.length });
    res.end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-tts] http://127.0.0.1:${PORT}/v1  (给 OPENAI_BASE_URL 用)`);
});
