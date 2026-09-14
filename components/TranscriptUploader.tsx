'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { getHostToken } from '@/lib/identity';
import type { ParsePreview } from '@/lib/types';

const SAMPLE = `Alice: 我们先过一下上周的数据。
Bob: 等一下，我这边的图还没刷出来。
Alice: 没事，我先说结论——留存掉了三个点。
Carol: 三个点是环比还是同比？
Alice: 环比。同比还是涨的。
Bob: 好了，我看到了。掉的主要是新用户第二天。`;

export function TranscriptUploader({ roomId }: { roomId: string }) {
  const [text, setText] = useState('');
  const [merge, setMerge] = useState(true);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [preview, setPreview] = useState<ParsePreview | null>(null);
  const [parsing, setParsing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // 边打边解析，让人在提交前就看清楚会变成什么样
  useEffect(() => {
    if (!text.trim()) {
      setPreview(null);
      return;
    }
    setParsing(true);
    const timer = setTimeout(() => {
      api
        .previewTranscript(text, merge, excluded)
        .then(setPreview)
        .catch((err) => setError(err.message))
        .finally(() => setParsing(false));
    }, 450);
    return () => clearTimeout(timer);
  }, [text, merge, excluded]);

  const onFile = async (file: File) => {
    setError(null);
    if (file.size > 8 * 1024 * 1024) {
      setError('文件超过 8MB，太大了');
      return;
    }
    setText(await file.text());
  };

  const upload = async () => {
    const token = getHostToken(roomId);
    if (!token) {
      setError('本机不是这个房间的房主，无法上传');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      await api.uploadTranscript(roomId, token, text, merge, excluded);
      // 上传成功后 socket 会推新状态过来，这里不用自己刷
    } catch (err: any) {
      setError(err.message);
      setUploading(false);
      setConfirming(false);
    }
  };

  const ready = Boolean(preview && preview.lineCount > 0);

  return (
    <div className="card">
      <h2>上传 transcript</h2>
      <p className="sub">
        每行 <code>说话人: 内容</code>。带时间戳的会议纪要（Zoom / 腾讯会议那种）也认，
        时间戳会自动去掉。
      </p>

      <div className="row" style={{ marginBottom: 10 }}>
        <button className="small" onClick={() => fileRef.current?.click()}>
          选个文件
        </button>
        <button className="small ghost" onClick={() => setText(SAMPLE)}>
          塞一段示例
        </button>
        <label className="row tiny muted" style={{ gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={merge}
            onChange={(e) => setMerge(e.target.checked)}
            style={{ width: 'auto' }}
          />
          合并同一个人连着说的几句
        </label>
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.md,.vtt,.srt,.json,text/plain"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
            e.target.value = '';
          }}
        />
      </div>

      <textarea
        rows={12}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'Alice: 我们先过一下上周的数据。\nBob: 等一下，我这边的图还没刷出来。'}
        onDrop={(e) => {
          const f = e.dataTransfer.files?.[0];
          if (f) {
            e.preventDefault();
            void onFile(f);
          }
        }}
      />

      {parsing && <p className="tiny muted">解析中…</p>}

      {preview && (
        <div style={{ marginTop: 14 }}>
          <div className="row">
            <span className="pill on">{preview.lineCount} 句</span>
            <span className="pill">{preview.speakers.length} 个说话人</span>
            <span className="pill">{preview.charCount.toLocaleString()} 字</span>
            <span className="pill">格式 {preview.format}</span>
          </div>

          {preview.candidates.length > 0 && (
            <>
              <p className="tiny muted" style={{ margin: '12px 0 6px' }}>
                认出来的说话人 —— 点一下可以取消，被取消的那行会并回上一句：
              </p>
              <div className="row">
                {preview.candidates.map((c) => {
                  const off = excluded.includes(c.name);
                  return (
                    <button
                      key={c.name}
                      className={`pill${off ? '' : ' on'}`}
                      style={{ cursor: 'pointer' }}
                      onClick={() =>
                        setExcluded((prev) =>
                          off ? prev.filter((n) => n !== c.name) : [...prev, c.name]
                        )
                      }
                    >
                      {off ? '✕ ' : ''}
                      {c.name} · {c.count}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {preview.warnings.map((w, i) => (
            <p key={i} className="tiny" style={{ color: 'var(--accent)', margin: '8px 0 0' }}>
              ⚠ {w}
            </p>
          ))}

          {preview.preview.length > 0 && (
            <div className="script" style={{ maxHeight: 190, marginTop: 12 }}>
              {preview.preview.map((l, i) => (
                <div key={i} className="line">
                  <span className="no">{i + 1}</span>
                  <span className="who">{l.speaker}</span>
                  <span>{l.content}</span>
                </div>
              ))}
              {preview.lineCount > preview.preview.length && (
                <p className="tiny muted" style={{ paddingLeft: 8 }}>
                  …还有 {preview.lineCount - preview.preview.length} 句
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="tiny" style={{ color: 'var(--err)' }}>
          {error}
        </p>
      )}

      <div className="row" style={{ marginTop: 16 }}>
        {!confirming ? (
          <button className="primary" disabled={!ready || uploading} onClick={() => setConfirming(true)}>
            提交 transcript
          </button>
        ) : (
          <>
            <span className="tiny" style={{ color: 'var(--accent)' }}>
              提交之后这个房间就锁定了，transcript 不能再换 —— 确认？
            </span>
            <button className="primary" onClick={upload} disabled={uploading}>
              {uploading ? '提交中…' : '确认提交'}
            </button>
            <button className="ghost small" onClick={() => setConfirming(false)} disabled={uploading}>
              再看看
            </button>
          </>
        )}
      </div>
    </div>
  );
}
