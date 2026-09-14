'use client';

// 设备身份存在 localStorage：刷新页面、重新加入房间都还是同一台设备，
// 分配给它的角色不会丢。

const DEVICE_ID_KEY = 'readroom:deviceId';
const DEVICE_NAME_KEY = 'readroom:deviceName';
const hostKey = (roomId: string) => `readroom:host:${roomId.toUpperCase()}`;

const ADJECTIVES = ['安静的', '靠窗的', '角落的', '临时的', '值班的', '走神的', '加班的', '路过的'];
const NOUNS = ['笔记本', '台式机', '会议机', '备用机', '工位机', '沙发机'];

function randomName() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a}${n}`;
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
