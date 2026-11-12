import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { ArrowLeft, Landmark, ShieldCheck, Sparkles } from 'lucide-react';
import { getDeals, getLedger, reviewPayment } from '@/lib/cosign';
import { ago, day, money, when, canApproveVendor } from '@/lib/cosign-format';
import type { LedgerPayment, Review } from '@/lib/cosign-types';
import { Avatar, Card, CoreDown, Empty, Hash, PageHead, Reasons, Stamp } from '../ui';
import { InboxList } from './inbox-list';
import { SignForm } from './sign-form';

export const metadata: Metadata = { title: 'Needs your signature' };

export default async function Inbox({ searchParams }: PageProps<'/console/inbox'>) {
  await connection();
  const { id } = await searchParams;
  let ledger, deals;
  try {
    [ledger, deals] = await Promise.all([getLedger(), getDeals()]);
  } catch (e) {
    return <CoreDown error={e} />;
  }
  // Oldest first: the one that has waited longest is at the top.
  const waiting = ledger.payments.filter((p) => p.state === 'NEEDS_APPROVAL').reverse();
  const held = deals.flatMap((d) => d.milestones.filter((m) => m.state === 'DELIVERED' && m.hold_reasons.length > 0 && !m.buyer_accepted_hold).map((m) => ({ d, m })));
  // ?id= (empty) is the phone's list view; an unknown id (just approved) falls back to the next one.
  const selected = id === '' ? null : (waiting.find((p) => p.payment_id === id) ?? waiting[0] ?? null);
  // The agent's second opinion is advisory; if the agent is down the card still works.
  const review = selected
    ? await reviewPayment({
        vendor_name: selected.vendor_name,
        invoice_number: selected.invoice_number,
        amount: selected.amount,
        currency: selected.currency,
        decision: selected.decision,
        reasons: selected.reasons,
        agent_flags: selected.agent_flags,
      }).catch(() => null)
    : null;

  if (waiting.length === 0 && held.length === 0) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHead title="Needs your signature" />
        <Empty title="You are all caught up" icon={ShieldCheck}>
          Cosign paid everything inside your mandate on its own. New exceptions appear here, and in the bell at the top, as invoices arrive.
        </Empty>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl">
      <PageHead
        title="Needs your signature"
        lede="Only the exceptions. Each one shows why it was held, the agent's second opinion, and exactly what approving it will pay. Blocked payments are not here: nobody can approve those."
      />
      <div className="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <div className={selected ? 'hidden lg:block' : ''}>
          <InboxList
            items={waiting.map((p) => ({
              id: p.payment_id,
              hash: p.decision_hash,
              vendor: p.vendor_name,
              label: `${p.vendor_name} invoice ${p.invoice_number}`,
              amount: money(p.amount_cents, p.currency),
              reason: p.reasons[0]?.code ?? null,
              count: p.reasons.length,
              waited: ago(p.created_at),
              blockedForBulk: p.reasons.some((r) => r.source === 'agent'),
            }))}
            selectedId={selected?.payment_id ?? null}
          />
          {held.length > 0 && (
            <Card className="mt-4" title="Held deliveries">
              <ul className="divide-y divide-cs-rule">
                {held.map(({ d, m }) => (
                  <li key={m.id}>
                    <Link href={`/console/milestones#${m.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-cs-hover">
                      <span className="flex size-10 items-center justify-center rounded-full bg-cs-held-wash text-cs-held">
                        <Landmark aria-hidden className="size-5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">{m.title}</span>
                        <span className="block truncate text-xs text-cs-soft">{d.title}</span>
                      </span>
                      <span className="text-sm font-semibold tabular-nums">{money(m.amount_cents, m.currency)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
        {selected ? <Detail p={selected} review={review} /> : <Empty title="Select a payment">Pick one on the left to review it.</Empty>}
      </div>
    </div>
  );
}

function Detail({ p, review }: { p: LedgerPayment; review: Review | null }) {
  const rec = review?.recommendation;
  return (
    <Card className="overflow-hidden">
      <Link href="/console/inbox?id=" className="flex items-center gap-1 border-b border-cs-rule px-5 py-3 text-sm font-semibold text-cs-sign lg:hidden">
        <ArrowLeft aria-hidden className="size-4" /> All waiting payments
      </Link>
      <div className="grid xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="p-5 sm:p-6">
          <div className="flex items-start gap-4">
            <Avatar name={p.vendor_name} />
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-bold">{p.vendor_name}</h2>
              <p className="text-sm text-cs-soft">
                Invoice {p.invoice_number}
                {p.due_date ? `, due ${day(p.due_date)}` : ', no due date'}
              </p>
              {!p.vendor_known && <p className="mt-1 text-xs font-semibold text-cs-held">Not on your approved vendor list</p>}
              {p.vendor_id && p.reasons.some((r) => r.code === 'VENDOR_UNKNOWN') && (
                <p className="mt-1 text-xs font-semibold text-cs-held">
                  This vendor is deactivated.{' '}
                  <Link href={`/console/vendors/${p.vendor_id}`} className="text-cs-sign underline">
                    Open the vendor
                  </Link>{' '}
                  to approve it again.
                </p>
              )}
            </div>
            <div className="text-right">
              <p className="text-2xl font-bold tabular-nums">{money(p.amount_cents, p.currency)}</p>
              <div className="mt-2">
                <Stamp tone="held" size="sm">
                  Held
                </Stamp>
              </div>
            </div>
          </div>

          <h3 className="mt-6 mb-3 text-sm font-bold">Why it waits for you</h3>
          <Reasons reasons={p.reasons} />

          {review && (
            <div className="mt-6 rounded-xl border border-cs-rule bg-cs-panel p-4">
              <p className="flex flex-wrap items-center gap-2 text-sm font-bold">
                <Sparkles aria-hidden className="size-4 text-cs-sign" /> Second opinion from the AI
                <span className={`ml-auto rounded-full whitespace-nowrap px-2 py-0.5 text-xs font-semibold ${rec === 'deny' ? 'bg-cs-blocked-wash text-cs-blocked' : rec === 'approve' ? 'bg-cs-cleared-wash text-cs-cleared' : 'bg-cs-held-wash text-cs-held'}`}>
                  Suggests: {rec === 'investigate' ? 'check first' : rec}
                </span>
              </p>
              <p className="mt-2 text-sm leading-relaxed text-cs-soft">{review.summary}</p>
              <p className="mt-2 text-xs text-cs-faint">Advice only. The decision is yours, and the rules above still apply.</p>
            </div>
          )}

          <h3 className="mt-6 mb-2 text-sm font-bold">If you approve</h3>
          <ul className="space-y-1.5 text-sm text-cs-soft">
            <li>
              Cosign pays <span className="font-semibold text-cs-ink">{money(p.amount_cents, p.currency)}</span> to <span className="font-semibold text-cs-ink">{p.receiver_email}</span> through PayPal.
            </li>
            <li>Your name and note are sealed into the audit log with this exact decision.</li>
            <li>A payment cannot be recalled once PayPal accepts it.</li>
          </ul>
          <p className="mt-5 text-xs text-cs-faint">
            Decided {when(p.created_at)} under mandate <Hash value={p.mandate_hash} n={10} />. Decision <Hash value={p.decision_hash} n={10} />.
          </p>
        </div>
        <div className="border-t border-cs-rule bg-cs-panel p-5 xl:rounded-r-xl xl:border-t-0 xl:border-l">
          <SignForm
            key={p.payment_id}
            paymentId={p.payment_id}
            decisionHash={p.decision_hash}
            amount={money(p.amount_cents, p.currency)}
            label={`${p.vendor_name} invoice ${p.invoice_number}`}
            newVendor={canApproveVendor(p) ? { name: p.vendor_name, email: p.receiver_email } : undefined}
          />
        </div>
      </div>
    </Card>
  );
}
