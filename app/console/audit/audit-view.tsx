'use client';

import { useMemo, useState } from 'react';
import type { ColDef } from 'ag-grid-community';
import { X } from 'lucide-react';
import { when, type Tone } from '@/lib/cosign-format';
import type { AuditEntry } from '@/lib/cosign-types';
import { Grid } from '../grid';
import { Card, Hash } from '../ui';

export type Row = AuditEntry & { title: string; detail: string; tone: Tone };

const DOT: Record<Tone, string> = { cleared: 'bg-cs-cleared', held: 'bg-cs-held', blocked: 'bg-cs-blocked', neutral: 'bg-cs-faint', sign: 'bg-cs-sign' };
const FILTERS = [
  { key: 'all', label: 'Everything', test: () => true },
  { key: 'decisions', label: 'Decisions', test: (r: Row) => r.kind === 'payment.decided' },
  { key: 'people', label: 'Human signatures', test: (r: Row) => r.kind === 'approval.recorded' || (r.kind === 'milestone.verified' && (r.payload as { by?: string }).by === 'buyer') || r.kind.startsWith('mandate') || r.kind.startsWith('vendor') },
  { key: 'money', label: 'Money moved', test: (r: Row) => /paid|released|payout_accepted/.test(r.kind) },
  { key: 'escrow', label: 'Escrow', test: (r: Row) => r.kind.startsWith('milestone') || r.kind.startsWith('deal') },
];

const columns: ColDef<Row>[] = [
  { field: 'seq', headerName: 'No.', filter: 'agNumberColumnFilter', maxWidth: 110, sort: 'desc' },
  { field: 'ts', headerName: 'When', valueFormatter: (p) => when(p.value), minWidth: 170 },
  { field: 'title', headerName: 'Event', minWidth: 180 },
  { field: 'detail', headerName: 'Detail', flex: 2, minWidth: 260, cellClass: 'cs-cell text-cs-soft' },
  { field: 'hash', headerName: 'Seal', valueFormatter: (p) => String(p.value).slice(0, 12), cellClass: 'cs-cell cs-hash', minWidth: 140 },
];

export function AuditView({ rows }: { rows: Row[] }) {
  const [view, setView] = useState<'timeline' | 'table'>('timeline');
  const [filter, setFilter] = useState('all');
  const [sel, setSel] = useState<Row | null>(null);
  const shown = useMemo(() => rows.filter(FILTERS.find((f) => f.key === filter)!.test), [rows, filter]);
  const byDay = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of shown.slice(0, 300)) {
      const d = new Date(r.ts).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
      m.set(d, [...(m.get(d) ?? []), r]);
    }
    return [...m.entries()];
  }, [shown]);

  const toolbar = (
    <>
      <div role="tablist" aria-label="View" className="flex gap-1 rounded-lg border border-cs-edge bg-cs-paper p-1">
        {(['timeline', 'table'] as const).map((v) => (
          <button key={v} role="tab" type="button" aria-selected={view === v} onClick={() => setView(v)} className={`rounded-md px-3 py-1.5 text-sm ${view === v ? 'bg-cs-sign-wash font-semibold text-cs-sign-deep' : 'text-cs-soft'}`}>
            {v === 'timeline' ? 'Timeline' : 'Table'}
          </button>
        ))}
      </div>
      <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Show" className="h-10 rounded-lg border border-cs-edge bg-cs-paper px-3 text-sm">
        {FILTERS.map((f) => (
          <option key={f.key} value={f.key}>
            {f.label}
          </option>
        ))}
      </select>
    </>
  );

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <div>
        {view === 'table' ? (
          <Grid rows={shown} columns={columns} onRowClicked={setSel} searchLabel="Search the log" exportName="cosign-audit" toolbar={toolbar} getRowId={(r) => String(r.seq)} />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-2">{toolbar}</div>
            <div className="space-y-6">
              {byDay.map(([d, items]) => (
                <section key={d}>
                  <h2 className="mb-2 text-sm font-bold text-cs-soft">{d}</h2>
                  <Card>
                    <ol className="divide-y divide-cs-rule">
                      {items.map((r) => (
                        <li key={r.seq}>
                          <button type="button" onClick={() => setSel(r)} className={`flex w-full items-center gap-3 px-5 py-3 text-left text-sm hover:bg-cs-hover ${sel?.seq === r.seq ? 'bg-cs-sign-wash' : ''}`}>
                            <span aria-hidden className={`size-2 shrink-0 rounded-full ${DOT[r.tone]}`} />
                            <span className="w-14 shrink-0 text-xs text-cs-faint tabular-nums">{new Date(r.ts).toISOString().slice(11, 16)}</span>
                            <span className="w-44 shrink-0 truncate font-semibold">{r.title}</span>
                            <span className="min-w-0 flex-1 truncate text-cs-soft">{r.detail}</span>
                            <span className="hidden shrink-0 text-xs text-cs-faint sm:block">#{r.seq}</span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  </Card>
                </section>
              ))}
              {byDay.length === 0 && <p className="text-sm text-cs-soft">Nothing recorded for this filter yet.</p>}
            </div>
          </>
        )}
      </div>
      <aside className="xl:sticky xl:top-24">
        {sel ? (
          <Card>
            <div className="flex items-start justify-between gap-3 border-b border-cs-rule px-5 py-4">
              <div>
                <p className="font-bold">
                  Entry {sel.seq}: {sel.title}
                </p>
                <p className="text-sm text-cs-soft">{when(sel.ts)}</p>
              </div>
              <button type="button" aria-label="Close" onClick={() => setSel(null)} className="rounded p-1 text-cs-faint hover:text-cs-ink">
                <X className="size-4" />
              </button>
            </div>
            <div className="p-5 text-sm">
              <p className="text-cs-soft">{sel.detail}</p>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-cs-faint">Seal</dt>
                <dd className="break-all">
                  <Hash value={sel.hash} n={64} />
                </dd>
                <dt className="text-cs-faint">Seals entry</dt>
                <dd className="break-all">
                  <Hash value={sel.prev_hash} n={64} />
                </dd>
              </dl>
              <details className="group mt-4">
                <summary className="cursor-pointer text-sm font-semibold text-cs-sign select-none">Show the raw sealed entry</summary>
                <pre className="cs-hash cs-scroll mt-2 max-h-96 overflow-auto rounded-lg bg-cs-panel p-3 break-all whitespace-pre-wrap">{JSON.stringify(sel.payload, null, 2)}</pre>
              </details>
            </div>
          </Card>
        ) : (
          <p className="text-sm text-cs-soft">Select an entry to see exactly what was recorded and sealed.</p>
        )}
      </aside>
    </div>
  );
}
