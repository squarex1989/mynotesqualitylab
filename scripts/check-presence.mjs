#!/usr/bin/env node
// 设备在线状态的断言。跑的是真实的 socket.io 服务端和客户端，不是假对象。
//
// 跑法：node scripts/check-presence.mjs
//
// 钉住的回归：一台设备同时有多个 socket 时，旧 socket 断开不能把设备标成离线。
//
// 手机上这是常态而不是异常：切网络或切后台时新 socket 立刻连上，旧 socket 要等
// Socket.IO 的 ping 超时（默认最长 45 秒）才触发 disconnect。原来只按 deviceId
// 记状态，那个迟到的 disconnect 把刚连上的设备又标成离线，而且再没人改回来。
// 后果有两层：界面显示 offline；房间的 autoAssignDevices 因为 keep 要求设备在线，
// 把它的角色改派给别的机器 —— 于是这台设备真念的时候一声不出（但 preview 照样响，
// 因为 preview 是直接取音频播，跟分配无关）。

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-'));

const { attachRealtime } = await import('../server/realtime.js');
const { createRoom, roomState, setTranscript, assignSpeaker, getSpeakers, upsertDevice } =
  await import('../server/rooms.js');
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

// ---------------------------------------------------------------- 启动
const server = http.createServer();
attachRealtime(server);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;

const { id: roomId, hostToken } = createRoom({ title: 'presence' });
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
    s.once('hello', () => resolve(s));
    s.once('fatal', (p) => reject(new Error(p.message)));
    s.once('connect_error', reject);
  });

/** 等服务端把状态处理完 —— disconnect 是异步到达的 */
const settle = () => new Promise((r) => setTimeout(r, 120));

const onlineOf = (deviceId) =>
  roomState(roomId).devices.find((d) => d.id === deviceId)?.online;

// ---------------------------------------------------------------- 1
console.log('\n1) 启动时把陈旧的在线状态清掉');
// 部署重启后 DB 里可能留着上次的 online=1，而此刻一个 socket 都没有
upsertDevice(roomId, { id: 'ghost', name: 'left over from last boot', isHost: false });
t('upsertDevice 会置为在线', onlineOf('ghost') === true);
const server2 = http.createServer();
attachRealtime(server2);
t('再启动一次 attachRealtime 后它变成离线', onlineOf('ghost') === false, `${onlineOf('ghost')}`);
server2.close();

// ---------------------------------------------------------------- 2
console.log('\n2) 正常连接和断开');
const phone = await open('dev-phone', 'XX 的 iPhone');
await settle();
t('连上就在线', onlineOf('dev-phone') === true, `${onlineOf('dev-phone')}`);
phone.close();
await settle();
t('断开就离线', onlineOf('dev-phone') === false, `${onlineOf('dev-phone')}`);

// ---------------------------------------------------------------- 3
console.log('\n3) 回归：同一台设备两个 socket，旧的断开不能标成离线');
const old = await open('dev-phone', 'XX 的 iPhone');
await settle();
t('旧 socket 在线', onlineOf('dev-phone') === true);

// 手机切了网络：新 socket 先连上，旧 socket 还没超时
const fresh = await open('dev-phone', 'XX 的 iPhone');
await settle();
t('新 socket 连上后仍在线', onlineOf('dev-phone') === true);

// 45 秒后旧 socket 的 disconnect 才迟到
old.close();
await settle();
t('★ 旧 socket 迟到断开后，设备仍然在线', onlineOf('dev-phone') === true,
  `${onlineOf('dev-phone')}`);

fresh.close();
await settle();
t('最后一个 socket 走了才算离线', onlineOf('dev-phone') === false, `${onlineOf('dev-phone')}`);

// ---------------------------------------------------------------- 4
console.log('\n4) 连带后果：角色不会因为一次重连被改派走');
const laptop = await open('dev-laptop', 'XX 工作电脑', true);
const phone2 = await open('dev-phone', 'XX 的 iPhone');
await settle();
assignSpeaker(roomId, 'Alice', 'dev-phone');
assignSpeaker(roomId, 'Bob', 'dev-laptop');
const owner = () => getSpeakers(roomId).find((s) => s.name === 'Alice')?.device_id;
t('Alice 归手机', owner() === 'dev-phone', `${owner()}`);

// 手机重连：新 socket 连上（这里会触发 autoAssignDevices 的检查），旧的随后超时
const phone3 = await open('dev-phone', 'XX 的 iPhone');
await settle();
phone2.close();
await settle();
t('★ 重连之后 Alice 仍然归手机', owner() === 'dev-phone', `${owner()}`);
t('手机仍在线', onlineOf('dev-phone') === true, `${onlineOf('dev-phone')}`);

// 手机真的走了：这时改派是应该的
phone3.close();
await settle();
t('手机真的离线了', onlineOf('dev-phone') === false);
const third = await open('dev-other', 'XX 个人电脑');
await settle();
t('电脑仍在线', onlineOf('dev-laptop') === true);

laptop.close();
third.close();
await settle();

console.log(`\n${pass} 项通过，${fail} 项失败\n`);
server.close();
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
