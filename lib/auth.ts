'use client';

import { useEffect, useState } from 'react';
import { createdRoomIds, getHostToken, setHostToken, forgetRoom } from './identity';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
}

export interface AuthState {
  loading: boolean;
  user: AuthUser | null;
  /** Server has Google sign-in configured */
  configured: boolean;
  /** Creating rooms / importing requires sign-in */
  required: boolean;
  /** Bumps once the account's rooms have been synced to this device */
  syncedAt: number;
}

// 账号名下的房间同步到本机后记一份清单，退出登录时把这些 host token 一起清掉
const ACCOUNT_ROOMS_KEY = 'readroom:accountRooms';

let mePromise: Promise<Omit<AuthState, 'loading' | 'syncedAt'>> | null = null;
let syncPromise: Promise<void> | null = null;

function fetchMe() {
  if (!mePromise) {
    mePromise = fetch('/api/auth/me')
      .then((r) => r.json())
      .then((b) => ({ user: b.user ?? null, configured: Boolean(b.configured), required: Boolean(b.required) }))
      .catch(() => ({ user: null, configured: false, required: false }));
  }
  return mePromise;
}

/**
 * 登录后：先把本机存着 token、还没有主人的老房间认领到账号上，再把账号名下全部房间的
 * host token 拉到本机 —— 这样「房主靠 host token」的那些老流程在新设备上也照常工作。
 * 每次页面加载只做一次。
 */
function syncRooms() {
  if (!syncPromise) {
    syncPromise = (async () => {
      const local = createdRoomIds()
        .map((id) => ({ id, hostToken: getHostToken(id) }))
        .filter((r) => r.hostToken);
      if (local.length) {
        await fetch('/api/rooms/claim', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rooms: local }),
        }).catch(() => {});
      }
      const r = await fetch('/api/rooms/mine');
      if (!r.ok) return;
      const { rooms } = (await r.json()) as { rooms: { id: string; hostToken: string }[] };
      for (const room of rooms) setHostToken(room.id, room.hostToken);
      localStorage.setItem(ACCOUNT_ROOMS_KEY, JSON.stringify(rooms.map((x) => x.id)));
    })().catch(() => {});
  }
  return syncPromise;
}

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    loading: true,
    user: null,
    configured: false,
    required: false,
    syncedAt: 0,
  });

  useEffect(() => {
    let alive = true;
    void fetchMe().then(async (me) => {
      if (!alive) return;
      setState((s) => ({ ...s, ...me, loading: false }));
      if (me.user) {
        await syncRooms();
        if (alive) setState((s) => ({ ...s, syncedAt: Date.now() }));
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  return state;
}

export function signIn() {
  const next = window.location.pathname + window.location.search;
  window.location.href = `/api/auth/google?next=${encodeURIComponent(next)}`;
}

export async function signOut() {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  // 账号的房间不该继续留在这台机器上当房主
  try {
    const ids: string[] = JSON.parse(localStorage.getItem(ACCOUNT_ROOMS_KEY) || '[]');
    ids.forEach(forgetRoom);
  } catch {
    /* 坏数据就算了 */
  }
  localStorage.removeItem(ACCOUNT_ROOMS_KEY);
  window.location.reload();
}
