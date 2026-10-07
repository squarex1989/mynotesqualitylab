#!/usr/bin/env node
// 批量处理相关的断言。跑的是真实的 socket.io 服务端和客户端。
//
// 跑法：node scripts/check-batch.mjs
//
// 覆盖：
//   1. 导入：按文件里的要求（要求头 / 说话人备注 / 文件名）配置房间、命名、挑口音音色
//   2. 设备进房间自动分到角色：新设备从最忙的设备那里接过角色
//   3. 收音设备：不念台词、能贴转录和摘要；摘要不影响转录的分数
//   4. 房主换房间带着设备走：收音 / 环境音角色不变，朗读设备按新房间重新分配
//   5. 有环境音时先等 YouTube 出声，朗读设备才开始

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-'));
process.env.AMBIENCE_WAIT_MS = '700';

const { attachRealtime } = await import('../server/realtime.js');
const rooms = await import('../server/rooms.js');
const { planImport, importTranscript, parseFileName } = await import('../server/importer.js');
const { voices } = await import('../server/voices.js');
const { db, audioPath } = await import('../server/db.js');
const { io: connect } = await import('socket.io-client');
const { buildSchedule } = await import('../server/schedule.js');

let pass = 0;
let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
};
const voiceOf = (id) => voices().find((v) => v.id === id);

// ---------------------------------------------------------------- 1
console.log('\n1) 导入：按文件里的要求配置房间');
{
  const p = planImport({
    name: 'weekly_sync.txt',
    text: `---
Title: Weekly sync
Speakers: Alice (Indian accent, female), Bob, Carol
Accent: British
Order: chaotic
Noise: airport
---
Alice: Let's start with last week's numbers.
Bob: Hold on, my chart hasn't loaded yet.
Carol: Three points week over week, or year over year?`,
  });
  t('要求头没被当成台词', p.parsed.lines.length === 3 && p.parsed.speakers.join() === 'Alice,Bob,Carol',
    JSON.stringify(p.parsed.speakers));
  t('Order: chaotic → 无序', p.settings.orderMode === 'chaotic');
  t('Noise: airport → 嘈杂 + 机场', p.settings.noiseMode === 'noisy' && p.settings.ambienceKind === 'airport');
  t('Alice 指名要了印度口音', voiceOf(p.voicePlan.Alice)?.accents.some((a) => /indian/i.test(a)),
    p.voicePlan.Alice);
  t('没指名的 British 给了下一个说话人', voiceOf(p.voicePlan.Bob)?.accents.some((a) => /british/i.test(a)),
    p.voicePlan.Bob);
  t('其余说话人用无口音的英文音色', voiceOf(p.voicePlan.Carol)?.accents.length === 0 &&
    voiceOf(p.voicePlan.Carol)?.country === 'en');
  t('三个人三个不同的音色', new Set(Object.values(p.voicePlan)).size === 3);
  t('房间名包含标题和要求摘要', /^Weekly sync \| EN·3p/.test(p.title) && /Chaos/.test(p.title), p.title);

  const f = planImport({
    name: '07_chaotic_cafe_indian-accent.txt',
    text: 'Alice: hi there how are you\nBob: fine thanks and you',
  });
  t('文件名里的要求也认：无序 + 咖啡厅', f.settings.orderMode === 'chaotic' && f.settings.ambienceKind === 'cafe'
    && f.settings.noiseMode === 'noisy');
  t('文件名里的印度口音只给一个人（开头的 07 不是人数）',
    Object.values(f.voicePlan).filter((id) => voiceOf(id)?.accents.length).length === 1);

  const zh = planImport({
    name: 'review.txt',
    text: '主题：产品评审\n人数：3\n顺序：有序\n环境：安静\n\n张三：我们先看一下上周的数据。\n李四：好的，我这边图表还没加载出来。',
  });
  t('中文键名：标题、有序、安静', zh.title.startsWith('产品评审') && zh.settings.orderMode === 'ordered'
    && zh.settings.noiseMode === 'quiet', zh.title);
  t('中文内容 → 中文音色', zh.language === 'zh' && Object.values(zh.voicePlan).every((id) => voiceOf(id)?.country === 'zh'));
  t('人数和台词对不上时给出提醒', zh.warnings.some((w) => /3 speakers/.test(w)), JSON.stringify(zh.warnings));

  const inline = planImport({ name: 'x.txt', text: 'Ana (Mexican accent): Hola, ¿qué tal? No sé.\nLuis: Bien, pero es tarde para la reunión.' });
  t('台词里名字后的括号备注也算要求', voiceOf(inline.voicePlan.Ana)?.accents.some((a) => /mexican/i.test(a)),
    inline.voicePlan.Ana);
  t('西班牙语内容 → 西班牙语', inline.language === 'es');

  // 文件名约定：语言 + 会议主题 + 人数 + 有序/无序
  const cases = [
    ['英文_产品评审_3人_有序', { language: 'en', topic: '产品评审', count: 3, order: 'ordered' }],
    ['EN-Weekly sync-4p-chaotic', { language: 'en', topic: 'Weekly sync', count: 4, order: 'chaotic' }],
    ['zh 季度复盘 5 无序', { language: 'zh', topic: '季度复盘', count: 5, order: 'chaotic' }],
    ['01_中文_周会_三人_无序', { language: 'zh', topic: '周会', count: 3, order: 'chaotic' }],
    ['English_Top 10 ideas_3_ordered', { language: 'en', topic: 'Top 10 ideas', count: 3, order: 'ordered' }],
    ['de_it support_2人_chaotic', { language: 'de', topic: 'it support', count: 2, order: 'chaotic' }],
  ];
  for (const [stem, want] of cases) {
    const got = parseFileName(stem);
    t(`文件名「${stem}」→ ${want.language} / ${want.topic} / ${want.count}人 / ${want.order}`,
      got.language === want.language && got.topic === want.topic && got.count === want.count && got.order === want.order,
      JSON.stringify(got));
  }
  const byName = planImport({
    name: '英文_产品评审_3人_无序.txt',
    text: '张三：我们先看一下上周的数据。\n李四：好的，我这边图表还没加载出来。',
  });
  t('文件名的语言优先于内容猜测', byName.language === 'en');
  t('文件名的无序生效', byName.settings.orderMode === 'chaotic');
  t('房间名用文件名里的主题', byName.title.startsWith('产品评审 | EN'), byName.title);
  t('文件名的人数和台词对不上时提醒', byName.warnings.some((w) => /3 speakers/.test(w)), JSON.stringify(byName.warnings));

  const r = importTranscript({ name: 'demo.txt', text: 'Order: chaotic\nAlice: one two\nBob: three four' });
  const st = rooms.roomState(r.id);
  t('导入真的建了房间并锁定 transcript', st.locked && st.lineCount === 2 && st.settings.orderMode === 'chaotic');
  t('导入时不合成音频', rooms.generationProgress(r.id).ready === 0);

  let threw = false;
  try {
    importTranscript({ name: 'empty.txt', text: 'Title: nothing here\n' });
  } catch {
    threw = true;
  }
  t('解析不出台词的文件报错', threw);
}

