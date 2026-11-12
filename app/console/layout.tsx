import { cookies } from 'next/headers';
import { connection } from 'next/server';
import { getDeals, getLedger, getVendors } from '@/lib/cosign';
import { day, money } from '@/lib/cosign-format';
import { SESSION_COOKIE, verify } from '@/lib/session';
import { logout } from '../login/actions';
import { Shell, type Notice, type SearchItem } from './shell';

const PAGES: SearchItem[] = [
  { group: 'Pages', label: 'Overview', href: '/console' },
  { group: 'Pages', label: 'Needs your signature', hint: 'Approvals', href: '/console/inbox' },
  { group: 'Pages', label: 'All payments', href: '/console/payments' },
  { group: 'Pages', label: 'Milestones', hint: 'Escrow', href: '/console/milestones' },
  { group: 'Pages', label: 'Mandate and vendors', hint: 'Limits', href: '/console/mandate' },
  { group: 'Pages', label: 'Audit log', href: '/console/audit' },
  { group: 'Pages', label: 'Reports', href: '/console/report' },
  { group: 'Actions', label: 'Add an invoice', hint: 'Upload or paste', href: '/console/invoices/new' },
  { group: 'Actions', label: 'Start a milestone deal', href: '/console/milestones#new-deal' },
  { group: 'Actions', label: 'Approve a vendor', href: '/console/mandate?tab=vendors' },
  { group: 'Actions', label: 'Change your limits', href: '/console/mandate' },
];

/** Two weeks' warning before the mandate lapses. */
function expiresSoon(iso: string): boolean {
  return new Date(iso).getTime() - new Date().getTime() < 14 * 86_400_000;
}

export default async function ConsoleLayout({ children }: LayoutProps<'/console'>) {
  await connection();
  const session = await verify((await cookies()).get(SESSION_COOKIE)?.value);
  // The shell still renders if the core is down; each page explains the error itself.
  const [ledger, deals, vendors] = await Promise.all([getLedger().catch(() => null), getDeals().catch(() => []), getVendors().catch(() => [])]);
  const m = ledger?.mandate;
  const waiting = ledger?.payments.filter((p) => p.state === 'NEEDS_APPROVAL') ?? [];
  const held = deals.flatMap((d) => d.milestones.filter((x) => x.state === 'DELIVERED' && x.hold_reasons.length && !x.buyer_accepted_hold).map((x) => ({ d, x })));

  const notices: Notice[] = [
    ...waiting.map((p) => ({ tone: 'held' as const, title: `${p.vendor_name} wants ${money(p.amount_cents, p.currency)}`, body: p.reasons[0]?.detail ?? 'Needs your signature', href: `/console/inbox?id=${p.payment_id}` })),
    ...held.map(({ d, x }) => ({ tone: 'held' as const, title: `Delivery held: ${x.title}`, body: `${d.title}. ${x.hold_reasons[0]?.detail ?? ''}`, href: `/console/milestones#${x.id}` })),
    ...(m && expiresSoon(m.expires_at)
      ? [{ tone: 'blocked' as const, title: 'Your mandate expires soon', body: `On ${day(m.expires_at)}. After that Cosign pays nothing.`, href: '/console/mandate' }]
      : []),
  ];

  const search: SearchItem[] = [
    ...PAGES,
    ...(ledger?.payments ?? []).slice(0, 200).map((p) => ({
      group: 'Payments' as const,
      label: `${p.vendor_name} #${p.invoice_number}`,
      hint: money(p.amount_cents, p.currency),
      href: `/console/payments?id=${p.payment_id}`,
    })),
    ...vendors.map((v) => ({ group: 'Vendors' as const, label: v.name, hint: v.paypal_email, href: '/console/mandate?tab=vendors' })),
    ...deals.map((d) => ({ group: 'Deals' as const, label: d.title, hint: d.seller, href: `/console/milestones#${d.milestones[0]?.id ?? ''}` })),
  ];

  return (
    <Shell
      user={session?.name ?? 'Owner'}
      waiting={waiting.length + held.length}
      simulation={ledger ? ledger.simulation : null}
      mandateLine={m ? `${money(m.rules.per_invoice_cap_cents, m.rules.currency)} per invoice, ${money(m.rules.daily_cap_cents, m.rules.currency)} a day, until ${day(m.expires_at)}` : null}
      search={search}
      notices={notices}
      logout={logout}
    >
      {children}
    </Shell>
  );
}
