import type { Metadata } from 'next';
import { connection } from 'next/server';
import { aiEnabled, aiModels } from '@/lib/ai';
import { getDeals, getLedger } from '@/lib/cosign';
import { REASON_LABEL, OUTCOME, PAYMENT_STATE, MILESTONE_STATE } from '@/lib/cosign-format';
import { CoreDown, PageHead } from '../ui';
import { CosignStudio, type StudioRows } from './studio';

export const metadata: Metadata = { title: 'Reports' };

export default async function Report() {
  await connection();
  let ledger, deals;
  try {
    [ledger, deals] = await Promise.all([getLedger(), getDeals()]);
  } catch (e) {
    return <CoreDown error={e} />;
  }
  // Flat rows for AG Studio, money in units (not cents), labels in plain language.
  const rows: StudioRows = {
    payments: ledger.payments.map((p) => ({
      id: p.payment_id,
      decided: p.created_at,
      vendor: p.vendor_name,
      invoice: p.invoice_number,
      amount: p.amount_cents / 100,
      currency: p.currency,
      decision: OUTCOME[p.decision].stamp,
      status: PAYMENT_STATE[p.state].label,
      paid: p.state === 'PAID' ? p.amount_cents / 100 : 0,
      blocked: p.state === 'BLOCKED' ? p.amount_cents / 100 : 0,
      waiting: p.state === 'NEEDS_APPROVAL' ? p.amount_cents / 100 : 0,
      approvedVendor: p.vendor_known,
      flaggedByAgent: p.reasons.some((r) => r.source === 'agent'),
    })),
    reasons: ledger.payments.flatMap((p) =>
      p.reasons.map((r, i) => ({ id: `${p.payment_id}-${i}`, paymentId: p.payment_id, reason: REASON_LABEL[r.code] ?? r.code, source: r.source === 'agent' ? 'AI flag' : 'Rule', detail: r.detail })),
    ),
    milestones: deals.flatMap((d) =>
      d.milestones.map((m) => ({
        id: m.id,
        deal: d.title,
        seller: d.seller,
        stage: `${m.seq}. ${m.title}`,
        amount: m.amount_cents / 100,
        status: MILESTONE_STATE[m.state].label,
        held: ['FUNDED', 'DELIVERED', 'VERIFIED'].includes(m.state) ? m.amount_cents / 100 : 0,
        released: m.state === 'RELEASED' ? m.amount_cents / 100 : 0,
      })),
    ),
  };
  return (
    // Fill exactly the space under the top bar: 4rem header + main's padding (1.5rem top, and
    // 6rem / 2.5rem bottom on phones / desktop). The floor keeps Studio's 600px root inside the
    // box on short screens, so the page scrolls as one piece instead of leaving a gap below.
    <div className="flex h-[calc(100dvh-11.5rem)] min-h-[48rem] flex-col lg:h-[calc(100dvh-8rem)]">
      <PageHead title="Reports" lede="Spend against your mandate, what was stopped and why, and money held in escrow. Switch to edit to build your own views." />
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl">
        {rows.payments.length === 0 && rows.milestones.length === 0 ? (
          <p className="text-sm text-cs-soft">Reports fill in once Cosign has decided on some invoices.</p>
        ) : (
          <CosignStudio rows={rows} licenseKey={process.env.AG_STUDIO} aiModels={aiEnabled() ? aiModels() : undefined} />
        )}
      </div>
    </div>
  );
}