// ---------------------------------------------------------------- 1b
console.log('\n1b) 话没说完（省略号 / 破折号收尾）时，下一句直接插进来');
{
  const room = { order_mode: 'ordered', gap_ms: 450, chaos_period_ms: 20000, duck_gain: 0.5 };
  const lines = [
    { idx: 0, speaker: '马强', content: '肝肾功能这块,我们数据这边其实也发现了一个问题,就是...' },
    { idx: 1, speaker: '李娜', content: '是不是又是那个录入延迟的事?' },
    { idx: 2, speaker: '马强', content: '对，就是这个。' },
    { idx: 3, speaker: '李娜', content: '我觉得——' },
    { idx: 4, speaker: '马强', content: '先别急。' },
  ];
  const audio = new Map(lines.map((l) => [l.idx, { hash: `h${l.idx}`, durationMs: 3000 }]));
  const sp = new Map([['马强', { device_id: 'a', volume: 100 }], ['李娜', { device_id: 'b', volume: 100 }]]);
  const { items } = buildSchedule(room, lines, sp, audio, null);
  const end = (i) => items[i].startMs + items[i].durationMs;
  t('★「就是...」之后，下一句在它念完之前就开口（有序模式也一样）', items[1].startMs < end(0),
    `${items[1].startMs} vs ${end(0)}`);
  t('被打断的那句从重叠处压低音量', items[0].duckFromMs !== null);
  t('正常收尾的句子照常留 gap', items[2].startMs === end(1) + 450, `${items[2].startMs} vs ${end(1)}`);
  t('「——」收尾也算被打断', items[4].startMs < end(3));

  const same = new Map([['马强', { device_id: 'a', volume: 100 }], ['李娜', { device_id: 'a', volume: 100 }]]);
  const s2 = buildSchedule(room, lines, same, audio, null).items;
  t('同一台设备上不重叠，但紧接着开口、不留 gap', s2[1].startMs === s2[0].startMs + s2[0].durationMs);
}

