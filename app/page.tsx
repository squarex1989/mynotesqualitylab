'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { getDeviceName, recentRooms, rememberRoom, setDeviceName, setHostToken } from '@/lib/identity';

export default function Home() {
  const router = useRouter();
  const [joinId, setJoinId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [ttsProblem, setTtsProblem] = useState<string | null>(null);

  useEffect(() => {
    setName(getDeviceName());
    setRecent(recentRooms());
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
      const { id, hostToken } = await api.createRoom();
      setHostToken(id, hostToken);
      rememberRoom(id);
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
      setError(err.message === '房间不存在' ? `找不到房间 ${id}` : err.message);
      setBusy(null);
    }
  };

  return (
    <div className="shell" style={{ maxWidth: 640, paddingTop: 64 }}>
      <h1 style={{ fontSize: 26, margin: '0 0 6px' }}>ReadRoom</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        上传一份 transcript，把角色分给屋子里的每台电脑，让它们用各自的音色把这场对话读出来。
      </p>

      {ttsProblem && (
        <div className="card" style={{ borderColor: 'rgba(239,111,111,.4)' }}>
          <strong style={{ color: 'var(--err)' }}>{ttsProblem}</strong>
          <p className="sub" style={{ margin: '6px 0 0' }}>
            可以建房间、上传 transcript、调音色，但点「合成音频」会失败。在项目根目录的{' '}
            <code>.env</code> 里写上真正的 key 再重启服务。
          </p>
        </div>
      )}

      <div className="card">
        <label className="field">
          这台设备叫什么
          <input
            value={name}
            onChange={(e) => saveName(e.target.value)}
            placeholder="比如：客厅的 MacBook"
            maxLength={40}
          />
        </label>
        <p className="sub" style={{ margin: '8px 0 0' }}>
          房主按设备名分配角色，起个能认出来的名字。
        </p>
      </div>

      <div className="card">
        <h2>创建 room</h2>
        <p className="sub">你会成为房主，负责上传 transcript、调音色、按开始。</p>
        <button className="primary big" onClick={create} disabled={busy !== null}>
          {busy === 'create' ? '创建中…' : '创建 room'}
        </button>
      </div>

      <div className="card">
        <h2>加入 room</h2>
        <p className="sub">输入房主给你的 6 位房间号。</p>
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
            {busy === 'join' ? '加入中…' : '加入'}
          </button>
        </div>

        {recent.length > 0 && (
          <div className="row" style={{ marginTop: 14 }}>
            <span className="tiny muted">最近去过：</span>
            {recent.map((r) => (
              <button key={r} className="small ghost" onClick={() => join(r)}>
                {r}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="card" style={{ borderColor: 'rgba(239,111,111,.4)', color: 'var(--err)' }}>
          {error}
        </div>
      )}
    </div>
  );
}
