// 按 id 从 fish.audio 拉音色库里每个音色的标签，写成 server/voice-tags.json。
//
//   node scripts/fetch-voice-tags.mjs
//
// GET /model/{id} 对公开音色不需要 key；设了 FISH_API_KEY 就会带上。
// 改了 server/voice-library.js 里的 id 之后重跑一次即可。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VOICE_LIBRARY } from '../server/voice-library.js';

const BASE_URL = (process.env.FISH_BASE_URL || 'https://api.fish.audio').replace(/\/$/, '');
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../server/voice-tags.json');
const headers = process.env.FISH_API_KEY ? { authorization: `Bearer ${process.env.FISH_API_KEY}` } : {};

const out = {};
let failed = 0;
for (const { voices } of VOICE_LIBRARY) {
  for (const { id } of voices) {
    try {
      const res = await fetch(`${BASE_URL}/model/${id}`, { headers, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const v = await res.json();
      out[id] = { title: v.title || '', tags: Array.isArray(v.tags) ? v.tags : [] };
      console.log(`✓ ${id}  ${out[id].tags.length} tags`);
    } catch (err) {
      failed++;
      console.log(`✗ ${id}  ${err.message}`);
    }
  }
}
if (failed) {
  console.error(`${failed} 个没拉到，没有写文件。`);
  process.exit(1);
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`已写入 ${OUT}`);