// ---------------------------------------------------------------- socket 工具
const server = http.createServer();
attachRealtime(server);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;

const open = (roomId, deviceId, hostToken) =>
  new Promise((resolve, reject) => {
    const s = connect(url, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
      auth: { roomId, deviceId, deviceName: deviceId, hostToken },
    });
    const events = [];
    s.onAny((name, payload) => events.push({ name, payload, at: Date.now() }));
    s.once('hello', () => resolve({ s, events }));
    s.once('fatal', (p) => reject(new Error(p.message)));
    s.once('connect_error', reject);
  });
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const loadOf = (roomId) => {
  const m = new Map();
  for (const s of rooms.getSpeakers(roomId)) m.set(s.device_id, (m.get(s.device_id) || 0) + 1);
  return m;
};
const makeRoom = (names) => {
  const room = rooms.createRoom({ title: 't' });
  rooms.setTranscript(room.id, {
    speakers: names,
    lines: names.map((n, i) => ({ speaker: n, content: `line ${i} from ${n}` })),
  });
  return room;
};

// ---------------------------------------------------------------- 2
console.log('\n2) 设备进房间自动分到角色');
{
  const room = makeRoom(['A', 'B', 'C']);
  const d1 = await open(room.id, 'r1');
  await settle();
  t('第一台设备进来拿到全部 3 个角色', loadOf(room.id).get('r1') === 3);
  const d2 = await open(room.id, 'r2');
  await settle();
  t('第二台进来接过一个角色（2/1）', loadOf(room.id).get('r2') >= 1 && loadOf(room.id).get('r1') <= 2,
    JSON.stringify([...loadOf(room.id)]));
  const d3 = await open(room.id, 'r3');
  await settle();
  t('第三台进来 → 每台一个', [...loadOf(room.id).values()].every((n) => n === 1), JSON.stringify([...loadOf(room.id)]));
  const d4 = await open(room.id, 'r4');
  await settle();
  t('设备比角色多时，有的设备没有台词', !loadOf(room.id).has('r4') || loadOf(room.id).size === 3);
  [d1, d2, d3, d4].forEach((d) => d.s.close());
  await settle();
}

