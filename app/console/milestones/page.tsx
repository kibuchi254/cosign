import type { Metadata } from 'next';
import { connection } from 'next/server';
import { Landmark, Plus } from 'lucide-react';
import { getDeals } from '@/lib/cosign';
import { money } from '@/lib/cosign-format';
import type { Deal } from '@/lib/cosign-types';
import { Avatar, ButtonLink, Card, CoreDown, Empty, PageHead, Section } from '../ui';
import { DealForm, MilestoneCard } from './milestone-ui';

export const metadata: Metadata = { title: 'Milestones' };

export default async function Milestones() {
  await connection();
  let deals: Deal[];
  try {
    deals = await getDeals();
  } catch (e) {
    return <CoreDown error={e} />;
  }
  const total = deals.reduce((s, d) => s + d.total_cents, 0);
  const held = deals.reduce((s, d) => s + d.held_cents, 0);
  const released = deals.reduce((s, d) => s + d.released_cents, 0);
  const needsYou = deals.flatMap((d) => d.milestones).filter((m) => (m.state === 'DELIVERED' && m.hold_reasons.length && !m.buyer_accepted_hold) || m.state === 'VERIFIED').length;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHead
        title="Milestones"
        lede="Pay for work in stages. Funding a stage puts a PayPal hold on the money. The agent checks each delivery against your criteria, and nothing reaches the seller until you release it."
        actions={
          <ButtonLink href="#new-deal">
            <Plus aria-hidden className="size-4" /> New deal
          </ButtonLink>
        }
      />
      {deals.length > 0 && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ['In active deals', money(total)],
            ['Held in escrow', money(held)],
            ['Released to sellers', money(released)],
            ['Waiting for you', String(needsYou)],
          ].map(([label, value]) => (
            <div key={label} className="cs-card p-4">
              <p className="text-sm text-cs-soft">{label}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
            </div>
          ))}
        </div>
      )}
      {deals.length === 0 && (
        <Empty title="No deals yet" icon={Landmark} action={<ButtonLink href="#new-deal">Start a deal</ButtonLink>}>
          The form below starts with a two-stage website project you can use as it is.
        </Empty>
      )}
      <div className="space-y-6">
        {deals.map((d) => {
          const pct = d.total_cents ? Math.round((d.released_cents / d.total_cents) * 100) : 0;
          const heldPct = d.total_cents ? Math.round((d.held_cents / d.total_cents) * 100) : 0;
          return (
            <Card key={d.id}>
              <div className="flex flex-wrap items-center gap-4 border-b border-cs-rule p-5">
                <Avatar name={d.seller} />
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-bold">{d.title}</h2>
                  <p className="text-sm text-cs-soft">
                    {d.seller}, paid to {d.seller_email}
                  </p>
                </div>
                <div className="w-full sm:w-72">
                  <div className="flex justify-between text-xs text-cs-soft">
                    <span>
                      <span className="font-semibold text-cs-ink">{money(d.released_cents)}</span> released of {money(d.total_cents)}
                    </span>
                    <span>{money(d.held_cents)} held</span>
                  </div>
                  <div className="mt-1.5 flex h-2 gap-0.5 overflow-hidden rounded-full bg-cs-rule" aria-label={`${pct}% released, ${heldPct}% held`}>
                    <div className="h-full rounded-full bg-cs-cleared" style={{ width: `${pct}%` }} />
                    <div className="h-full rounded-full bg-cs-sign" style={{ width: `${heldPct}%` }} />
                  </div>
                </div>
              </div>
              <ol className="grid items-start gap-4 p-5 lg:grid-cols-2 2xl:grid-cols-3">
                {d.milestones.map((m) => (
                  <MilestoneCard key={m.id} m={m} />
                ))}
              </ol>
            </Card>
          );
        })}
      </div>
      <Section title="Start a deal" id="new-deal">
        <DealForm />
      </Section>
    </div>
  );
}
