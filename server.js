import http from 'node:http';
import os from 'node:os';
import express from 'express';
import next from 'next';
import { db, DATA_DIR } from './server/db.js';
import { createApiRouter } from './server/api.js';
import { attachRealtime } from './server/realtime.js';
import { apiKeyProblem, TTS_MODEL } from './server/tts.js';

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT) || 3000;

// 上一次进程留下的“在线设备”和“播放中”都是假的，启动时清掉
db.exec("UPDATE devices SET online = 0");
db.exec("UPDATE rooms SET status = 'idle'");

const nextApp = next({ dev });
const handle = nextApp.getRequestHandler();

await nextApp.prepare();

const app = express();
const httpServer = http.createServer(app);

const { broadcast } = attachRealtime(httpServer);

app.use('/api', createApiRouter({ broadcast }));
app.all('*', (req, res) => handle(req, res));

httpServer.listen(port, '0.0.0.0', () => {
  const urls = ['localhost', ...lanAddresses()].map((h) => `http://${h}:${port}`);
  console.log('');
  console.log('  ReadRoom 已启动');
  urls.forEach((u) => console.log(`    ${u}`));
  console.log(`  数据目录: ${DATA_DIR}`);
  console.log(`  TTS: ${TTS_MODEL}`);

  const problem = apiKeyProblem();
  if (problem) {
    console.log('');
    console.log(`  ⚠️  ${problem}`);
    console.log('     可以建房间、上传 transcript、调音色，但点「合成音频」会失败。');
    console.log(`     在项目根目录的 .env 里写上真正的 key，然后重启：`);
    console.log('       OPENAI_API_KEY=sk-proj-...');
  }
  console.log('');
});

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}