// ---------------------------------------------------------------- 3
console.log('\n3) 收音设备');
let roomA;
{
  roomA = makeRoom(['Alice', 'Bob']);
  const host = await open(roomA.id, 'host', roomA.hostToken);
  const cap = await open(roomA.id, 'cap');
  const guest = await open(roomA.id, 'guest');
  await settle();

  host.s.emit('device:capture', { deviceId: 'cap', on: true });
  await settle();
  const state = rooms.roomState(roomA.id);
  t('设成收音设备后 state 里能看到', state.devices.find((d) => d.id === 'cap')?.capture === true);
  t('★ 收音设备身上没有任何角色', !rooms.getSpeakers(roomA.id).some((s) => s.device_id === 'cap'));
  t('角色都还有人念', rooms.getSpeakers(roomA.id).every((s) => s.device_id));

  let threw = false;
  try {
    rooms.assignSpeaker(roomA.id, 'Alice', 'cap');
  } catch {
    threw = true;
  }
  t('★ 手动把角色分给收音设备会被拒', threw);

  cap.s.emit('compare:put', { product: 'otter', transcript: 'Alice: one two three' });
  cap.s.emit('compare:put', { product: 'otter', summary: 'They counted to three.' });
  await settle();
  const row = () => rooms.getComparisons(roomA.id).find((c) => c.product === 'otter');
  t('★ 收音设备能贴转录', row()?.transcript === 'Alice: one two three');
  t('★ 收音设备能贴摘要，而且没把转录冲掉', row()?.summary === 'They counted to three.' && row()?.transcript);

  rooms.setComparisonState(roomA.id, 'otter', 'done', { result: { fake: true } });
  cap.s.emit('compare:put', { product: 'otter', summary: 'Changed summary' });
  await settle();
  t('只改摘要不影响转录的分数', row()?.result?.fake === true && row()?.summary === 'Changed summary');
  cap.s.emit('compare:put', { product: 'otter', transcript: 'Alice: one two four' });
  await settle();
  t('改了转录，旧分数作废', row()?.result === null && row()?.state === 'idle');

  guest.events.length = 0;
  guest.s.emit('compare:put', { product: 'granola', transcript: 'guest wrote this' });
  await settle();
  t('★ 普通设备仍然不能贴', !rooms.getComparisons(roomA.id).some((c) => c.product === 'granola'));

  host.s.emit('device:capture', { deviceId: 'cap', on: false });
  await settle();
  t('取消收音设备后它回到朗读池', rooms.roomState(roomA.id).devices.find((d) => d.id === 'cap')?.capture === false);
  host.s.emit('device:capture', { deviceId: 'cap', on: true });
  await settle();

  // ---------------------------------------------------------------- 4
  console.log('\n4) 房主换房间，设备跟随');
  const roomB = makeRoom(['X', 'Y', 'Z']);
  host.s.emit('room:settings', { noiseMode: 'noisy', ambienceDevice: 'guest' });
  await settle();

  const bad = await new Promise((r) =>
    host.s.emit('room:move', { targetRoomId: roomB.id, targetHostToken: 'wrong', follow: true }, r)
  );
  t('目标房间的 host token 不对 → 拒绝', bad?.ok === false);

  const ack = await new Promise((r) =>
    host.s.emit('room:move', { targetRoomId: roomB.id, targetHostToken: roomB.hostToken, follow: true }, r)
  );
  await settle();
  t('换房间成功，带走 3 台在线设备', ack?.ok === true && ack.moved === 3, JSON.stringify(ack));
  for (const [name, d] of [['host', host], ['capture', cap], ['guest', guest]]) {
    t(`${name} 收到了 room:goto`, d.events.some((e) => e.name === 'room:goto' && e.payload.roomId === roomB.id));
  }
  const bDevices = rooms.getDevices(roomB.id);
  t('★ 收音设备到了新房间还是收音设备', bDevices.find((d) => d.id === 'cap')?.capture === 1);
  t('★ 环境音设备到了新房间还是环境音设备', rooms.getRoom(roomB.id).ambience_device === 'guest');
  t('★ 新房间的角色都分给了朗读设备，收音设备没有',
    rooms.getSpeakers(roomB.id).every((s) => s.device_id && s.device_id !== 'cap'),
    JSON.stringify(rooms.getSpeakers(roomB.id).map((s) => s.device_id)));

  [host, cap, guest].forEach((d) => d.s.close());
  await settle();
  // 设备真的连进新房间：第一台连上不能把台词全揽走
  const before = JSON.stringify(rooms.getSpeakers(roomB.id).map((s) => s.device_id));
  const h2 = await open(roomB.id, 'host', roomB.hostToken);
  await settle();
  t('★ 第一台跟过来的设备没有把台词全揽走', JSON.stringify(rooms.getSpeakers(roomB.id).map((s) => s.device_id)) === before,
    `${before} → ${JSON.stringify(rooms.getSpeakers(roomB.id).map((s) => s.device_id))}`);
  h2.s.close();
  await settle();
}

