'use client';

import type { Comparison, Meta } from '@/lib/types';

const FALLBACK_PRODUCTS = [
  { id: 'my-notes', label: 'My Notes' },
  { id: 'granola', label: 'Granola' },
  { id: 'otter', label: 'Otter' },
];

/**
 * 房间里的状态栏：三个产品 × {transcript, summary} 有没有贴进来。
 * 贴了是绿点，没贴是灰点。点一下打开 Compare 弹窗的 Input 页（有权限的话）。
 */
export function CompareStatus({
  meta,
  comparisons,
  onOpen,
}: {
  meta: Meta | null;
  comparisons: Comparison[];
  onOpen?: () => void;
}) {
  const products = meta?.compare.products ?? FALLBACK_PRODUCTS;
  const byProduct = new Map(comparisons.map((c) => [c.product, c]));
  const rows: { key: 'transcript' | 'summary'; label: string }[] = [
    { key: 'transcript', label: 'Transcript' },
    { key: 'summary', label: 'Summary' },
  ];

  return (
    <div
      className={`card compare-status${onOpen ? ' clickable' : ''}`}
      onClick={onOpen}
      title={onOpen ? 'Open Compare → Input' : undefined}
    >
      <table>
        <thead>
          <tr>
            <th />
            {products.map((p) => (
              <th key={p.id}>{p.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="muted">{r.label}</td>
              {products.map((p) => {
                const pasted = Boolean(byProduct.get(p.id)?.[r.key]?.trim());
                return (
                  <td key={p.id}>
                    <span
                      className={`dot${pasted ? ' ok' : ''}`}
                      aria-label={`${p.label} ${r.label}: ${pasted ? 'pasted' : 'missing'}`}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
