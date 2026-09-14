// 对着真实的 Fish Audio API 跑一遍自检。
//
//   node --env-file-if-exists=.env scripts/check-fish.mjs
//
// 为什么需要这个：开发这一版时，运行环境访问不到 api.fish.audio，所有实现
// 都是按官方 SDK 的契约写的、只用本地 mock 验证过。而上一个 provider 的经历
// 说明文档会骗人（OpenRouter 文档说 Gemini 支持 mp3，真调用直接 400）。
// 所以这些断言必须对着真接口跑一次才算数。
//
// 会花掉几次很短的合成调用（每次十来个字），成本可以忽略。

import { encode as msgpackEncode } from '@msgpack/msgpack';

const BASE = (process.env.FISH_BASE_URL || 'https://api.fish.audio').replace(/\/$/, '');
const MODEL = process.env.FISH_MODEL || 's2.1-pro-free';
const KEY = process.env.FISH_API_KEY;

if (!KEY) {
  console.error('缺少 FISH_API_KEY —— 在 .env 里配好再跑');
  process.exit(1);
}

let pass = 0;
let fail = 0;
const ok = (label, detail = '') => { pass++; console.log(`  ✓ ${label}${detail ? '  ' + detail : ''}`); };
const no = (label, detail = '') => { fail++; console.log(`  ✗ ${label}${detail ? '  ' + detail : ''}`); };

async function tts(payload) {
  const res = await fetch(`${BASE}/v1/tts`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/msgpack',
      model: MODEL,
    },
    body: msgpackEncode(payload),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: body.replace(/\s+/g, ' ').slice(0, 200) };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: true, bytes: buf.length, contentType: res.headers.get('content-type') || '', buf };
}

const TEXT = '喂，听得到吗？这是一句测试。';

console.log(`\n对着 ${BASE} 自检，模型 ${MODEL}\n`);