// ---------------------------------------------------------------- 5
console.log('\n5) 有环境音时，YouTube 出声后才开始念');
{
  const room = makeRoom(['Alice', 'Bob']);
  // 假装音频都合成好了
  for (const tgt of rooms.lineTargets(room.id)) {
    fs.writeFileSync(audioPath(tgt.hash), 'x');
    db.prepare('INSERT OR REPLACE INTO audio (hash, duration_ms, bytes, created_at) VALUES (?, 500, 1, ?)').run(tgt.hash, Date.now());
  }
  const host = await open(room.id, 'host', room.hostToken);
  const amb = await open(room.id, 'amb');
  await settle();
  host.s.emit('room:settings', { noiseMode: 'noisy', ambienceDevice: 'amb' });
  await settle();

  const readyOnPrepare = (d) => d.s.on('play:prepare', (p) => d.s.emit('play:ready', { token: p.token }));
  readyOnPrepare(host);
  readyOnPrepare(amb);

  // a) 环境音设备报告出声 → 才 go
  let ambStartAt = 0;
  amb.s.once('ambience:start', (p) => {
    ambStartAt = Date.now();
    setTimeout(() => amb.s.emit('ambience:playing', { token: p.token }), 300);
  });
  host.events.length = 0;
  host.s.emit('room:start');
  await settle(900);
  const go = host.events.find((e) => e.name === 'play:go');
  const start = host.events.find((e) => e.name === 'ambience:start');
  t('先发 ambience:start', Boolean(start) && start.payload.deviceId === 'amb');
  t('★ play:go 在环境音设备报告出声之后才发', Boolean(go) && go.at >= ambStartAt + 280,
    go ? `${go.at - ambStartAt}ms` : 'no go');
  host.s.emit('room:stop');
  await settle();

  // b) 环境音设备一直不报 → 超时后照常开始
  host.events.length = 0;
  host.s.emit('room:start');
  await settle(1200);
  t('环境音设备不回话时，超时后照常开始', host.events.some((e) => e.name === 'play:go'));
  host.s.emit('room:stop');
  await settle();

  // c) 安静模式不等环境音
  host.s.emit('room:settings', { noiseMode: 'quiet' });
  await settle();
  host.events.length = 0;
  host.s.emit('room:start');
  await settle(400);
  t('安静模式直接开始，不发 ambience:start',
    host.events.some((e) => e.name === 'play:go') && !host.events.some((e) => e.name === 'ambience:start'));
  host.s.emit('room:stop');
  await settle();
  host.s.close();
  amb.s.close();
}

// ---------------------------------------------------------------- 6
console.log('\n6) 从某一句开始播 / 暂停 / 继续');
{
  const room = makeRoom(['Alice', 'Bob', 'Carol']);
  for (const tgt of rooms.lineTargets(room.id)) {
    fs.writeFileSync(audioPath(tgt.hash), 'x');
    db.prepare('INSERT OR REPLACE INTO audio (hash, duration_ms, bytes, created_at) VALUES (?, 2000, 1, ?)').run(tgt.hash, Date.now());
  }
  const host = await open(room.id, 'host', room.hostToken);
  await settle();
  host.s.on('play:prepare', (p) => host.s.emit('play:ready', { token: p.token }));
  const lastState = () => [...host.events].reverse().find((e) => e.name === 'state')?.payload.state;

  host.events.length = 0;
  host.s.emit('room:start', { fromIdx: 1 });
  await settle(300);
  const prep = host.events.find((e) => e.name === 'play:prepare')?.payload;
  t('★ 从第 2 句开始：排期第一条就是第 2 句，从 0 开始', prep?.items[0]?.idx === 1 && prep.items[0].startMs === 0,
    JSON.stringify(prep?.items?.map((i) => [i.idx, i.startMs])));
  t('之前的句子不在排期里', !prep?.items.some((i) => i.idx < 1));

  await settle(1300); // GO_LEAD_MS 之后，第 2 句正在念
  host.events.length = 0;
  host.s.emit('room:pause');
  await settle(200);
  t('暂停时各设备收到 play:stop(paused)', host.events.some((e) => e.name === 'play:stop' && e.payload.reason === 'paused'));
  t('★ 暂停记下了正在念的那一句', lastState()?.pausedIdx === 1, String(lastState()?.pausedIdx));
  t('暂停后房间不是 playing', lastState()?.status === 'idle');

  host.events.length = 0;
  host.s.emit('room:start', { fromIdx: 1 });
  await settle(300);
  t('继续：从暂停的那一句重新开始', host.events.find((e) => e.name === 'play:prepare')?.payload.items[0].idx === 1);
  t('继续之后暂停标记清掉', lastState()?.pausedIdx === null);

  host.events.length = 0;
  host.s.emit('room:start', { fromIdx: 2 });
  await settle(300);
  t('播放中点另一句：先停再从那一句开始',
    host.events.some((e) => e.name === 'play:stop' && e.payload.reason === 'restart') &&
      host.events.find((e) => e.name === 'play:prepare')?.payload.items[0].idx === 2);

  host.s.emit('room:pause');
  await settle(150);
  host.s.emit('room:stop');
  await settle(150);
  t('停止会清掉暂停标记', lastState()?.pausedIdx === null);
  host.s.close();
}

server.close();
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

console.log(`\n${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
