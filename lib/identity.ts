'use client';

// 设备身份存在 localStorage：刷新页面、重新加入房间都还是同一台设备，
// 分配给它的角色不会丢。

const DEVICE_ID_KEY = 'readroom:deviceId';
const DEVICE_NAME_KEY = 'readroom:deviceName';
const hostKey = (roomId: string) => `readroom:host:${roomId.toUpperCase()}`;

const ADJECTIVES = ['Quiet', 'Window', 'Corner', 'Spare', 'Backup', 'Idle', 'Late', 'Passing'];
const NOUNS = ['laptop', 'desktop', 'meeting box', 'spare box', 'desk machine', 'couch machine'];

function randomName() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a} ${n}`;
}

export function getDeviceId(): string {
  if (typeof window === 'undefined') return '';
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export function getDeviceName(): string {
  if (typeof window === 'undefined') return '';
  let name = localStorage.getItem(DEVICE_NAME_KEY);
  if (!name) {
    name = randomName();
    localStorage.setItem(DEVICE_NAME_KEY, name);
  }
  return name;
}

export function setDeviceName(name: string) {
  localStorage.setItem(DEVICE_NAME_KEY, name);
}

export function getHostToken(roomId: string): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(hostKey(roomId));
}

export function setHostToken(roomId: string, token: string) {
  localStorage.setItem(hostKey(roomId), token);
}

/** 我创建的房间 = localStorage 里存着 host token 的那些 */
export function createdRoomIds(): string[] {
  if (typeof window === 'undefined') return [];
  const prefix = 'readroom:host:';
  const ids: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(prefix)) ids.push(k.slice(prefix.length));
  }
  return ids;
}

export function forgetRoom(roomId: string) {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(hostKey(roomId));
  const raw = localStorage.getItem('readroom:recent');
  if (raw) {
    try {
      const list: string[] = JSON.parse(raw);
      localStorage.setItem('readroom:recent', JSON.stringify(list.filter((r) => r !== roomId)));
    } catch {
      /* 坏数据就算了 */
    }
  }
}

export function rememberRoom(roomId: string) {
  if (typeof window === 'undefined') return;
  const raw = localStorage.getItem('readroom:recent');
  const list: string[] = raw ? JSON.parse(raw) : [];
  const next = [roomId, ...list.filter((r) => r !== roomId)].slice(0, 6);
  localStorage.setItem('readroom:recent', JSON.stringify(next));
}

export function recentRooms(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem('readroom:recent') || '[]');
  } catch {
    return [];
  }
}
