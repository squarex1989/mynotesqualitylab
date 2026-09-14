// 给一串 fish.audio 的音色 ID，逐个查出名字/描述/标签/语言，写成 $DATA_DIR/voices.fish.json。
//
// 这条路适合你已经在 https://fish.audio 上试听着挑好了 —— 耳朵挑的比任何关键词
// 打分都准。音色页地址是 https://fish.audio/m/<32位十六进制>，斜杠后面那段就是 ID。
//
// 用法（ID 之间用空格、逗号或换行分隔都行）：
//
//   node scripts/voices-from-ids.mjs 9a9cf477... ca3007f9... 90e65eaa...
//   node scripts/voices-from-ids.mjs --file ids.txt
//   echo "id1,id2,id3" | node scripts/voices-from-ids.mjs
//
// 按语种分批时用 --lang 标注、用 --append 累加：
//   node scripts/voices-from-ids.mjs --lang en <一批英文的 id>
//   node scripts/voices-from-ids.mjs --lang zh --append <一批中文的 id>
//
// --lang 只在音色自己没报语言时用来填空；如果音色报的语言里没有你指定的那个，
// 会警示 —— 那通常意味着挑错了（拿中文音色读英文台词发音会别扭）。
//
// 默认覆盖整张表；想往现有表里追加用 --append。
// 本机连不上 api.fish.audio 时，在 Railway 的 Console 里跑（详见 README）——
// 那里写的是挂载卷，服务会自动重读，不用重启。

import fs from 'node:fs';
import path from 'node:path';
import { guessGender } from './lib/voice-filter.mjs';

const BASE_URL = (process.env.FISH_BASE_URL || 'https://api.fish.audio').replace(/\/$/, '');
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const OUT_FILE = path.join(DATA_DIR, 'voices.fish.json');

const key = process.env.FISH_API_KEY;
if (!key) {
  console.error('缺少 FISH_API_KEY。在 Railway 的 Console 里跑的话已经注入了。');
  process.exit(1);
}

const argv = process.argv.slice(2);

const has = (n) => argv.includes(`--${n}`);
const flagValue = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : null;
};

// 顺手支持直接粘 URL：从 /m/<id> 里把 ID 抠出来
const extract = (raw) => [
  ...new Set([...String(raw).matchAll(/[0-9a-f]{32}/gi)].map((m) => m[0].toLowerCase())),
];

/**
 * 从命令行、文件、stdin 三个来源凑 ID，怎么分隔都认。
 *
 * stdin 只在前两者都没给出 ID 时才读 —— 否则在 stdin 不是 TTY 的环境里
 * （CI、管道、某些 shell）会一直等 EOF，命令就挂住了。
 */
async function collectIds() {
  let raw = argv.filter((a) => !a.startsWith('--') && a !== flagValue('file')).join(' ');

  const file = flagValue('file');
  if (file) raw += ' ' + fs.readFileSync(file, 'utf8');

  const fromArgs = extract(raw);
  if (fromArgs.length) return fromArgs;

  if (process.stdin.isTTY) return [];
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return extract(Buffer.concat(chunks).toString('utf8'));
}

const ids = await collectIds();
if (!ids.length) {
  console.error('没解析出任何 ID。ID 是 32 位十六进制，直接粘 fish.audio/m/... 的地址也行。');
  process.exit(1);
}

const oneLine = (s, max = 70) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};

const expectLang = flagValue('lang');
console.log(
  `\n要查 ${ids.length} 个 ID，逐个请求 GET /model/{id}` +
    (expectLang ? `（这一批标注为 ${expectLang}）` : '') +
    '\n'
);

const rows = [];
const failed = [];

for (const id of ids) {
  try {
    const res = await fetch(`${BASE_URL}/model/${id}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120);
      failed.push({ id, reason: `HTTP ${res.status} ${body}` });
      console.log(`  ✗ ${id}  HTTP ${res.status}`);
      continue;
    }
    const v = await res.json();
    const gender = guessGender(v);
    const apiLangs = Array.isArray(v.languages) ? v.languages.filter(Boolean) : [];
    const entry = {
      id,
      label: oneLine(v.title || id, 40),
      gender,
      note: oneLine(v.description || (v.tags || []).join('/') || ''),
      tags: (v.tags || []).slice(0, 8),
      // 音色自己报的语言优先；报空了才用 --lang 填
      languages: apiLangs.length ? apiLangs : expectLang ? [expectLang] : [],
      uses: v.task_count ?? null,
    };
    rows.push(entry);

    const warn = [];
    if (v.type && v.type !== 'tts') warn.push(`type=${v.type}`);
    if (v.state && v.state !== 'trained') warn.push(`state=${v.state}`);
    if (v.visibility && v.visibility !== 'public') warn.push(`visibility=${v.visibility}`);
    // 分组和音色实际支持的语言不一致 —— 大概率是挑错了
    if (expectLang && apiLangs.length && !apiLangs.includes(expectLang)) {
      warn.push(`⚠ 你归到 ${expectLang}，但它报的是 ${apiLangs.join('/')}`);
    }
    console.log(
      `  ✓ ${entry.label.padEnd(26)} ${gender.padEnd(8)} ${(entry.languages.join('/') || '-').padEnd(10)} ${warn.length ? '⚠ ' + warn.join(' ') : ''}`
    );
    if (entry.note) console.log(`      ${entry.note}`);
  } catch (err) {
    failed.push({ id, reason: err.cause?.code || err.message });
    console.log(`  ✗ ${id}  ${err.cause?.code || err.message}`);
  }
}

if (!rows.length) {
  console.error('\n一个都没查到，没有写文件。');
  process.exit(1);
}

let out = rows;
if (has('append')) {
  try {
    const existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    const byId = new Map((Array.isArray(existing) ? existing : []).map((v) => [v.id, v]));
    for (const r of rows) byId.set(r.id, r); // 同 ID 用新查到的覆盖
    out = [...byId.values()];
  } catch {
    /* 原来没有表，就当全新写 */
  }
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));

console.log('');
console.log(`已写入 ${OUT_FILE}：${out.length} 个音色${has('append') ? '（追加模式）' : ''}`);
const byGender = out.reduce((a, v) => ((a[v.gender] = (a[v.gender] || 0) + 1), a), {});
console.log(`按性别：${Object.entries(byGender).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
if (failed.length) {
  console.log('');
  console.log(`${failed.length} 个没查到：`);
  failed.forEach((f) => console.log(`  ${f.id}  ${f.reason}`));
  console.log('（可能是私有音色 —— 私有的只有作者本人的 key 能取到，公开库的才行）');
}
console.log('');
console.log('服务按文件 mtime 自动重读，刷新页面就能看到新的音色下拉。');
