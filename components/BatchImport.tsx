'use client';

import { useRef, useState } from 'react';
import { api } from '@/lib/api';
import { setHostToken } from '@/lib/identity';
import type { ImportResult } from '@/lib/types';

const MAX_FILES = 100;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
// 一次请求的总体积上限。服务端 JSON 上限是 12MB，留点余量
const MAX_BATCH_BYTES = 8 * 1024 * 1024;

/**
 * 「导入 transcript 文件」：一次最多选 100 个文件，每个文件建一个房间。
 * 房间名、人数、口音、有序/无序、环境音都按文件里的要求自动配好；不合成音频。
 */
export function BatchImport({ onImported }: { onImported: () => void }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<ImportResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  const run = async (list: FileList) => {
    setError(null);
    setResults([]);
    const picked = Array.from(list);
    const skipped: ImportResult[] = [];
    if (picked.length > MAX_FILES) {
      setError(`You picked ${picked.length} files — only the first ${MAX_FILES} are imported`);
    }
    const files = picked.slice(0, MAX_FILES).filter((f) => {
      if (f.size <= MAX_FILE_BYTES) return true;
      skipped.push({ file: f.name, ok: false, error: 'File is over 4MB' });
      return false;
    });

    // 按体积分批发，免得一个请求撑爆服务端的 JSON 上限
    const batches: { name: string; text: string }[][] = [];
    let current: { name: string; text: string }[] = [];
    let size = 0;
    for (const f of files) {
      const text = await f.text();
      if (current.length && size + f.size > MAX_BATCH_BYTES) {
        batches.push(current);
        current = [];
        size = 0;
      }
      current.push({ name: f.name, text });
      size += f.size;
    }
    if (current.length) batches.push(current);

    const all: ImportResult[] = [...skipped];
    setBusy({ done: 0, total: files.length });
    try {
      for (const batch of batches) {
        const { results: got } = await api.importRooms(batch);
        for (const r of got) {
          if (r.ok && r.id && r.hostToken) {
            // 只记 host token（出现在 Your rooms）；没进过的房间不算 Recent
            setHostToken(r.id, r.hostToken);
          }
        }
        all.push(...got);
        setResults([...all]);
        setBusy((b) => (b ? { ...b, done: b.done + batch.length } : b));
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
      setResults([...all]);
      onImported();
    }
  };

  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;

  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 4 }}>
        <h2>Import transcript files</h2>
        <button className="primary" disabled={busy !== null} onClick={() => fileRef.current?.click()}>
          {busy ? `Importing ${busy.done}/${busy.total}…` : 'Import transcript files'}
        </button>
      </div>
      <p className="sub" style={{ margin: 0 }}>
        Pick up to {MAX_FILES} files — each becomes its own room. Name each file{' '}
        <strong>language + topic + speaker count + orderly / chaotic</strong>, e.g.{' '}
        <code>英文_产品评审_3人_有序.txt</code> or <code>EN-Weekly sync-4p-chaotic.txt</code>; the
        room is named and configured from that. No audio is synthesized; change anything later
        inside the room.
      </p>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept=".txt,.md,.vtt,.srt,.json,text/plain"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files?.length) void run(e.target.files);
          e.target.value = '';
        }}
      />

      {error && (
        <p className="tiny" style={{ color: 'var(--err)', marginBottom: 0 }}>
          {error}
        </p>
      )}

      {results.length > 0 && (
        <>
          <p className="tiny" style={{ margin: '10px 0 6px' }}>
            <span style={{ color: 'var(--ok)' }}>{ok} room{ok === 1 ? '' : 's'} created</span>
            {failed > 0 && <span style={{ color: 'var(--err)' }}> · {failed} failed</span>}
          </p>
          <div className="import-results">
            {results.map((r, i) => (
              <div key={`${r.file}-${i}`} className="tiny">
                {r.ok ? (
                  <>
                    <code style={{ color: 'var(--accent)' }}>{r.id}</code> <strong>{r.title}</strong>
                    <span className="muted">
                      {' '}
                      — {r.file} · {r.lineCount} lines
                    </span>
                    {r.warnings?.map((w) => (
                      <div key={w} style={{ color: 'var(--accent)' }}>
                        ⚠ {w}
                      </div>
                    ))}
                  </>
                ) : (
                  <span style={{ color: 'var(--err)' }}>
                    ✕ {r.file}: {r.error}
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
