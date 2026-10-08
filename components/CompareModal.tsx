'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Comparison, Meta, RoomReference } from '@/lib/types';
import { RankingTable, ReferencePanel, SummaryEval, TranscriptEval, resultsMarkdown } from './EvalResults';

export type CompareTab = 'input' | 'result';

interface Props {
  meta: Meta | null;
  /** 房主和收音设备能贴转录 / 摘要、编 glossary、发起打分；其余人只看结果 */
  canEdit: boolean;
  comparisons: Comparison[];
  referenceLineCount: number;
  glossary: string;
  /** Entities + information units extracted from the script */
  reference?: RoomReference | null;
  initialTab?: CompareTab;
  onPut: (product: string, patch: { transcript?: string; summary?: string }) => void;
  onScore: (product: string) => void;
  onGlossary: (text: string) => void;
  onClose: () => void;
}

type Field = 'transcript' | 'summary';
const FIELD_LABEL: Record<Field, string> = { transcript: 'Transcript', summary: 'Summary' };

export function CompareModal({
  meta,
  canEdit,
  comparisons,
  referenceLineCount,
  glossary,
  reference,
  initialTab,
  onPut,
  onScore,
  onGlossary,
  onClose,
}: Props) {
  const products = meta?.compare.products ?? [];
  const keyProblem = meta?.compare.problem;

  const byProduct = useMemo(() => new Map(comparisons.map((c) => [c.product, c])), [comparisons]);
  const anyResult = products.some((p) => byProduct.get(p.id)?.result || byProduct.get(p.id)?.summaryResult);

  // 能编辑的人默认落在 Input；只能看的人只有 Result 可看
  const [tab, setTab] = useState<CompareTab>(
    canEdit ? initialTab ?? (anyResult ? 'result' : 'input') : 'result'
  );
  useEffect(() => {
    if (!canEdit) setTab('result');
  }, [canEdit]);

  // 草稿：`${产品}:${字段}` -> 文本。停手一会儿自动保存；服务端那份回来和草稿一致了
  // 才丢掉草稿 —— 发出去就丢的话，等广播回来的那一下框里会闪回旧文本。
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // 当前在 Input 里编辑哪个产品。手机上一屏只放一个，三个叠在一起要滚很久
  const [active, setActive] = useState<string | null>(null);
  // 剪贴板读不了时（非 https、用户拒绝）在对应的框下面提示长按粘贴
  const [pasteHint, setPasteHint] = useState<string | null>(null);
  // 打开时停在第一个还没贴全的产品上；之后只随用户切换，贴完不自己跳走
  useEffect(() => {
    if (active || !products.length) return;
    const first = products.find(
      (p) => !byProduct.get(p.id)?.transcript?.trim() || !byProduct.get(p.id)?.summary?.trim()
    );
    setActive((first ?? products[0]).id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products.length]);
  const textRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const [terms, setTerms] = useState(glossary);
  const [copied, setCopied] = useState(false);
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // 别的设备改了词表就同步过来，但不要打断正在输入的人
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setTerms(glossary);
  }, [glossary]);

  const k = (id: string, f: Field) => `${id}:${f}`;
  const saved = (id: string, f: Field) => byProduct.get(id)?.[f] ?? '';
  const textOf = (id: string, f: Field) => drafts[k(id, f)] ?? saved(id, f);
  const dirty = (id: string, f: Field) =>
    drafts[k(id, f)] !== undefined && drafts[k(id, f)] !== saved(id, f);

  const save = (id: string, f: Field) => onPut(id, { [f]: textOf(id, f) });

  // 服务端的值追上草稿了 → 草稿可以丢了
  useEffect(() => {
    setDrafts((d) => {
      const next = { ...d };
      let changed = false;
      for (const key of Object.keys(d)) {
        const [id, f] = key.split(':') as [string, Field];
        if ((byProduct.get(id)?.[f] ?? '').trim() === d[key].trim()) {
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : d;
    });
  }, [byProduct]);

  // 停手 800ms 自动保存。收音设备在手机上贴完就走，不该还要找一个 Save 按钮
  useEffect(() => {
    if (!canEdit) return;
    const timer = setTimeout(() => {
      for (const key of Object.keys(drafts)) {
        const [id, f] = key.split(':') as [string, Field];
        if (dirty(id, f)) onPut(id, { [f]: drafts[key] });
      }
    }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, canEdit]);

  const setDraft = (id: string, f: Field, text: string) =>
    setDrafts((d) => ({ ...d, [k(id, f)]: text }));

  const loadFile = async (id: string, f: Field, file: File) => {
    if (file.size > 4 * 1024 * 1024) return;
    setDraft(id, f, await file.text());
  };

  /** 从剪贴板读出来整段替换。读不了就把焦点给输入框，提示长按粘贴 */
  const pasteFromClipboard = async (id: string, f: Field) => {
    setPasteHint(null);
    try {
      if (!navigator.clipboard?.readText) throw new Error('no clipboard API');
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setPasteHint(`${k(id, f)}|The clipboard is empty — copy the ${FIELD_LABEL[f].toLowerCase()} first.`);
        return;
      }
      setDraft(id, f, text);
      onPut(id, { [f]: text }); // 粘贴是明确的动作，马上存，不等防抖
    } catch {
      textRefs.current[k(id, f)]?.focus();
      setPasteHint(`${k(id, f)}|Long-press the box and choose Paste.`);
    }
  };

  /** 转录有没保存的改动就先存再打分 —— 同一个 socket 上按顺序处理，打分拿到的是新文本 */
  const rescore = (id: string) => {
    if (dirty(id, 'transcript')) save(id, 'transcript');
    if (dirty(id, 'summary')) save(id, 'summary');
    onScore(id);
  };

  /** 把所有结果拼成 Markdown，方便贴进别处 */
  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(resultsMarkdown(products, byProduct, referenceLineCount));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* 没有剪贴板权限就算了 */
    }
  };

  const termCount = terms.split(/[\n,;、，；]/).filter((t) => t.trim()).length;

  const field = (p: { id: string; label: string }, f: Field) => {
    const text = textOf(p.id, f);
    const key = k(p.id, f);
    const hint = pasteHint?.startsWith(`${key}|`) ? pasteHint.slice(key.length + 1) : null;
    return (
      <div className="paste-field">
        <div className="spread">
          <strong>{FIELD_LABEL[f]}</strong>
          <span className="tiny" style={{ color: dirty(p.id, f) ? 'var(--accent)' : 'var(--muted)' }}>
            {dirty(p.id, f)
              ? 'Saving…'
              : text.trim()
                ? `Saved · ${text.trim().length.toLocaleString()} chars`
                : 'empty'}
          </span>
        </div>
        {canEdit && (
          <div className="paste-actions">
            <button className="primary" onClick={() => void pasteFromClipboard(p.id, f)}>
              Paste from clipboard
            </button>
            <button onClick={() => fileRefs.current[key]?.click()}>Upload file</button>
            {text && (
              <button className="ghost" onClick={() => setDraft(p.id, f, '')}>
                Clear
              </button>
            )}
            <input
              ref={(el) => {
                fileRefs.current[key] = el;
              }}
              type="file"
              accept=".txt,.md,.vtt,.srt,.json,text/plain"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void loadFile(p.id, f, file);
                e.target.value = '';
              }}
            />
          </div>
        )}
        {hint && (
          <p className="tiny" style={{ color: 'var(--accent)', margin: '6px 0 0' }}>
            {hint}
          </p>
        )}
        <textarea
          ref={(el) => {
            textRefs.current[key] = el;
          }}
          rows={8}
          value={text}
          readOnly={!canEdit}
          placeholder={
            canEdit
              ? `Copy the ${FIELD_LABEL[f].toLowerCase()} in ${p.label}, then paste it here…`
              : 'Nothing pasted yet'
          }
          onChange={(e) => {
            if (canEdit) setDraft(p.id, f, e.target.value);
          }}
          onBlur={() => {
            if (canEdit && dirty(p.id, f)) save(p.id, f);
          }}
          onDrop={
            canEdit
              ? (e) => {
                  const file = e.dataTransfer.files?.[0];
                  if (file) {
                    e.preventDefault();
                    void loadFile(p.id, f, file);
                  }
                }
              : undefined
          }
        />
      </div>
    );
  };

  const has = (id: string, f: Field) => Boolean(textOf(id, f).trim());
  const complete = (id: string) => has(id, 'transcript') && has(id, 'summary');
  const current = products.find((p) => p.id === active) ?? products[0];
  const next = current ? products.slice(products.indexOf(current) + 1).find((p) => !complete(p.id)) : undefined;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
        <div className="spread" style={{ marginBottom: 2 }}>
          <h2 style={{ margin: 0 }}>Compare</h2>
          <div className="row" style={{ gap: 6 }}>
            {tab === 'result' && anyResult && (
              <button className="small" onClick={copyAll}>
                {copied ? 'Copied' : 'Copy all results'}
              </button>
            )}
            <button className="small ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div className="tabs">
          <button
            className={tab === 'input' ? 'active' : ''}
            disabled={!canEdit}
            title={canEdit ? undefined : 'Only the host or a capture device can paste'}
            onClick={() => setTab('input')}
          >
            Input
          </button>
          <button className={tab === 'result' ? 'active' : ''} onClick={() => setTab('result')}>
            Result
          </button>
        </div>
        </div>

        {/* 只跟打分有关，贴转录的人不需要看到 */}
        {keyProblem && tab === 'result' && (
          <p className="tiny" style={{ color: 'var(--err)' }}>
            {keyProblem} — everything measured still works, but the two judged questions are skipped
            until you set the key and restart.
          </p>
        )}

        {referenceLineCount === 0 && (
          <p className="tiny" style={{ color: 'var(--err)' }}>
            This room has no script yet, so there is nothing to compare against.
          </p>
        )}

        {tab === 'input' ? (
          <>
            <p className="sub" style={{ margin: '0 0 10px' }}>
              In each product, copy its transcript and its summary, then paste them here — saved
              automatically.
            </p>

            {/* 产品切换：每个产品带两个点，分别是 transcript / summary 有没有贴 */}
            <div className="product-tabs">
              {products.map((p) => (
                <button
                  key={p.id}
                  className={current?.id === p.id ? 'active' : ''}
                  onClick={() => {
                    setActive(p.id);
                    setPasteHint(null);
                  }}
                >
                  <span>{p.label}</span>
                  <span className="row" style={{ gap: 4 }}>
                    <span className={`dot${has(p.id, 'transcript') ? ' ok' : ''}`} title="transcript" />
                    <span className={`dot${has(p.id, 'summary') ? ' ok' : ''}`} title="summary" />
                  </span>
                </button>
              ))}
            </div>

            {current &&
              (() => {
                const p = current;
                const c = byProduct.get(p.id);
                const scoring = c?.state === 'scoring' || c?.summaryState === 'scoring';
                const transcript = textOf(p.id, 'transcript');
                const summaryText = textOf(p.id, 'summary');
                return (
                  <div className="card" style={{ background: 'var(--panel-2)' }}>
                    <div className="spread" style={{ marginBottom: 10 }}>
                      <h2 style={{ margin: 0 }}>{p.label}</h2>
                      <div className="row" style={{ gap: 6 }}>
                        {(c?.result || c?.summaryResult) && !scoring && <span className="pill ok">scored</span>}
                        {canEdit && (
                          <button
                            className="small"
                            disabled={scoring || (!transcript.trim() && !summaryText.trim()) || referenceLineCount === 0}
                            onClick={() => rescore(p.id)}
                          >
                            {scoring ? 'Scoring…' : c?.result || c?.summaryResult ? 'Re-score' : 'Score'}
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="paste-grid">
                      {field(p, 'transcript')}
                      {field(p, 'summary')}
                    </div>
                    {c?.state === 'failed' && (
                      <p className="tiny" style={{ color: 'var(--err)', marginBottom: 0 }}>
                        Transcript scoring failed: {c.error}
                      </p>
                    )}
                    {c?.summaryState === 'failed' && (
                      <p className="tiny" style={{ color: 'var(--err)', marginBottom: 0 }}>
                        Summary scoring failed: {c.summaryError}
                      </p>
                    )}
                    {canEdit && complete(p.id) && next && (
                      <button
                        className="primary"
                        style={{ width: '100%', marginTop: 12 }}
                        onClick={() => {
                          setActive(next.id);
                          setPasteHint(null);
                        }}
                      >
                        Done — next: {next.label} →
                      </button>
                    )}
                  </div>
                );
              })()}

            {/* 词表不是每次都要动，收起来，别把手机屏幕占满 */}
            <details className="card" style={{ background: 'var(--panel-2)' }}>
              <summary className="tiny" style={{ cursor: 'pointer' }}>
                Glossary {termCount ? `(${termCount})` : '(optional)'}
              </summary>
              <label className="field" style={{ marginTop: 10 }}>
                <span className="spread">
                  <span>Names, products, jargon (one per line)</span>
                  <span className="muted">{termCount || 'none'}</span>
                </span>
                <textarea
                  rows={3}
                  value={terms}
                  readOnly={!canEdit}
                  placeholder={'Priya Raghavan\nAcme Robotics\nQuicksilver'}
                  onFocus={() => {
                    focused.current = true;
                  }}
                  onBlur={() => {
                    focused.current = false;
                    if (canEdit && terms !== glossary) onGlossary(terms);
                  }}
                  onChange={(e) => {
                    if (canEdit) setTerms(e.target.value);
                  }}
                  style={{ fontSize: 12.5 }}
                />
              </label>
              <p className="sub" style={{ margin: '8px 0 0' }}>
                These count triple when scoring transcripts, and each one is checked individually.
                Speaker names from the script and anything containing a digit are included
                automatically. Chinese and Japanese have no capitalisation, so for those this list
                is the only way to mark proper nouns.
              </p>
            </details>
          </>
        ) : (
          <>
            <p className="sub">
              Checked against this room&apos;s script ({referenceLineCount} lines), following the
              team&apos;s quality-measurement doc. Every number is computed by code from per-item
              verdicts{meta?.compare.model ? ` given by ${meta.compare.model}` : ''} — the model never
              scores directly. Expand any row to see the evidence.
            </p>

            {!canEdit && (
              <p className="tiny muted" style={{ margin: '0 0 10px' }}>
                Only the host or a capture device can paste transcripts or run scoring.
              </p>
            )}

            {anyResult && (
              <div className="card" style={{ background: 'var(--panel-2)' }}>
                <h2 style={{ margin: '0 0 6px' }}>Side by side</h2>
                <RankingTable products={products} byProduct={byProduct} />
                <p className="tiny muted" style={{ margin: '8px 0 0' }}>
                  Lower is better for EWER / UER / WDER; higher for the rest. Critical errors are a
                  guardrail — a better F1 never offsets them.
                </p>
              </div>
            )}

            {products.map((p) => {
              const c = byProduct.get(p.id);
              return (
                <div key={p.id} className="card" style={{ background: 'var(--panel-2)' }}>
                  <h2 style={{ margin: 0 }}>{p.label}</h2>
                  <h3 className="tiny" style={{ margin: '12px 0 6px' }}>
                    Transcript
                  </h3>
                  <TranscriptEval c={c} />
                  <h3 className="tiny" style={{ margin: '16px 0 6px' }}>
                    Summary &amp; action items
                  </h3>
                  <SummaryEval c={c} />
                </div>
              );
            })}

            <details className="card" style={{ background: 'var(--panel-2)' }}>
              <summary className="tiny" style={{ cursor: 'pointer' }}>
                Reference from the script — entities and expected information units
              </summary>
              <div style={{ marginTop: 8 }}>
                <ReferencePanel reference={reference} />
              </div>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
