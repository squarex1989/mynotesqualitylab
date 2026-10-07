'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { getDeviceName, rememberRoom, setDeviceName, setHostToken } from '@/lib/identity';
import { clampTitle, titleWeight, TITLE_MAX_WEIGHT } from '@/lib/roomName';
import { RoomList } from '@/components/RoomList';
import { BatchImport } from '@/components/BatchImport';
import { AuthBar } from '@/components/AuthBar';
import { signIn, useAuth } from '@/lib/auth';

export default function Home() {
  const router = useRouter();
  const [joinId, setJoinId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roomName, setRoomName] = useState('');
  const [listKey, setListKey] = useState(0);
  const [ttsProblem, setTtsProblem] = useState<string | null>(null);
  const auth = useAuth();
  // 游客能加入房间，但建房 / 导入要先登录
  const needLogin = !auth.loading && auth.required && !auth.user;

  useEffect(() => {
    setName(getDeviceName());
    api.meta().then((m) => setTtsProblem(m.ttsProblem)).catch(() => {});
    // Google 登录失败时回调会把原因带在 ?authError= 上
    const authError = new URLSearchParams(window.location.search).get('authError');
    if (authError) {
      setError(authError);
      window.history.replaceState(null, '', '/');
    }
  }, []);

  const saveName = (v: string) => {
    setName(v);
    if (v.trim()) setDeviceName(v.trim());
  };

  const create = async () => {
    setBusy('create');
    setError(null);
    try {
      const { id, hostToken } = await api.createRoom(roomName.trim() || undefined);
      setHostToken(id, hostToken);
      rememberRoom(id);
      setListKey((k) => k + 1);
      router.push(`/room/${id}`);
    } catch (err: any) {
      setError(err.message);
      setBusy(null);
    }
  };

  const join = async (raw?: string) => {
    const id = (raw ?? joinId).trim().toUpperCase();
    if (!id) return;
    setBusy('join');
    setError(null);
    try {
      await api.getRoom(id);
      rememberRoom(id);
      router.push(`/room/${id}`);
    } catch (err: any) {
      setError(err.message === 'Room not found' ? `No room called ${id}` : err.message);
      setBusy(null);
    }
  };

  return (
    <div className="shell" style={{ paddingTop: 48 }}>
      <div className="spread" style={{ alignItems: 'flex-start' }}>
        <h1 style={{ fontSize: 26, margin: '0 0 6px' }}>Transcript Reader</h1>
        <AuthBar auth={auth} />
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Upload a transcript, hand each speaker to a different computer, and let them read the conversation out loud in their own voices.
      </p>

      {ttsProblem && (
        <div className="card" style={{ borderColor: 'rgba(239,111,111,.4)' }}>
          <strong style={{ color: 'var(--err)' }}>{ttsProblem}</strong>
          <p className="sub" style={{ margin: '6px 0 0' }}>
            You can still create rooms, upload transcripts and tune voices — but{' '}
            <strong>Synthesize audio</strong> will fail. Put a real key in <code>.env</code> and
            restart.
          </p>
        </div>
      )}

      {/* 左栏：建房 / 进房 / 批量导入；右栏：房间列表 */}
      <div className="home-grid">
      <div>
      <div className="card">
        <label className="field">
          Name this device
          <input
            value={name}
            onChange={(e) => saveName(e.target.value)}
            placeholder="e.g. MacBook on the couch"
            maxLength={40}
          />
        </label>
        <p className="sub" style={{ margin: '8px 0 0' }}>
          The host assigns speakers by device name, so pick something recognizable.
        </p>
      </div>

      <div className="card">
        <h2>Create a room</h2>
        {needLogin ? (
          <SignInPrompt what="create a room" configured={auth.configured} />
        ) : (
        <>
        <label className="field" style={{ marginBottom: 12 }}>
          <span className="spread">
            <span>Room name (optional)</span>
            <span className={titleWeight(roomName) > TITLE_MAX_WEIGHT * 0.9 ? '' : 'muted'}>
              {titleWeight(roomName)}/{TITLE_MAX_WEIGHT}
            </span>
          </span>
          <input
            value={roomName}
            onChange={(e) => setRoomName(clampTitle(e.target.value))}
            onKeyDown={(e) => e.key === 'Enter' && create()}
            placeholder="e.g. Weekly growth retro"
          />
        </label>
        <p className="sub" style={{ marginTop: -6 }}>
          Up to 20 CJK characters or 40 letters. You can rename it later.
        </p>
        <button className="primary big" onClick={create} disabled={busy !== null}>
          {busy === 'create' ? 'Creating…' : 'Create room'}
        </button>
        </>
        )}
      </div>

      <div className="card">
        <h2>Join a room</h2>
        <p className="sub">Enter the 6-character room code from the host.</p>
        <div className="row">
          <input
            value={joinId}
            onChange={(e) => setJoinId(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === 'Enter' && join()}
            placeholder="ABC123"
            maxLength={6}
            style={{
              width: 190,
              fontFamily: 'var(--mono)',
              fontSize: 20,
              letterSpacing: '0.2em',
              textAlign: 'center',
            }}
          />
          <button onClick={() => join()} disabled={busy !== null || joinId.trim().length < 4}>
            {busy === 'join' ? 'Joining…' : 'Join'}
          </button>
        </div>

      </div>

      {needLogin ? (
        <div className="card">
          <h2>Import transcript files</h2>
          <SignInPrompt what="import transcripts" configured={auth.configured} />
        </div>
      ) : (
        <BatchImport onImported={() => setListKey((k) => k + 1)} />
      )}

      {error && (
        <div className="card" style={{ borderColor: 'rgba(239,111,111,.4)', color: 'var(--err)' }}>
          {error}
        </div>
      )}
      </div>

      <div>
        {/* 登录后账号名下的房间同步到本机，同步完刷新一次列表 */}
        <RoomList refreshKey={listKey + auth.syncedAt} />
      </div>
      </div>
    </div>
  );
}

function SignInPrompt({ what, configured }: { what: string; configured: boolean }) {
  return (
    <>
      <p className="sub">
        Sign in to {what}. Guests can still join a room and read lines without an account.
      </p>
      {configured ? (
        <button className="primary" onClick={signIn}>
          Sign in with Google
        </button>
      ) : (
        <p className="tiny" style={{ color: 'var(--err)', margin: 0 }}>
          Google sign-in is not configured on this server — set GOOGLE_CLIENT_ID and
          GOOGLE_CLIENT_SECRET.
        </p>
      )}
    </>
  );
}
