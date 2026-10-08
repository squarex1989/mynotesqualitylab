'use client';

import { useRef, useState } from 'react';
import { api } from '@/lib/api';
import { setHostToken } from '@/lib/identity';
import type { ImportResult } from '@/lib/types';

const MAX_FILES = 100;
// script.json 和它的 answer_key.json 算一场会：最多 100 场，也就是最多 200 个文件
const MAX_PICK = MAX_FILES * 2;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const SCRIPT_RE = /\.script\.json$/i;
const ANSWER_RE = /\.answer_key\.json$/i;
const stemOf = (name: string, re: RegExp) => name.replace(re, '');

type Upload = { name: string; text: string; answerKey?: string };

/**
 * 把同名的 X.script.json 和 X.answer_key.json 配成一对，作为一个导入项发出去。
 * 分批是按体积切的，不先配对的话一对文件可能被切到两个请求里。
 */
async function pairFiles(files: File[], skipped: ImportResult[]) {
  const answers = new Map<string, File>();
  for (const f of files) if (ANSWER_RE.test(f.name)) answers.set(stemOf(f.name, ANSWER_RE), f);
  const used = new Set<string>();
  const uploads: { upload: Upload; size: number }[] = [];
  for (const f of files) {
    if (ANSWER_RE.test(f.name)) continue;
    const upload: Upload = { name: f.name, text: await f.text() };
    let size = f.size;
    if (SCRIPT_RE.test(f.name)) {
      const stem = stemOf(f.name, SCRIPT_RE);
      const key = answers.get(stem);
      if (key) {
        upload.answerKey = await key.text();
        size += key.size;
        used.add(stem);
      }
    }
    uploads.push({ upload, size });
  }
  for (const [stem, f] of answers) {
    if (!used.has(stem)) skipped.push({ file: f.name, ok: false, error: `No matching ${stem}.script.json` });
  }
  return uploads;
}
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
    if (picked.length > MAX_PICK) {
      setError(`You picked ${picked.length} files — only the first ${MAX_PICK} are read`);
    }
    const sized = picked.slice(0, MAX_PICK).filter((f) => {
      if (f.size <= MAX_FILE_BYTES) return true;
      skipped.push({ file: f.name, ok: false, error: 'File is over 4MB' });
      return false;
    });
    let uploads = await pairFiles(sized, skipped);
    if (uploads.length > MAX_FILES) {
      setError(`That is ${uploads.length} meetings — only the first ${MAX_FILES} are imported`);
      uploads = uploads.slice(0, MAX_FILES);
    }
    const files = uploads;

    // 按体积分批发，免得一个请求撑爆服务端的 JSON 上限
    const batches: Upload[][] = [];
    let current: Upload[] = [];
    let size = 0;
    for (const { upload, size: n } of uploads) {
      if (current.length && size + n > MAX_BATCH_BYTES) {
        batches.push(current);
        current = [];
        size = 0;
      }
      current.push(upload);
      size += n;
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
        room is named and configured from that. <code>X.script.json</code> files are configured from
        the script itself, and a matching <code>X.answer_key.json</code> picked along with it is
        imported into the same room. No audio is synthesized; change anything later inside the room.
      </p>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept=".txt,.md,.vtt,.srt,.json,text/plain,application/json"
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
                      {r.scriptMode && (r.hasAnswerKey ? ' · script + answer key' : ' · script')}
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
