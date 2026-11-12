'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import { RotateCw, X } from 'lucide-react';
import { day, money, PAYMENT_STATE, paymentStamp, REASON_LABEL, when, type Tone } from '@/lib/cosign-format';
import type { LedgerPayment, PaymentState } from '@/lib/cosign-types';
import { retry } from '../actions';
import { Submit, withToast } from '../client';
import { Grid } from '../grid';
import { Avatar, Chip, Hash, Reasons, Stamp } from '../ui';

export type TimelineStep = { seq: number; ts: string; title: string; detail: string; tone: Tone };

const TABS: { key: string; label: string; states: PaymentState[] | null }[] = [
  { key: 'ALL', label: 'All', states: null },
  { key: 'NEEDS_APPROVAL', label: 'Needs signature', states: ['NEEDS_APPROVAL'] },
  { key: 'PAID', label: 'Paid', states: ['PAID'] },
  { key: 'IN_FLIGHT', label: 'In flight', states: ['SUBMITTED', 'ALLOWED', 'APPROVED'] },
  { key: 'BLOCKED', label: 'Blocked', states: ['BLOCKED'] },
  { key: 'DENIED', label: 'Denied or failed', states: ['DENIED', 'FAILED'] },
];

const VendorCell = ({ data }: ICellRendererParams<LedgerPayment>) =>
  data ? (
    <span className="flex h-full w-full min-w-0 items-center gap-3 overflow-hidden">
      <Avatar name={data.vendor_name} size="sm" />
      <span className="min-w-0 leading-tight">
        <span className="block truncate font-semibold">{data.vendor_name}</span>
        <span className="block truncate text-xs text-cs-faint">#{data.invoice_number}</span>
      </span>
    </span>
  ) : null;

const StateCell = ({ data }: ICellRendererParams<LedgerPayment>) => {
  if (!data) return null;
  const s = PAYMENT_STATE[data.state];
  return (
    <span className="flex h-full items-center">
      <Chip tone={s.tone}>{s.label}</Chip>
    </span>
  );
};

const columns: ColDef<LedgerPayment>[] = [
  { field: 'vendor_name', headerName: 'Vendor', cellRenderer: VendorCell, minWidth: 210, flex: 2, getQuickFilterText: (p) => `${p.data?.vendor_name} ${p.data?.invoice_number} ${p.data?.receiver_email}` },
  { field: 'amount_cents', headerName: 'Amount', type: 'rightAligned', filter: 'agNumberColumnFilter', cellClass: 'cs-cell cs-cell-end font-semibold tabular-nums', valueFormatter: (p) => (p.data ? money(p.data.amount_cents, p.data.currency) : ''), width: 130 },
  { field: 'state', headerName: 'Status', cellRenderer: StateCell, width: 160, valueFormatter: (p) => (p.value ? PAYMENT_STATE[p.value as PaymentState].label : '') },
  { headerName: 'Why', valueGetter: (p) => (p.data?.reasons[0] ? REASON_LABEL[p.data.reasons[0].code] : 'Inside every limit'), flex: 2, minWidth: 190, cellClass: 'cs-cell text-cs-soft' },
  { field: 'created_at', headerName: 'Decided', valueFormatter: (p) => when(p.value), sort: 'desc', width: 170 },
  { field: 'receiver_email', headerName: 'Pays', minWidth: 170, flex: 1.5, cellClass: 'cs-cell text-cs-soft' },
];