/* 1. 音色库 ------------------------------------------------------- */
console.log('1) 音色库 GET /model');
let libraryVoice = null;
try {
  const res = await fetch(`${BASE}/model?page_size=3&page_number=1&sort_by=task_count`, {
    headers: { authorization: `Bearer ${KEY}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    no(`返回 HTTP ${res.status}`, (await res.text().catch(() => '')).slice(0, 160));
  } else {
    const json = await res.json();
    const items = json.items || [];
    ok(`拿到 ${items.length} 个音色（库里共 ${json.total ?? '?'} 个）`);
    const first = items[0];
    if (first) {
      libraryVoice = first._id || first.id;
      const has = (k) => (first[k] !== undefined && first[k] !== null ? '有' : '无');
      ok('字段齐全性', `description=${has('description')} tags=${has('tags')} languages=${has('languages')} samples=${has('samples')}`);
      console.log(`      示例: ${first.title} / ${libraryVoice}`);
      if (first.description) console.log(`      描述: ${String(first.description).replace(/\s+/g, ' ').slice(0, 80)}`);
      if (first.tags?.length) console.log(`      标签: ${first.tags.slice(0, 8).join(', ')}`);
    }
  }
} catch (err) {
  no('请求失败', err.cause?.code || err.message);
}

/* 2. msgpack + mp3 ------------------------------------------------ */
console.log('\n2) 合成：msgpack 请求体 + mp3 输出');
const base = await tts({ text: TEXT, format: 'mp3', mp3_bitrate: 128, normalize: true, latency: 'normal' });
if (!base.ok) no(`失败 HTTP ${base.status}`, base.error);
else {
  ok('mp3 合成成功', `${Math.round(base.bytes / 1024)}KB · ${base.contentType}`);
  const magic = base.buf.subarray(0, 3);
  const isMp3 = (magic[0] === 0xff && (magic[1] & 0xe0) === 0xe0) || magic.toString('ascii') === 'ID3';
  isMp3 ? ok('字节头确实是 MP3') : no('字节头不像 MP3', magic.toString('hex'));
}

/* 3. JSON body 会不会也被接受 ------------------------------------- */
console.log('\n3) 只发 JSON 会怎样（SDK 用的是 msgpack，这里确认一下）');
try {
  const res = await fetch(`${BASE}/v1/tts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', model: MODEL },
    body: JSON.stringify({ text: TEXT, format: 'mp3' }),
    signal: AbortSignal.timeout(60000),
  });
  res.ok
    ? ok('JSON 也被接受了', '（那 msgpack 就不是硬要求，但我们照 SDK 走更保险）')
    : ok(`JSON 被拒：HTTP ${res.status}`, '→ msgpack 是必须的，实现正确');
} catch (err) {
  no('请求失败', err.cause?.code || err.message);
}

/* 4. 其它格式 ----------------------------------------------------- */
console.log('\n4) 各输出格式');
for (const format of ['mp3', 'wav', 'pcm', 'opus']) {
  const r = await tts({ text: '一二三。', format });
  r.ok ? ok(format, `${Math.round(r.bytes / 1024)}KB · ${r.contentType}`) : no(format, `HTTP ${r.status} ${r.error}`);
}

/* 5. prosody.speed 真的生效吗 ------------------------------------- */
console.log('\n5) prosody.speed 是否真的改变时长');
const slow = await tts({ text: TEXT, format: 'mp3', prosody: { speed: 0.7, volume: 0 } });
const fast = await tts({ text: TEXT, format: 'mp3', prosody: { speed: 1.35, volume: 0 } });
if (slow.ok && fast.ok) {
  const ratio = slow.bytes / fast.bytes;
  console.log(`      speed=0.7 → ${Math.round(slow.bytes / 1024)}KB，speed=1.35 → ${Math.round(fast.bytes / 1024)}KB，比值 ${ratio.toFixed(2)}`);
  ratio > 1.3 ? ok('慢速明显更长，speed 生效') : no('两者差不多，speed 可能没生效');
} else no('调用失败', `${slow.error || ''} ${fast.error || ''}`);

/* 6. 方括号标签会不会被念出来 ------------------------------------- */
console.log('\n6) [方括号标签] 会不会被当正文念出来');
const TAG = 'tired, low energy, almost sighing, 东北口音';
const plain = await tts({ text: TEXT, format: 'mp3' });
const tagged = await tts({ text: `[${TAG}] ${TEXT}`, format: 'mp3' });
if (plain.ok && tagged.ok) {
  const ratio = tagged.bytes / plain.bytes;
  console.log(`      标签 ${TAG.length} 字符；不带 ${Math.round(plain.bytes / 1024)}KB，带 ${Math.round(tagged.bytes / 1024)}KB，比值 ${ratio.toFixed(2)}`);
  if (ratio > 1.8) no('标签被念出来了 —— 风格控制方式需要改');
  else if (Math.abs(ratio - 1) > 0.08) ok('标签没被念出，且改变了朗读方式');
  else ok('标签没被念出', '（但这次没观察到明显变化，Fish 输出本身有随机性）');
} else no('调用失败', `${plain.error || ''} ${tagged.error || ''}`);

/* 7. reference_id ------------------------------------------------- */
console.log('\n7) reference_id（音色）');
const bogus = await tts({ text: '一二三。', format: 'mp3', reference_id: '00000000000000000000000000000000' });
bogus.ok
  ? no('不存在的 ID 也返回了音频', '→ 说明会静默回落到默认音色，配错 ID 不会报错')
  : ok(`不存在的 ID 被拒：HTTP ${bogus.status}`, '→ 服务端真的在查 ID');

if (libraryVoice) {
  const real = await tts({ text: '一二三。', format: 'mp3', reference_id: libraryVoice });
  real.ok ? ok(`音色库里的 ID 可用`, `${libraryVoice} → ${Math.round(real.bytes / 1024)}KB`) : no('音色库里的 ID 用不了', `HTTP ${real.status} ${real.error}`);
}

/* 8. 单次请求的字数上限（免费档没有公开文档）---------------------- */
console.log('\n8) 单次请求能吃多长的文本（代码里默认切到 800 字）');
for (const n of [500, 800, 1200]) {
  const long = '这是一句用来测试长度上限的话。'.repeat(Math.ceil(n / 15)).slice(0, n);
  const r = await tts({ text: long, format: 'mp3' });
  r.ok
    ? ok(`${n} 字`, `${Math.round(r.bytes / 1024)}KB`)
    : no(`${n} 字被拒`, `HTTP ${r.status} ${r.error}`);
}

/* ---------------------------------------------------------------- */
console.log(`\n${pass} 项通过，${fail} 项失败\n`);
if (fail) {
  console.log('有失败项 —— 把上面的输出贴给我，我按真实行为改实现。');
  process.exit(1);
}
console.log('全部通过，实现和真实接口一致。');
