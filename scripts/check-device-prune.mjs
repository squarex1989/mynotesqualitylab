#!/usr/bin/env node
// 清理离线设备的断言。跑法：node scripts/check-device-prune.mjs
//
// 不等真实的时钟走过 10 分钟 —— 直接改 last_seen 模拟"离线了多久"，
// 这就是 pruneOfflineDevices() 唯一依赖的判据。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'device-prune-'));

const { db } = await import('../server/db.js');
const {
  createRoom,
  upsertDevice,
  markDeviceOffline,
  pruneOfflineDevices,
  assignSpeaker,
  getSpeakers,
  getDevices,
  setTranscript,
  updateRoomSettings,
  getRoom,
} = await import('../server/rooms.js');

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

/** 直接改 last_seen，模拟"离线了 minutes 分钟" */
const backdate = (roomId, deviceId, minutesAgo) => {
  db.prepare('UPDATE devices SET last_seen = ? WHERE room_id = ? AND id = ?').run(
    Date.now() - minutesAgo * 60_000,
    roomId,
    deviceId
  );
};

const THRESHOLD = 10 * 60_000; // 跟 realtime.js 里的默认值一致

// ---------------------------------------------------------------- 1
console.log('\n1) 刚断线的设备不清 —— 断线重连本来就是常态');
const { id: r1 } = createRoom({ title: 'p1' });
upsertDevice(r1, { id: 'dev-a', name: 'A', isHost: false });
markDeviceOffline(r1, 'dev-a'); // last_seen = 现在
t('刚下线，没到阈值，不清', pruneOfflineDevices(THRESHOLD).length === 0);
t('设备还在', getDevices(r1).some((d) => d.id === 'dev-a'));

backdate(r1, 'dev-a', 5); // 离线 5 分钟，还没到 10 分钟的阈值
t('离线 5 分钟，还不够，不清', pruneOfflineDevices(THRESHOLD).length === 0);
t('设备还在', getDevices(r1).some((d) => d.id === 'dev-a'));

// ---------------------------------------------------------------- 2
console.log('\n2) 离线够久 → 清掉，且返回受影响的房间');
backdate(r1, 'dev-a', 11); // 离线 11 分钟，过了阈值
const affected = pruneOfflineDevices(THRESHOLD);
t('★ 清掉了，且报出了这个房间', affected.includes(r1), JSON.stringify(affected));
t('★ 设备真的没了', !getDevices(r1).some((d) => d.id === 'dev-a'));

// ---------------------------------------------------------------- 3
console.log('\n3) 在线的设备永远不清，不管 last_seen 多老');
const { id: r3 } = createRoom({ title: 'p3' });
upsertDevice(r3, { id: 'dev-online', name: 'Online', isHost: false });
backdate(r3, 'dev-online', 999); // online=1，但故意把 last_seen 改得很老
t('在线设备不清，即使 last_seen 很老', pruneOfflineDevices(THRESHOLD).length === 0);
t('设备还在', getDevices(r3).some((d) => d.id === 'dev-online'));

// ---------------------------------------------------------------- 4
console.log('\n4) ★ 清掉之后，分到它的角色变回未分配（不是自动改派）');
const { id: r4 } = createRoom({ title: 'p4' });
setTranscript(r4, {
  speakers: ['Alice', 'Bob'],
  lines: [
    { speaker: 'Alice', content: 'one' },
    { speaker: 'Bob', content: 'two' },
  ],
});
upsertDevice(r4, { id: 'dev-x', name: 'X', isHost: false });
upsertDevice(r4, { id: 'dev-y', name: 'Y', isHost: false });
assignSpeaker(r4, 'Alice', 'dev-x');
assignSpeaker(r4, 'Bob', 'dev-x');
markDeviceOffline(r4, 'dev-x');
backdate(r4, 'dev-x', 11);
pruneOfflineDevices(THRESHOLD);

const speakersAfter = getSpeakers(r4);
t('★ Alice 变回未分配（不是被改派给 dev-y）',
  speakersAfter.find((s) => s.name === 'Alice').device_id === null,
  JSON.stringify(speakersAfter.map((s) => [s.name, s.device_id])));
t('★ Bob 也变回未分配', speakersAfter.find((s) => s.name === 'Bob').device_id === null);
t('dev-y 没有被牵连（还在，没被清）', getDevices(r4).some((d) => d.id === 'dev-y'));

// ---------------------------------------------------------------- 5
console.log('\n5) 清掉之后，环境音设备指针和房主设备指针也不留悬空引用');
const { id: r5 } = createRoom({ title: 'p5' });
upsertDevice(r5, { id: 'dev-host', name: 'Host', isHost: true });
upsertDevice(r5, { id: 'dev-amb', name: 'Ambience', isHost: false });
updateRoomSettings(r5, { ambienceDevice: 'dev-amb' });
markDeviceOffline(r5, 'dev-host');
markDeviceOffline(r5, 'dev-amb');
backdate(r5, 'dev-host', 11);
backdate(r5, 'dev-amb', 11);
pruneOfflineDevices(THRESHOLD);
const roomAfter = getRoom(r5);
t('★ ambience_device 指针清空了', roomAfter.ambience_device === null);
t('★ host_device 指针清空了（不影响谁是房主 —— 那是 host_token 的事）',
  roomAfter.host_device === null);

// ---------------------------------------------------------------- 6
console.log('\n6) 一次扫描能处理多个房间、多台设备');
const rooms = [];
for (let i = 0; i < 3; i++) {
  const { id } = createRoom({ title: `multi-${i}` });
  upsertDevice(id, { id: `dev-${i}`, name: `D${i}`, isHost: false });
  markDeviceOffline(id, `dev-${i}`);
  backdate(id, `dev-${i}`, 11);
  rooms.push(id);
}
const multi = pruneOfflineDevices(THRESHOLD);
t('三个房间都报出来了', rooms.every((id) => multi.includes(id)), JSON.stringify(multi));
t('三台设备都清掉了', rooms.every((id) => getDevices(id).length === 0));

console.log(`\n${pass} 项通过，${fail} 项失败\n`);
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
