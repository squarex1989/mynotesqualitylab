// 从 Fish Audio 的公开音色库拉一份音色表，写到 $DATA_DIR/voices.fish.json。
//
// 默认挑「像在开会说话」的声音：对话感、自然，不是专业播音，也不是动漫角色音。
// Fish 的标签体系里没有「会议」这一类，所以做法是拉一个大池子、按标签和描述
// 正负打分，再按语种 × 性别配额挑（见 scripts/lib/voice-filter.mjs）。
//
//   node scripts/fetch-fish-voices.mjs
//   node scripts/fetch-fish-voices.mjs --language en,zh,ja,de,fr,es --per-bucket 3
//   node scripts/fetch-fish-voices.mjs --style any          # 不筛，纯按热度
//   node scripts/fetch-fish-voices.mjs --explain            # 打印每个音色的命中词
//
// 本机连不上 api.fish.audio 时，在 Railway 的 Console 里跑（详见 README）——
// 那里写的是挂载卷，服务会自动重读，不用重启。

import fs from 'node:fs';
import path from 'node:path';
import { scoreVoice, guessGender, pickBalanced } from './lib/voice-filter.mjs';

const BASE_URL = (process.env.FISH_BASE_URL || 'https://api.fish.audio').replace(/\/$/, '');
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const OUT_FILE = path.join(DATA_DIR, 'voices.fish.json');

const flag = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const languages = (flag('language', 'en,zh') || '').split(',').map((s) => s.trim()).filter(Boolean);
const perBucket = Number(flag('per-bucket', 3));
const poolPerLang = Number(flag('pool', 200)); // 每个语种扫多少个候选
const style = flag('style', 'meeting'); // meeting | any
const explain = has('explain');

const key = process.env.FISH_API_KEY;
if (!key) {
  console.error('缺少 FISH_API_KEY。在 .env 里配好，或者在 Railway 的 Console 里跑（那边已注入）。');
  process.exit(1);
}

const PAGE = 100; // 接口单页上限

/** 一个语种翻若干页，凑够 poolPerLang 个候选 */
async function fetchPool(language) {
  const items = [];
  let total = null;
  for (let page = 1; items.length < poolPerLang; page++) {
    const params = new URLSearchParams({
      page_size: String(Math.min(PAGE, poolPerLang - items.length)),
      page_number: String(page),
      sort_by: 'task_count',
    });
    if (language) params.set('language', language);

    const res = await fetch(`${BASE_URL}/model?${params}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      throw new Error(`GET /model 失败 (${res.status})：${(await res.text().catch(() => '')).slice(0, 200)}`);
    }
    const json = await res.json();
    total = json.total ?? total;
    const batch = json.items || [];
    items.push(...batch);
    if (batch.length === 0) break; // 翻完了
  }
  return { total, items };
}

const oneLine = (s, max = 70) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};

/* ---------------------------------------------------------------- */

const scored = [];
const stats = [];

for (const language of languages.length ? languages : [null]) {
  try {
    const { total, items } = await fetchPool(language);
    let usable = 0;
    let blocked = 0;

    for (const v of items) {
      const id = v._id || v.id;
      if (!id) continue;
      if (v.type && v.type !== 'tts') continue; // 跳过 svc（歌声转换）
      if (v.state && v.state !== 'trained') continue;

      const s = scoreVoice(v);
      if (style === 'meeting' && s.blocked) {
        blocked++;
        continue;
      }
      usable++;
      scored.push({
        voice: v,
        lang: language || 'any',
        gender: guessGender(v),
        score: style === 'meeting' ? s.score : 0,
        hits: s.hits,
      });
    }
    stats.push(`  ${String(language || '全部').padEnd(6)} 库里 ${String(total ?? '?').padStart(5)} 个 · 扫了 ${String(items.length).padStart(4)} 个 · 可用 ${String(usable).padStart(4)} · 排除 ${blocked}`);
  } catch (err) {
    stats.push(`  ${String(language || '全部').padEnd(6)} ✗ ${err.message}`);
    console.error(`  ✗ [${language}] ${err.message}`);
  }
}

console.log('');
stats.forEach((l) => console.log(l));

if (!scored.length) {
  console.error('\n一个音色都没拉到，没有写文件。');
  process.exit(1);
}

const picked =
  style === 'meeting'
    ? pickBalanced(scored, perBucket)
    : pickBalanced(scored.map((x) => ({ ...x, score: x.voice.task_count ?? 0 })), perBucket);

// 同一个音色可能在多个语种里出现，去重
const seen = new Set();
const voices = [];
for (const p of picked) {
  const id = p.voice._id || p.voice.id;
  if (seen.has(id)) continue;
  seen.add(id);
  voices.push({
    id,
    label: oneLine(p.voice.title || id, 40),
    gender: p.gender,
    note: oneLine(p.voice.description || (p.voice.tags || []).join('/') || ''),
    tags: (p.voice.tags || []).slice(0, 8),
    languages: p.voice.languages || (p.lang !== 'any' ? [p.lang] : []),
    uses: p.voice.task_count ?? null,
    _score: p.score,
    _bucket: p.bucket,
    _hits: explain ? p.hits : undefined,
  });
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(voices, null, 2));

console.log('');
console.log(`已写入 ${OUT_FILE}（${voices.length} 个音色，风格筛选 = ${style}）`);
console.log('');
const pad = (s, n) => String(s).padEnd(n);
console.log('  ' + pad('桶', 16) + pad('分', 5) + pad('用量', 9) + pad('音色', 26) + '描述');
console.log('  ' + '─'.repeat(104));
for (const v of voices) {
  console.log(
    '  ' +
      pad(v._bucket, 16) +
      pad(v._score, 5) +
      pad(v.uses ?? '-', 9) +
      pad(oneLine(v.label, 24), 26) +
      oneLine(v.note, 40)
  );
  if (explain && v._hits?.length) console.log('  ' + ' '.repeat(16) + v._hits.join(' '));
}
console.log('');
console.log('服务按文件 mtime 自动重读，刷新页面就能看到新的音色下拉。');
console.log('觉得某个音色不合适，直接编辑这个 JSON 删掉那一条即可。');
