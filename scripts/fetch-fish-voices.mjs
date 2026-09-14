// 从 Fish Audio 的公开音色库拉一份音色表，写到 data/voices.fish.json。
//
//   node --env-file-if-exists=.env scripts/fetch-fish-voices.mjs
//   node --env-file-if-exists=.env scripts/fetch-fish-voices.mjs --language zh --limit 40
//
// 只在你想更新音色表的时候跑一次；跑完之后服务本身不需要再访问 api.fish.audio。
//
// GET /model 的参数（来自官方 SDK fishaudio/resources/voices.py）：
//   page_size, page_number, title, tag, self, author_id, language, title_language,
//   sort_by = task_count（按热度）| created_at（按新）

import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = (process.env.FISH_BASE_URL || 'https://api.fish.audio').replace(/\/$/, '');
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const OUT_FILE = path.join(DATA_DIR, 'voices.fish.json');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const languages = (arg('language', 'zh,en') || '').split(',').map((s) => s.trim()).filter(Boolean);
const limit = Number(arg('limit', 30));
const sortBy = arg('sort', 'task_count');
const tag = arg('tag');

const key = process.env.FISH_API_KEY;
if (!key) {
  console.error('缺少 FISH_API_KEY。在 .env 里配好，或者 FISH_API_KEY=... node scripts/...');
  process.exit(1);
}

/** 一个语言拉一页 */
async function fetchPage(language) {
  const params = new URLSearchParams({
    page_size: String(Math.min(100, limit)),
    page_number: '1',
    sort_by: sortBy,
  });
  if (language) params.set('language', language);
  if (tag) params.set('tag', tag);

  const url = `${BASE_URL}/model?${params}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET /model 失败 (${res.status})：${body.slice(0, 300)}`);
  }
  const json = await res.json();
  return { total: json.total ?? null, items: json.items ?? [] };
}

/** 从标签里猜性别，猜不出来就 neutral —— 只影响随机分配时的多样性 */
function guessGender(voice) {
  const hay = `${voice.title || ''} ${(voice.tags || []).join(' ')} ${voice.description || ''}`.toLowerCase();
  if (/\b(female|woman|girl)\b|女|少女|妈妈|姐/.test(hay)) return 'female';
  if (/\b(male|man|boy)\b|男|少年|爸爸|哥/.test(hay)) return 'male';
  return 'neutral';
}

function oneLine(s, max = 70) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

const seen = new Map();
const warnings = [];

for (const language of languages.length ? languages : [null]) {
  try {
    const { total, items } = await fetchPage(language);
    console.log(`[${language || '全部'}] 公开库共 ${total ?? '?'} 个，取回 ${items.length} 个`);
    for (const v of items) {
      const id = v._id || v.id;
      if (!id || seen.has(id)) continue;
      if (v.type && v.type !== 'tts') continue; // 跳过 svc（歌声转换）
      if (v.state && v.state !== 'trained') continue;
      seen.set(id, {
        id,
        label: oneLine(v.title || id, 40),
        gender: guessGender(v),
        note: oneLine(v.description || (v.tags || []).join('/') || ''),
        tags: (v.tags || []).slice(0, 8),
        languages: v.languages || (language ? [language] : []),
        uses: v.task_count ?? null,
      });
    }
  } catch (err) {
    warnings.push(`[${language || '全部'}] ${err.message}`);
    console.error(`  ✗ ${err.message}`);
  }
}

const voices = [...seen.values()].sort((a, b) => (b.uses ?? 0) - (a.uses ?? 0)).slice(0, limit);

if (!voices.length) {
  console.error('');
  console.error('一个音色都没拉到，没有写文件。上面的错误信息是原因。');
  if (warnings.length) warnings.forEach((w) => console.error('  ' + w));
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(voices, null, 2));

console.log('');
console.log(`已写入 ${OUT_FILE}（${voices.length} 个音色）`);
console.log('');
const pad = (s, n) => String(s).padEnd(n);
console.log('  ' + pad('音色', 26) + pad('性别', 8) + pad('用量', 10) + '描述');
for (const v of voices.slice(0, 15)) {
  console.log('  ' + pad(oneLine(v.label, 24), 26) + pad(v.gender, 8) + pad(v.uses ?? '-', 10) + oneLine(v.note, 44));
}
if (voices.length > 15) console.log(`  …还有 ${voices.length - 15} 个`);
console.log('');
console.log('重启服务后，角色卡的音色下拉就会用这张表。');
