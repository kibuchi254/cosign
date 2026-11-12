import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { ArrowLeft, FileUp } from 'lucide-react';
import { getAudit, getLedger, getVendors } from '@/lib/cosign';
import { AUDIT_KIND, auditDetail, day, money, PAYMENT_STATE, REASON_LABEL, when } from '@/lib/cosign-format';
import { Avatar, ButtonLink, Card, Chip, CoreDown } from '../../ui';
import { VendorEditor } from './vendor-editor';

export const metadata: Metadata = { title: 'Vendor' };

export default async function VendorPage({ params }: PageProps<'/console/vendors/[id]'>) {
  await connection();
  const { id } = await params;
  let vendors, ledger, audit;
  try {
    [vendors, ledger, audit] = await Promise.all([getVendors(), getLedger(), getAudit(500)]);
  } catch (e) {
    return <CoreDown error={e} />;
  }
  const v = vendors.find((x) => x.id === id);
  if (!v) notFound();

  // Every invoice matched to this vendor, including ones asking to be paid at a different email
  // (the blocked "changed bank details" attempts belong here too), plus any invoice under another
  // name that asked to be paid at this vendor's email.
  const email = v.paypal_email.toLowerCase();
  const payments = ledger.payments.filter((p) => p.vendor_id === id || p.receiver_email.toLowerCase() === email);
  const stopped = payments.filter((p) => p.state === 'BLOCKED' || p.state === 'DENIED');
  const history = audit.filter((e) => (e.payload as { vendor_id?: string }).vendor_id === id);

  return (
    <div className="mx-auto max-w-6xl">
      <Link href="/console/vendors" className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-cs-soft hover:text-cs-ink">
        <ArrowLeft aria-hidden className="size-4" /> All vendors
      </Link>
      <header className="mb-6 flex flex-wrap items-center gap-4">
        <Avatar name={v.name} />
        <div className="min-w-0 flex-1">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold tracking-tight">
            {v.name}
            {v.active ? <Chip tone="cleared">Approved</Chip> : <Chip tone="neutral">Inactive</Chip>}
          </h1>
          <p className="text-sm text-cs-soft">
            Paid only at <span className="font-semibold text-cs-ink">{v.paypal_email}</span>. Approved {day(v.verified_at)}
            {v.updated_at !== v.verified_at ? `, last changed ${day(v.updated_at)}` : ''}.
          </p>
        </div>
        <ButtonLink href="/console/invoices/new" variant="quiet">
          <FileUp aria-hidden className="size-4" /> Add an invoice
        </ButtonLink>
      </header>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ['Invoices', String(payments.length)],
          ['Paid or on its way', money(v.paid_cents, 'USD')],
          ['Stopped', String(stopped.length)],
          ['Last invoice', v.last_invoice_at ? day(v.last_invoice_at) : 'None yet'],
        ].map(([k, val]) => (
          <div key={k} className="cs-card px-4 py-3">
            <p className="text-xs text-cs-soft">{k}</p>
            <p className="mt-0.5 text-lg font-bold tabular-nums">{val}</p>
          </div>
        ))}
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Card>
            <h2 className="border-b border-cs-rule px-5 py-3.5 font-bold">Invoices</h2>
            {payments.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-cs-soft">No invoices from {v.name} yet.</p>
            ) : (
              <ul className="divide-y divide-cs-rule">
                {payments.map((p) => {
                  const s = PAYMENT_STATE[p.state];
                  const first = p.reasons[0] ? REASON_LABEL[p.reasons[0].code] ?? p.reasons[0].code : 'Inside every limit';
                  const signed = p.decision === 'REQUIRE_APPROVAL' && ['APPROVED', 'SUBMITTED', 'PAID'].includes(p.state);
                  const why = signed ? `Held (${first.toLowerCase()}), then signed` : first;
                  return (
                    <li key={p.payment_id}>
                      <Link href={`/console/payments?id=${p.payment_id}`} className="flex items-center gap-4 px-5 py-3 hover:bg-cs-hover">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold">#{p.invoice_number}</span>
                          <span className="block truncate text-xs text-cs-soft">
                            {when(p.created_at)} · {why}
                          </span>
                        </span>
                        <span className="shrink-0 text-sm font-semibold tabular-nums">{money(p.amount_cents, p.currency)}</span>
                        <span className="w-32 shrink-0 text-right">
                          <Chip tone={s.tone}>{s.label}</Chip>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            <h2 className="border-b border-cs-rule px-5 py-3.5 font-bold">History</h2>
            <ol className="divide-y divide-cs-rule">
              {history.map((e) => (
                <li key={e.seq} className="flex gap-3 px-5 py-3 text-sm">
                  <span className="w-28 shrink-0 text-xs text-cs-faint tabular-nums">{when(e.ts)}</span>
                  <span className="min-w-0">
                    <span className="block font-semibold">{AUDIT_KIND[e.kind] ?? e.kind}</span>
                    <span className="block text-cs-soft">{auditDetail(e)}</span>
                  </span>
                </li>
              ))}
              {history.length === 0 && <li className="px-5 py-6 text-sm text-cs-soft">No changes recorded.</li>}
            </ol>
          </Card>
        </div>

        <VendorEditor vendor={v} />
      </div>
    </div>
  );
}