export function PaymentsView({
  payments,
  timelines,
  initialId,
  initialStatus,
}: {
  payments: LedgerPayment[];
  timelines: Record<string, TimelineStep[]>;
  initialId: string | null;
  initialStatus: string;
}) {
  const [tab, setTab] = useState(TABS.some((t) => t.key === initialStatus) ? initialStatus : 'ALL');
  const [selectedId, setSelectedId] = useState<string | null>(initialId);
  const selected = payments.find((p) => p.payment_id === selectedId) ?? null;
  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.key, t.states ? payments.filter((p) => t.states!.includes(p.state)).length : payments.length])), [payments]);
  const rows = useMemo(() => {
    const t = TABS.find((x) => x.key === tab);
    return t?.states ? payments.filter((p) => t.states!.includes(p.state)) : payments;
  }, [tab, payments]);

  return (
    <>
      <Grid
        rows={rows}
        columns={columns}
        onRowClicked={(p) => setSelectedId(p.payment_id)}
        getRowId={(p) => p.payment_id}
        searchLabel="Search vendor, invoice or email"
        exportName="cosign-payments"
        toolbar={
          <div role="tablist" aria-label="Filter by status" className="flex max-w-full gap-1 overflow-x-auto rounded-lg border border-cs-edge bg-cs-paper p-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                role="tab"
                type="button"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm whitespace-nowrap ${tab === t.key ? 'bg-cs-sign-wash font-semibold text-cs-sign-deep' : 'text-cs-soft hover:text-cs-ink'}`}
              >
                {t.label}
                <span className="rounded-full bg-cs-rule px-1.5 text-xs text-cs-soft tabular-nums">{counts[t.key]}</span>
              </button>
            ))}
          </div>
        }
      />
      {selected && <Drawer p={selected} steps={timelines[selected.payment_id] ?? []} onClose={() => setSelectedId(null)} />}
    </>
  );
}

const DOT: Record<Tone, string> = { cleared: 'bg-cs-cleared', held: 'bg-cs-held', blocked: 'bg-cs-blocked', neutral: 'bg-cs-faint', sign: 'bg-cs-sign' };

function Drawer({ p, steps, onClose }: { p: LedgerPayment; steps: TimelineStep[]; onClose: () => void }) {
  const stamp = paymentStamp(p);
  const unknown = p.state === 'SUBMITTED' && !p.payout_ref && !!p.failure;
  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={`${p.vendor_name} invoice ${p.invoice_number}`} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/25" onClick={onClose} />
      <aside className="cs-slide-in cs-scroll absolute inset-y-0 right-0 flex w-full max-w-md flex-col overflow-y-auto bg-cs-paper" style={{ boxShadow: 'var(--cs-shadow-lift)' }}>
        <div className="flex items-start gap-3 border-b border-cs-rule p-5">
          <Avatar name={p.vendor_name} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-bold">
              {p.vendor_id ? (
                <Link href={`/console/vendors/${p.vendor_id}`} className="hover:text-cs-sign hover:underline">
                  {p.vendor_name}
                </Link>
              ) : (
                p.vendor_name
              )}
            </h2>
            <p className="text-sm text-cs-soft">
              Invoice {p.invoice_number}
              {p.due_date && `, due ${day(p.due_date)}`}
            </p>
          </div>
          <button type="button" autoFocus onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-cs-soft hover:bg-cs-hover">
            <X className="size-5" />
          </button>
        </div>
        <div className="flex items-center justify-between gap-4 pt-5 pr-7 pl-5">
          <p className="text-3xl font-bold tabular-nums">{money(p.amount_cents, p.currency)}</p>
          <Stamp tone={stamp.tone} sub={stamp.sub}>
            {stamp.label}
          </Stamp>
        </div>
        <section className="px-5 pt-6">
          <h3 className="mb-3 text-sm font-bold">Why it was decided this way</h3>
          <Reasons reasons={p.reasons} empty="Approved vendor, payout email on file, inside every limit." />
        </section>
        {unknown && (
          <form action={withToast(retry, 'Retried')} className="mx-5 mt-5 rounded-xl border border-cs-held/40 bg-cs-held-wash p-4">
            <input type="hidden" name="payment_id" value={p.payment_id} />
            <p className="text-sm font-semibold">PayPal did not confirm this payout</p>
            <p className="mt-1 text-sm text-cs-soft">Retrying reuses the same request ID, so it cannot pay twice.</p>
            <div className="mt-3">
              <Submit pending="Retrying…" size="sm">
                <RotateCw aria-hidden className="size-3.5" /> Retry the payout
              </Submit>
            </div>
          </form>
        )}
        <section className="px-5 pt-6">
          <h3 className="mb-3 text-sm font-bold">History</h3>
          <ol className="relative ml-1 border-l border-cs-rule">
            {steps.map((s) => (
              <li key={s.seq} className="relative pb-5 pl-5 last:pb-0">
                <span className={`absolute top-1 -left-[5px] size-2.5 rounded-full ring-4 ring-cs-paper ${DOT[s.tone]}`} aria-hidden />
                <p className="text-sm font-semibold">{s.title}</p>
                <p className="text-sm break-words text-cs-soft">{s.detail}</p>
                <p className="text-xs text-cs-faint">
                  {when(s.ts)}, audit entry {s.seq}
                </p>
              </li>
            ))}
          </ol>
        </section>
        <dl className="mx-5 my-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-xl bg-cs-panel p-4 text-xs">
          <dt className="text-cs-faint">Pays</dt>
          <dd className="break-all">{p.receiver_email}</dd>
          <dt className="text-cs-faint">Approved vendor</dt>
          <dd>{p.vendor_known ? 'Yes' : 'No'}</dd>
          <dt className="text-cs-faint">Decision</dt>
          <dd>
            <Hash value={p.decision_hash} n={24} />
          </dd>
          <dt className="text-cs-faint">Mandate</dt>
          <dd>
            <Hash value={p.mandate_hash} n={24} />
          </dd>
          {p.payout_ref && (
            <>
              <dt className="text-cs-faint">PayPal ref</dt>
              <dd>
                <Hash value={p.payout_ref} n={28} />
              </dd>
            </>
          )}
          {p.failure && (
            <>
              <dt className="text-cs-faint">PayPal said</dt>
              <dd className="text-cs-blocked">{p.failure}</dd>
            </>
          )}
        </dl>
      </aside>
    </div>
  );
}
