import type { Metadata } from 'next';
import { connection } from 'next/server';
import { FileUp } from 'lucide-react';
import { getAudit, getLedger } from '@/lib/cosign';
import { AUDIT_KIND, auditDetail, auditTone } from '@/lib/cosign-format';
import { ButtonLink, CoreDown, PageHead } from '../ui';
import { PaymentsView, type TimelineStep } from './payments-view';

export const metadata: Metadata = { title: 'All payments' };

export default async function Payments({ searchParams }: PageProps<'/console/payments'>) {
  await connection();
  const { id, status } = await searchParams;
  let ledger, audit;
  try {
    [ledger, audit] = await Promise.all([getLedger(), getAudit(1000)]);
  } catch (e) {
    return <CoreDown error={e} />;
  }
  // Each payment's history, from the audit log.
  const timelines: Record<string, TimelineStep[]> = {};
  for (const e of audit) {
    const pid = (e.payload as { payment_id?: string }).payment_id;
    if (!pid) continue;
    (timelines[pid] ??= []).push({ seq: e.seq, ts: e.ts, title: AUDIT_KIND[e.kind] ?? e.kind, detail: auditDetail(e), tone: auditTone(e) });
  }
  return (
    <div className="mx-auto max-w-7xl">
      <PageHead
        title="All payments"
        lede="Every invoice Cosign has decided on. Select one to see its full history."
        actions={
          <ButtonLink href="/console/invoices/new">
            <FileUp aria-hidden className="size-4" /> Add an invoice
          </ButtonLink>
        }
      />
      <PaymentsView payments={ledger.payments} timelines={timelines} initialId={typeof id === 'string' ? id : null} initialStatus={typeof status === 'string' ? status : 'ALL'} />
    </div>
  );
}
