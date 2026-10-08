'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api, reportDownloadUrl } from '@/lib/api';
import type { Report, ReportData, Stat } from '@/lib/types';

const pct = (n: number | null | undefined) => (typeof n === 'number' ? `${n}%` : '—');
const diff = (n: number | null | undefined) => (typeof n === 'number' ? `${n > 0 ? '+' : ''}${n} pp` : '—');
const human = (s: string) => s.replace(/_/g, ' ');

/** 越好越绿：按指标方向给差值上色（正的差值对「越低越好」的指标是坏事） */
function diffColor(v: number | null | undefined, better: 'lower' | 'higher', stable: boolean) {
  if (typeof v !== 'number' || v === 0 || !stable) return 'var(--muted)';
  const otherBetter = better === 'lower' ? v < 0 : v > 0;
  return otherBetter ? 'var(--err)' : 'var(--ok)'; // 从 My Notes 的视角：对手更好是红色
}

/** AI 总结是 markdown；只认标题、列表、粗体，够用了，不引第三方库 */
function Markdown({ text }: { text: string }) {
  const inline = (s: string) =>
    s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part
    );
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={blocks.length}>{list.map((li, i) => <li key={i}>{inline(li)}</li>)}</ul>);
    list = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      list.push(li[1]);
      continue;
    }
    flush();
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) blocks.push(<h3 key={blocks.length} style={{ margin: '14px 0 6px', fontSize: 14 }}>{inline(h[2])}</h3>);
    else if (line.trim()) blocks.push(<p key={blocks.length} style={{ margin: '6px 0' }}>{inline(line)}</p>);
  }
  flush();
  return <div className="report-md">{blocks}</div>;
}

function StatCell({ s }: { s: Stat | undefined }) {
  if (!s || !s.n) return <td className="muted">—</td>;
  return (
    <td title={s.ci ? `95% CI ${s.ci[0]}–${s.ci[1]} · median ${s.median}` : `median ${s.median}`}>
      {pct(s.mean)} <span className="tiny muted">n={s.n}</span>
    </td>
  );
}

