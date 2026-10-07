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
const { planImport, importTranscript } = await import('../server/importer.js');
const { voices } = await import('../server/voices.js');
const { db, audioPath } = await import('../server/db.js');
const { io: connect } = await import('socket.io-client');

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

server.close();
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

console.log(`\n${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
