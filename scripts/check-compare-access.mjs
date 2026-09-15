#!/usr/bin/env node
// 对比功能的权限断言。跑的是真实的 socket.io 服务端和客户端。
//
// 跑法：node scripts/check-compare-access.mjs
//
// 收音设备的概念已经去掉了：现在谁都能看到 Compare 的结果（走 state 广播，没有
// 任何按角色的读取限制），但只有房主能贴转录、改 glossary、发起打分 —— 写操作
// 全部收在服务端的 compareOnly() 里，不能靠客户端隐藏几个按钮就当作权限控制。
//
// 顺带确认收音设备真的从分配逻辑里消失了：assignSpeaker 不再因为「这是收音设备」
// 拒绝任何设备，autoAssignDevices 也不再排除它。

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-access-'));

const { attachRealtime } = await import('../server/realtime.js');
const { createRoom, roomState, setTranscript, getDevices, getSpeakers } = await import(
  '../server/rooms.js'
);
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

const server = http.createServer();
attachRealtime(server);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;

const { id: roomId, hostToken } = createRoom({ title: 'compare access' });
setTranscript(roomId, {
  speakers: ['Alice', 'Bob'],
  lines: [
    { speaker: 'Alice', content: 'one two three' },
    { speaker: 'Bob', content: 'four five six' },
  ],
});

const open = (deviceId, name, asHost = false) =>
  new Promise((resolve, reject) => {
    const s = connect(url, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
      auth: { roomId, deviceId, deviceName: name, hostToken: asHost ? hostToken : undefined },
    });
    const toasts = [];
    s.on('toast', (p) => toasts.push(p));
    let latestState = null;
    s.on('state', (p) => {
      latestState = p.state;
    });
    s.once('hello', () => resolve({ s, toasts, state: () => latestState }));
    s.once('fatal', (p) => reject(new Error(p.message)));
    s.once('connect_error', reject);
  });

const settle = () => new Promise((r) => setTimeout(r, 150));
const emit = (s, event, payload) => {
  s.emit(event, payload);
  return settle();
};

const host = await open('dev-host', 'Host laptop', true);
const guest = await open('dev-guest', 'Guest phone');
await settle();

// ---------------------------------------------------------------- 1
console.log('\n1) 读：谁都能看到对比结果，不需要任何特殊角色');
t('guest 连上就拿到了 state.comparisons 这个字段（还没人贴转录，是空数组）',
  Array.isArray(guest.state()?.comparisons) && guest.state()?.comparisons.length === 0,
  JSON.stringify(guest.state()?.comparisons));
t('房间设置里已经没有 captureDevice 这个字段了',
  !('captureDevice' in (guest.state()?.settings ?? {})),
  JSON.stringify(Object.keys(guest.state()?.settings ?? {})));

// ---------------------------------------------------------------- 2
console.log('\n2) 写：guest 不能贴转录、不能改 glossary、不能发起打分');
guest.toasts.length = 0;
await emit(guest.s, 'compare:put', { product: 'my-notes', transcript: 'guest tried to write this' });
t('★ guest 的 compare:put 被拒', guest.toasts.some((x) => /only the host/i.test(x.message)),
  JSON.stringify(guest.toasts));
t('★ 服务端根本没建这一行 —— 被拒的写从没落地过',
  guest.state()?.comparisons.find((c) => c.product === 'my-notes') === undefined,
  JSON.stringify(guest.state()?.comparisons));

guest.toasts.length = 0;
await emit(guest.s, 'compare:glossary', { text: 'guest glossary' });
t('★ guest 的 compare:glossary 被拒', guest.toasts.some((x) => /only the host/i.test(x.message)));
t('glossary 没被写进去', guest.state()?.settings.glossary === '',
  JSON.stringify(guest.state()?.settings.glossary));

guest.toasts.length = 0;
await emit(guest.s, 'compare:score', { product: 'my-notes' });
t('★ guest 的 compare:score 被拒', guest.toasts.some((x) => /only the host/i.test(x.message)));
t('打分从没被触发 —— 连这一行都不存在',
  guest.state()?.comparisons.find((c) => c.product === 'my-notes') === undefined,
  JSON.stringify(guest.state()?.comparisons));

// ---------------------------------------------------------------- 3
console.log('\n3) 写：host 能贴转录、能改 glossary，guest 立刻看到（走广播，不用刷新）');
await emit(host.s, 'compare:glossary', { text: 'Acme\nQuicksilver' });
t('host 写的 glossary 生效了', host.state()?.settings.glossary === 'Acme\nQuicksilver');
t('★ guest 不用做任何动作也看到了 host 写的 glossary',
  guest.state()?.settings.glossary === 'Acme\nQuicksilver',
  guest.state()?.settings.glossary);

await emit(host.s, 'compare:put', { product: 'granola', transcript: 'host pasted this transcript' });
const hostRow = () => host.state()?.comparisons.find((c) => c.product === 'granola');
const guestRow = () => guest.state()?.comparisons.find((c) => c.product === 'granola');
t('host 写的转录生效了', hostRow()?.transcript === 'host pasted this transcript');
t('★ guest 不用刷新也看到了同一份转录',
  guestRow()?.transcript === 'host pasted this transcript', JSON.stringify(guestRow()));

// ---------------------------------------------------------------- 4
console.log('\n4) 收音设备的概念已经从分配逻辑里去掉了');
const devices = getDevices(roomId);
t('两台设备都在场', devices.length === 2, `${devices.length}`);
// autoAssignDevices 在两台设备都上线、且台词还没分配时已经跑过一次
// （连接时"第一台进来的设备如果还没人分到角色，顺手分一下"）——
// 两个 speaker 应该都已经被分给了在线设备中的某一个，没有谁被排除在外
const speakers = getSpeakers(roomId);
t('两个 speaker 都分到了某台设备（没有谁被当成"收音设备"排除）',
  speakers.every((s) => s.device_id), JSON.stringify(speakers.map((s) => s.device_id)));
t('分配到的设备确实是这两台里的（不是别的幽灵设备）',
  speakers.every((s) => devices.some((d) => d.id === s.device_id)));

host.s.close();
guest.s.close();
server.close();
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

console.log(`\n${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
