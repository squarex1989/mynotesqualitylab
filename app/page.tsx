'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { getDeviceName, rememberRoom, setDeviceName, setHostToken } from '@/lib/identity';
import { clampTitle, titleWeight, TITLE_MAX_WEIGHT } from '@/lib/roomName';
import { RoomList } from '@/components/RoomList';

export default function Home() {
  const router = useRouter();
  const [joinId, setJoinId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roomName, setRoomName] = useState('');
  const [listKey, setListKey] = useState(0);
  const [ttsProblem, setTtsProblem] = useState<string | null>(null);

  useEffect(() => {
    setName(getDeviceName());
    api.meta().then((m) => setTtsProblem(m.ttsProblem)).catch(() => {});
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
    <div className="shell" style={{ maxWidth: 640, paddingTop: 64 }}>
      <h1 style={{ fontSize: 26, margin: '0 0 6px' }}>Transcript Reader</h1>
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

      <RoomList refreshKey={listKey} />

      {error && (
        <div className="card" style={{ borderColor: 'rgba(239,111,111,.4)', color: 'var(--err)' }}>
          {error}
        </div>
      )}
    </div>
  );
}
