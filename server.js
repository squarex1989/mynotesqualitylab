import http from 'node:http';
import os from 'node:os';
import express from 'express';
import next from 'next';
import { db, DATA_DIR, storageInfo } from './server/db.js';
import { createApiRouter } from './server/api.js';
import { attachRealtime } from './server/realtime.js';
import { apiKeyProblem, DEFAULT_TTS_MODEL } from './server/tts.js';

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
  const store = storageInfo();
  console.log(`  数据目录: ${store.dir}`);
  if (store.dbExisted) {
    console.log(`            沿用上次的数据 · ${store.audioCount} 个音频 · 这块盘首次使用于 ${store.firstBootAt}`);
  } else {
    console.log('            这是一块空盘，数据库刚建出来');
    if (process.env.NODE_ENV === 'production') {
      console.log('            ⚠️  如果这不是第一次部署，说明持久卷没挂上 —— 检查卷的');
      console.log(`            ⚠️  Mount path 是不是正好等于 DATA_DIR（现在是 ${store.dir}）。`);
      console.log('            ⚠️  没挂上的话每次重部署，整份 transcript 都要重新 TTS 一遍。');
    }
  }
  console.log(`  TTS: Fish Audio · 新房间默认用 ${DEFAULT_TTS_MODEL}（房间设置里可切换）`);

  const problem = apiKeyProblem();
  if (problem) {
    console.log('');
    console.log(`  ⚠️  ${problem}`);
    console.log('     可以建房间、上传 transcript、调音色，但点「合成音频」会失败。');
    console.log(`     在项目根目录的 .env 里写上真正的 key，然后重启：`);
    console.log('       FISH_API_KEY=...');
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
