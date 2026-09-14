// 本地假 TTS，用来在不花 API 额度的前提下跑通整条链路。
// 返回的是静音 PCM，格式和 Gemini TTS 真实返回的一模一样
// （audio/pcm;rate=24000;channels=1，16-bit 小端裸流，没有文件头），
// 时长按文本长度估，所以排期、抢话、重叠、缓存都能真实验证。
//
//   node scripts/mock-tts.js            # 另开一个终端
//   OPENROUTER_API_KEY=mock-key-for-local-testing-only \
//     OPENROUTER_BASE_URL=http://127.0.0.1:4010/v1 npm run dev

import http from 'node:http';

const PORT = Number(process.env.MOCK_TTS_PORT) || 4010;

const RATE = 24000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;

function silentPcm(seconds) {
  // 全零就是静音；长度决定时长，这才是被测代码真正依赖的东西
  const bytes = Math.max(1, Math.round(seconds * RATE * CHANNELS * BYTES_PER_SAMPLE));
  return Buffer.alloc(bytes - (bytes % (CHANNELS * BYTES_PER_SAMPLE)));
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
    let format = 'pcm';
    try {
      const json = JSON.parse(body);
      input = json.input || '';
      voice = json.voice || '?';
      format = json.response_format || 'pcm';
    } catch {
      /* 无所谓 */
    }

    // 真实的 Gemini TTS 只收 pcm，mp3 会被 400 顶回来。mock 照样拒绝，
    // 否则本地测试会掩盖这个问题。
    if (format !== 'pcm') {
      const msg = JSON.stringify({
        error: { message: `Gemini TTS only supports response_format="pcm". Got "${format}".` },
      });
      console.log(`[mock-tts] 拒绝 response_format=${format}`);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(msg);
      return;
    }

    // 方括号标签不会被读出来，估时长时要先去掉，否则和真实时长差一截
    const spoken = input.replace(/^\s*\[[^\]]*\]\s*/, '');
    // 中文按 4.5 字/秒，拉丁词按 0.32 秒/词，两者分开数 —— 混排的时候才不会互相减掉
    const cjk = (spoken.match(/[一-鿿぀-ヿ]/g) || []).length;
    const latinWords = (spoken.replace(/[一-鿿぀-ヿ]/g, ' ').match(/[A-Za-z0-9']+/g) || [])
      .length;
    const seconds = Math.max(1.2, cjk / 4.5 + latinWords * 0.32);

    count++;
    const tag = /^\[([^\]]*)\]/.exec(input)?.[1];
    console.log(
      `[mock-tts] #${count} voice=${voice} ${input.length}字 -> ${seconds.toFixed(1)}s` +
        (tag ? ` | 标签[${tag}]` : ' | 无标签')
    );

    const buf = silentPcm(seconds);
    res.writeHead(200, {
      'content-type': `audio/pcm;rate=${RATE};channels=${CHANNELS}`,
      'content-length': buf.length,
    });
    res.end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-tts] http://127.0.0.1:${PORT}/v1  (给 OPENAI_BASE_URL 用)`);
});
