'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { getHostToken } from '@/lib/identity';
import type { ParsePreview } from '@/lib/types';

const SAMPLE = `Alice: Let's start with last week's numbers.
Bob: Hold on, my chart hasn't loaded yet.
Alice: Never mind, I'll give you the conclusion — retention dropped three points.
Carol: Three points week over week, or year over year?
Alice: Week over week. Year over year we're still up.
Bob: Okay, I see it now. It's mostly day-two for new users.
Carol: So what did we ship last week?
Bob: We moved the skip button down in the third onboarding step.
Alice: Then that's almost certainly it.
Carol: Do we roll it back?
Alice: Roll it back first, then run a proper A/B.`;

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
      setError('That file is over 8MB — too big');
      return;
    }
    setText(await file.text());
  };

  const upload = async () => {
    const token = getHostToken(roomId);
    if (!token) {
      setError('This device is not the host of this room');
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
      <h2>Upload a transcript</h2>
      <p className="sub">
        One line per turn: <code>Speaker: text</code>. Timestamped meeting notes (Zoom, Teams and
        friends) work too — the timestamps are stripped automatically.
      </p>

      <div className="row" style={{ marginBottom: 10 }}>
        <button className="small" onClick={() => fileRef.current?.click()}>
          Choose a file
        </button>
        <button className="small ghost" onClick={() => setText(SAMPLE)}>
          Insert a sample
        </button>
        <label className="row tiny muted" style={{ gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={merge}
            onChange={(e) => setMerge(e.target.checked)}
            style={{ width: 'auto' }}
          />
          Merge consecutive turns by the same speaker
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
        placeholder={"Alice: Let's start with last week's numbers.\nBob: Hold on, my chart hasn't loaded yet."}
        onDrop={(e) => {
          const f = e.dataTransfer.files?.[0];
          if (f) {
            e.preventDefault();
            void onFile(f);
          }
        }}
      />

      {parsing && <p className="tiny muted">Parsing…</p>}

      {preview && (
        <div style={{ marginTop: 14 }}>
          <div className="row">
            <span className="pill on">{preview.lineCount} lines</span>
            <span className="pill">{preview.speakers.length} speakers</span>
            <span className="pill">{preview.charCount.toLocaleString()} chars</span>
            <span className="pill">{preview.format}</span>
          </div>

          {preview.candidates.length > 0 && (
            <>
              <p className="tiny muted" style={{ margin: '12px 0 6px' }}>
                Detected speakers — click one to reject it; that line merges into the previous turn:
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
                  …and {preview.lineCount - preview.preview.length} more
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
            Submit transcript
          </button>
        ) : (
          <>
            <span className="tiny" style={{ color: 'var(--accent)' }}>
              Once submitted this room is locked and the transcript can't be replaced. Sure?
            </span>
            <button className="primary" onClick={upload} disabled={uploading}>
              {uploading ? 'Submitting…' : 'Yes, submit'}
            </button>
            <button className="ghost small" onClick={() => setConfirming(false)} disabled={uploading}>
              Let me look again
            </button>
          </>
        )}
      </div>
    </div>
  );
}