function Overall({ d }: { d: ReportData }) {
  return (
    <div className="table-scroll">
      <table className="scores">
        <thead>
          <tr>
            <th>Metric</th>
            {d.products.map((p) => (
              <th key={p.id}>{p.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {d.metrics.map((m) => (
            <tr key={m.key}>
              <td className="dim">
                {m.label} <span className="tiny muted">({m.better} is better)</span>
              </td>
              {d.products.map((p) => (
                <StatCell key={p.id} s={d.overall[m.key][p.id]} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Paired({ d }: { d: ReportData }) {
  const others = d.products.filter((p) => p.id !== d.baseline);
  const base = d.products.find((p) => p.id === d.baseline)?.label ?? d.baseline;
  return (
    <div className="table-scroll">
      <table className="scores">
        <thead>
          <tr>
            <th>Metric</th>
            <th>Rooms</th>
            {d.products.map((p) => (
              <th key={p.id}>{p.label}</th>
            ))}
            {others.map((p) => (
              <th key={p.id}>
                {p.label} − {base}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {d.metrics
            .filter((m) => d.paired[m.key].rooms > 0)
            .map((m) => {
              const pr = d.paired[m.key];
              return (
                <tr key={m.key}>
                  <td className="dim">{m.label}</td>
                  <td>{pr.rooms}</td>
                  {d.products.map((p) => (
                    <td key={p.id}>{pct(pr.means[p.id])}</td>
                  ))}
                  {others.map((p) => {
                    const v = pr.vsBaseline[p.id];
                    return (
                      <td
                        key={p.id}
                        style={{ color: diffColor(v.meanDiff, m.better, v.stable) }}
                        title={`${v.otherBetter} rooms ${p.label} better · ${v.baselineBetter} ${base} better · ${v.ties} ties`}
                      >
                        {diff(v.meanDiff)}
                        {v.ci && (
                          <span className="tiny muted">
                            {' '}
                            [{v.ci[0]}, {v.ci[1]}]
                          </span>
                        )}
                        {v.stable && ' ✱'}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}

const GROUP_METRICS = ['ewer', 'uer', 'wder', 'f1', 'criticalRate'];

function Groups({ d }: { d: ReportData }) {
  return (
    <>
      {d.groups.map((g) => (
        <div key={g.key} style={{ marginBottom: 14 }}>
          <h3 style={{ fontSize: 13, margin: '10px 0 6px' }}>{g.title}</h3>
          <div className="table-scroll">
            <table className="scores">
              <thead>
                <tr>
                  <th>{g.title}</th>
                  <th>Rooms</th>
                  {GROUP_METRICS.map((k) => (
                    <th key={k} colSpan={d.products.length}>
                      {d.metrics.find((m) => m.key === k)?.label}
                    </th>
                  ))}
                </tr>
                <tr>
                  <th />
                  <th />
                  {GROUP_METRICS.flatMap((k) =>
                    d.products.map((p) => (
                      <th key={`${k}-${p.id}`} className="tiny">
                        {p.label}
                      </th>
                    ))
                  )}
                </tr>
              </thead>
              <tbody>
                {g.buckets.map((b) => (
                  <tr key={b.value}>
                    <td className="dim">{b.value}</td>
                    <td>{b.rooms}</td>
                    {GROUP_METRICS.flatMap((k) =>
                      d.products.map((p) => <td key={`${k}-${p.id}`}>{pct(b.metrics[k][p.id].mean)}</td>)
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  );
}

function Errors({ d }: { d: ReportData }) {
  return (
    <div className="report-cols">
      {d.products.map((p) => {
        const e = d.errors[p.id];
        const w = d.worst[p.id];
        const miss = d.missing[p.id];
        return (
          <div key={p.id} className="card" style={{ background: 'var(--panel-2)', margin: 0 }}>
            <h3 style={{ fontSize: 14, margin: '0 0 8px' }}>{p.label}</h3>
            <p className="tiny" style={{ margin: '0 0 6px' }}>
              <strong>Summary error types:</strong>{' '}
              {Object.entries(e.errorTypes).map(([k, v]) => `${human(k)} ${v}`).join(' · ') || 'none'}
            </p>
            <p className="tiny" style={{ margin: '0 0 6px' }}>
              <strong>Critical errors:</strong>{' '}
              {Object.entries(e.criticalTypes).map(([k, v]) => `${human(k)} ${v}`).join(' · ') || 'none'}
            </p>
            {e.topEntityErrors.length > 0 && (
              <>
                <p className="tiny" style={{ margin: '8px 0 4px' }}>
                  <strong>Most frequent entity errors</strong>
                </p>
                <ul className="terms">
                  {e.topEntityErrors.slice(0, 8).map((t) => (
                    <li key={t.term}>
                      <code>{t.term}</code> ×{t.errors}
                      {t.gotAs.length > 0 && <> → {t.gotAs.map((g) => <code key={g.got} style={{ color: 'var(--err)', marginRight: 4 }}>{g.got}</code>)}</>}
                      <span className="muted"> · {t.rooms} room(s)</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {w.lowestF1.length > 0 && (
              <p className="tiny" style={{ margin: '8px 0 0' }}>
                <strong>Lowest summary F1:</strong>{' '}
                {w.lowestF1.slice(0, 5).map((r, i) => (
                  <span key={r.id}>
                    {i ? ', ' : ''}
                    <Link href={`/room/${r.id}`}>{r.id}</Link> {pct(r.value)}
                  </span>
                ))}
              </p>
            )}
            {w.highestEwer.length > 0 && (
              <p className="tiny" style={{ margin: '4px 0 0' }}>
                <strong>Highest EWER:</strong>{' '}
                {w.highestEwer.slice(0, 5).map((r, i) => (
                  <span key={r.id}>
                    {i ? ', ' : ''}
                    <Link href={`/room/${r.id}`}>{r.id}</Link> {pct(r.value)}
                  </span>
                ))}
              </p>
            )}
            <p className="tiny muted" style={{ margin: '8px 0 0' }}>
              Missing: {miss.transcript.length} transcript, {miss.summary.length} summary evaluation(s)
            </p>
          </div>
        );
      })}
    </div>
  );
}

export default function ReportPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;
    const load = async () => {
      try {
        const { report: r } = await api.getReport(id);
        if (!alive) return;
        setReport(r);
        if (r.state === 'running') timer = setTimeout(() => void load(), 2000);
      } catch (err: any) {
        if (alive) setError(err.message);
      }
    };
    void load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  if (error) {
    return (
      <div className="shell" style={{ maxWidth: 560, paddingTop: 80 }}>
        <div className="card">
          <h2>Can&apos;t open this report</h2>
          <p className="sub">{error}</p>
          <Link href="/">← Home</Link>
        </div>
      </div>
    );
  }
  if (!report) {
    return (
      <div className="shell">
        <p className="muted">Loading report…</p>
      </div>
    );
  }

  const d = report.data;
  return (
    <div className="shell">
      <div className="topbar">
        <div style={{ minWidth: 0 }}>
          <div className="tiny muted">
            Report · {report.roomCount} rooms · {new Date(report.createdAt).toLocaleString()}
          </div>
          <h1 style={{ fontSize: 22, margin: '2px 0 0' }}>{report.title}</h1>
        </div>
        <div className="row" style={{ marginLeft: 'auto', gap: 6 }}>
          {report.state === 'done' && (
            <>
              <a className="pill" href={reportDownloadUrl(report.id, 'md')}>
                Download .md
              </a>
              <a className="pill" href={reportDownloadUrl(report.id, 'csv')}>
                .csv
              </a>
              <a className="pill" href={reportDownloadUrl(report.id, 'json')}>
                .json
              </a>
            </>
          )}
          <Link href="/" className="pill">
            Home
          </Link>
        </div>
      </div>

      {report.state === 'running' && (
        <div className="card">
          <span className="pill on">
            {report.progress?.phase ?? 'running'}
            {report.progress?.total ? ` ${report.progress.done}/${report.progress.total}` : ''}…
          </span>
        </div>
      )}
      {report.state === 'failed' && (
        <div className="card" style={{ borderColor: 'rgba(239,111,111,.4)', color: 'var(--err)' }}>
          {report.error}
        </div>
      )}

      {d && (
        <>
          <div className="card">
            <h2>Summary</h2>
            {report.aiSummary ? (
              <Markdown text={report.aiSummary} />
            ) : (
              <p className="sub" style={{ margin: 0 }}>
                {report.error || 'No AI summary.'}
              </p>
            )}
            <p className="tiny muted" style={{ margin: '10px 0 0' }}>
              Written by the judge model from the numbers below only — every number is computed by code.
            </p>
          </div>

          <div className="card">
            <h2>Overall</h2>
            <p className="sub">Mean over the rooms where each product has a result (hover for the 95% CI and median).</p>
            <Overall d={d} />
          </div>

          <div className="card">
            <h2>Paired comparison</h2>
            <p className="sub">
              Only rooms where all three products have the metric, so every product is judged on the same meetings.
              Differences are other product minus My Notes with a 95% CI; ✱ = the interval excludes 0 (a stable
              difference; needs at least 3 rooms). Red = the competitor is better, green = My Notes is better.
            </p>
            <Paired d={d} />
          </div>

          <div className="card">
            <h2>By group</h2>
            <Groups d={d} />
          </div>

          <div className="card">
            <h2>Errors &amp; weakest rooms</h2>
            <Errors d={d} />
          </div>

          <details className="card">
            <summary style={{ cursor: 'pointer' }}>
              <strong>Per room ({d.perRoom.length})</strong>
            </summary>
            <div className="table-scroll" style={{ marginTop: 10 }}>
              <table className="scores">
                <thead>
                  <tr>
                    <th>Room</th>
                    <th>Lang</th>
                    <th>Sp</th>
                    <th>Order</th>
                    <th>Ambience</th>
                    {d.products.map((p) => (
                      <th key={p.id}>{p.label} EWER / UER / F1</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.perRoom.slice(0, 300).map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link href={`/room/${r.id}`}>{r.id}</Link> <span className="tiny muted">{r.title}</span>
                      </td>
                      <td>{r.language}</td>
                      <td>{r.speakers}</td>
                      <td>{r.order}</td>
                      <td>{r.noise}</td>
                      {d.products.map((p) => (
                        <td key={p.id}>
                          {pct(r.values[p.id].ewer)} / {pct(r.values[p.id].uer)} / {pct(r.values[p.id].f1)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {d.perRoom.length > 300 && (
                <p className="tiny muted">Showing 300 of {d.perRoom.length} — download the CSV for all of them.</p>
              )}
            </div>
          </details>
        </>
      )}
    </div>
  );
}
