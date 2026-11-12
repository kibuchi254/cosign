import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { connection } from 'next/server';
import { ArrowUpRight, Ban, CircleCheck, FileUp, Hourglass, Landmark, ShieldCheck, TrendingDown, TrendingUp } from 'lucide-react';
import { getAudit, getDeals, getLedger } from '@/lib/cosign';
import { ago, AUDIT_KIND, auditDetail, auditTone, money, REASON_LABEL, type Tone } from '@/lib/cosign-format';
import type { ReactNode } from 'react';
import type { LedgerPayment, ReasonCode } from '@/lib/cosign-types';
import { SESSION_COOKIE, verify } from '@/lib/session';
import { QuickApprove } from './quick-approve';
import { SpendChart, type DayBucket } from './spend-chart';
import { Avatar, ButtonLink, Card, Chip, CoreDown } from './ui';

export const metadata: Metadata = { title: 'Overview' };

const DAY = 86_400_000;
const COMMITTED = new Set(['ALLOWED', 'APPROVED', 'SUBMITTED', 'PAID']);

export default async function Overview() {
  await connection();
  let ledger, deals, audit;
  try {
    [ledger, deals, audit] = await Promise.all([getLedger(), getDeals(), getAudit(40)]);
  } catch (e) {
    return <CoreDown error={e} />;
  }
  const session = await verify((await cookies()).get(SESSION_COOKIE)?.value);
  const name = (session?.name ?? 'there').split(' ')[0];
  const m = ledger.mandate;
  const cur = m?.rules.currency ?? 'USD';
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const inCur = ledger.payments.filter((p) => p.currency === cur);
  const sum = (ps: LedgerPayment[]) => ps.reduce((s, p) => s + p.amount_cents, 0);
  const within = (p: LedgerPayment, from: number, to: number) => {
    const t = new Date(p.created_at).getTime();
    return t >= from && t < to;
  };
  const t0 = now.getTime();

  // KPIs
  const paid7 = sum(inCur.filter((p) => p.state === 'PAID' && within(p, t0 - 7 * DAY, t0 + 1)));
  const paidPrev7 = sum(inCur.filter((p) => p.state === 'PAID' && within(p, t0 - 14 * DAY, t0 - 7 * DAY)));
  const waiting = ledger.payments.filter((p) => p.state === 'NEEDS_APPROVAL');
  const blocked7 = inCur.filter((p) => p.state === 'BLOCKED' && within(p, t0 - 7 * DAY, t0 + 1));
  const heldEscrow = deals.reduce((s, d) => s + d.held_cents, 0);
  const heldDeliveries = deals.flatMap((d) => d.milestones.filter((x) => x.state === 'DELIVERED' && x.hold_reasons.length && !x.buyer_accepted_hold));
  const spentToday = sum(inCur.filter((p) => p.created_at.startsWith(today) && COMMITTED.has(p.state)));
  const cap = m?.rules.daily_cap_cents ?? 0;
  const pct = cap ? Math.min(100, Math.round((spentToday / cap) * 100)) : 0;

  // Chart: 14 days, oldest first.
  const days: DayBucket[] = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(t0 - (13 - i) * DAY).toISOString().slice(0, 10);
    const ps = inCur.filter((p) => p.created_at.startsWith(d));
    return {
      day: d,
      label: new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
      paid: sum(ps.filter((p) => p.state === 'PAID')),
      held: sum(ps.filter((p) => p.state === 'NEEDS_APPROVAL')),
      blocked: sum(ps.filter((p) => p.state === 'BLOCKED')),
      paidCount: ps.filter((p) => p.state === 'PAID').length,
    };
  });

  // What Cosign stopped, by reason.
  const stopped = ledger.payments.filter((p) => p.decision !== 'ALLOW');
  const byReason = new Map<ReasonCode, number>();
  for (const p of stopped) for (const r of p.reasons) byReason.set(r.code, (byReason.get(r.code) ?? 0) + 1);
  const topReasons = [...byReason.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxReason = Math.max(1, ...topReasons.map(([, n]) => n));
  const protectedCents = sum(ledger.payments.filter((p) => p.state === 'BLOCKED' || p.state === 'DENIED'));

  const needs = waiting.length + heldDeliveries.length;
  // A guided tour of the product, ticked off from real data, so anyone trying Cosign (a judge,
  // a new customer) walks every decision path once and ends by paying their own PayPal account.
  const moved = new Set(['APPROVED', 'SUBMITTED', 'PAID']);
  const setup = [
    ...(!m ? [{ done: false, label: 'Sign a mandate', hint: 'Your limits, in writing', href: '/console/mandate' }] : []),
    { done: ledger.payments.some((p) => p.decision === 'ALLOW'), label: 'Pay a routine bill', hint: 'Add an invoice, then A normal bill', href: '/console/invoices/new' },
    { done: ledger.payments.some((p) => p.decision === 'BLOCK'), label: 'Stop an attack', hint: 'Changed bank details and a prompt injection', href: '/console/invoices/new' },
    { done: ledger.payments.some((p) => p.decision === 'REQUIRE_APPROVAL' && moved.has(p.state)), label: 'Sign an exception', hint: 'Approve a held bill', href: waiting.length ? '/console/inbox' : '/console/invoices/new' },
    {
      done: ledger.payments.some((p) => !p.receiver_email.endsWith('.example') && moved.has(p.state)),
      label: 'Pay yourself',
      hint: ledger.simulation ? 'Your own account as a vendor' : 'A real PayPal sandbox payout',
      href: '/console/invoices/new',
    },
    { done: deals.some((d) => d.milestones.some((x) => x.state !== 'DRAFT')), label: 'Hold money in escrow', hint: 'Fund a milestone stage', href: '/console/milestones#new-deal' },
  ];
  const setupLeft = setup.filter((s) => !s.done).length;
  const delta = paidPrev7 ? Math.round(((paid7 - paidPrev7) / paidPrev7) * 100) : null;

  return (
    <div className="mx-auto max-w-7xl">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-cs-soft">Welcome back, {name}</p>
          <h1 className="mt-1 text-2xl leading-tight font-bold tracking-tight sm:text-[1.75rem]">
            {needs > 0 ? `${needs} ${needs === 1 ? 'thing needs' : 'things need'} your signature` : 'All clear. Nothing needs you.'}
          </h1>
          <p className="mt-1 text-sm text-cs-soft">
            {ledger.payments.length === 0
              ? 'Add an invoice to see Cosign decide.'
              : `Cosign paid ${ledger.totals.counts.paid} invoice${ledger.totals.counts.paid === 1 ? '' : 's'} inside your mandate and stopped ${ledger.totals.counts.blocked}.`}
          </p>
        </div>
        <div className="flex gap-2">
          {needs > 0 && (
            <ButtonLink href="/console/inbox">
              <Hourglass aria-hidden className="size-4" /> Review {needs}
            </ButtonLink>
          )}
          <ButtonLink href="/console/invoices/new" variant={needs > 0 ? 'quiet' : 'primary'}>
            <FileUp aria-hidden className="size-4" /> Add an invoice
          </ButtonLink>
        </div>
      </header>

      {setupLeft > 0 && (
        <Card className="mb-6 p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="font-bold">Try Cosign end to end</h2>
              <p className="text-sm text-cs-soft">Each step is a real decision path. Ticks come from what Cosign actually did.</p>
            </div>
            <p className="text-sm text-cs-soft">
              {setup.length - setupLeft} of {setup.length} done
            </p>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-cs-rule">
            <div className="h-full rounded-full bg-cs-cleared" style={{ width: `${((setup.length - setupLeft) / setup.length) * 100}%` }} />
          </div>
          <ol className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {setup.map((s, i) => (
              <li key={s.label}>
                <Link
                  href={s.href}
                  className={`flex h-full items-start gap-3 rounded-lg border px-3 py-2.5 text-sm ${s.done ? 'border-cs-rule bg-cs-panel' : 'border-cs-edge hover:border-cs-sign hover:bg-cs-sign-wash'}`}
                >
                  {s.done ? (
                    <CircleCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-cs-cleared" />
                  ) : (
                    <span aria-hidden className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-cs-edge text-[11px] font-bold text-cs-soft">
                      {i + 1}
                    </span>
                  )}
                  <span className="min-w-0">
                    <span className={`block font-semibold ${s.done ? 'text-cs-faint line-through' : 'text-cs-ink'}`}>{s.label}</span>
                    <span className="block text-xs text-cs-soft">{s.hint}</span>
                  </span>
                  <span className="sr-only">{s.done ? '(done)' : '(to do)'}</span>
                </Link>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <Kpi
          label="Paid, last 7 days"
          value={money(paid7, cur)}
          icon={CircleCheck}
          tone="cleared"
          foot={
            delta === null ? (
              'Paid automatically or after your signature'
            ) : (
              <span className={`inline-flex items-center gap-1 ${delta >= 0 ? 'text-cs-cleared' : 'text-cs-soft'}`}>
                {delta >= 0 ? <TrendingUp className="size-3.5" aria-hidden /> : <TrendingDown className="size-3.5" aria-hidden />}
                {delta >= 0 ? '+' : ''}
                {delta}% on the week before
              </span>
            )
          }
        />
        <Kpi label="Waiting for you" value={String(needs)} icon={Hourglass} tone="held" href="/console/inbox" foot={`${money(ledger.totals.awaiting_approval_cents, cur)} in invoices${heldDeliveries.length ? `, ${heldDeliveries.length} held delivery` : ''}`} />
        <Kpi label="Stopped, last 7 days" value={String(blocked7.length)} icon={Ban} tone="blocked" href="/console/payments?status=BLOCKED" foot={`${money(sum(blocked7), cur)} that never left your account`} />
        <Kpi label="Held in escrow" value={money(heldEscrow, cur)} icon={Landmark} tone="sign" href="/console/milestones" foot="Reserved for milestones, not yet paid" />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2" title="Paid per day" aside={<span className="text-cs-faint"><span className="sm:hidden">Last 7 days</span><span className="hidden sm:inline">Last 14 days</span>, {cur}</span>}>
          <div className="px-3 pt-4 pb-2">
            <div className="sm:hidden"><SpendChart days={days.slice(-7)} currency={cur} compact /></div>
            <div className="hidden sm:block"><SpendChart days={days} currency={cur} /></div>
          </div>
        </Card>
        <Card title="Today against your limit" aside={<Link href="/console/mandate" className="font-semibold text-cs-sign hover:underline">Change</Link>}>
          <div className="p-5">
            <p className="text-3xl font-bold tabular-nums">{money(spentToday, cur)}</p>
            <p className="text-sm text-cs-soft">of {money(cap, cur)} daily limit</p>
            <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-cs-rule" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Daily limit used">
              <div className={`h-full rounded-full ${pct >= 90 ? 'bg-cs-held' : 'bg-cs-sign'}`} style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-2 text-sm font-semibold">{money(Math.max(0, cap - spentToday), cur)} left today</p>
            {m && (
              <dl className="mt-5 grid grid-cols-2 gap-3 border-t border-cs-rule pt-4 text-sm">
                <div>
                  <dt className="text-cs-faint">Per invoice</dt>
                  <dd className="font-semibold">{money(m.rules.per_invoice_cap_cents, cur)}</dd>
                </div>
                <div>
                  <dt className="text-cs-faint">Payments per {m.rules.velocity_window_minutes} min</dt>
                  <dd className="font-semibold">{m.rules.velocity_max_payments}</dd>
                </div>
              </dl>
            )}
            <p className="mt-4 text-xs text-cs-faint">Anything that would pass a limit waits for you instead of being paid.</p>
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2" title="Needs your signature" aside={waiting.length > 0 && <Link href="/console/inbox" className="font-semibold text-cs-sign hover:underline">Open inbox</Link>}>
          {waiting.length === 0 ? (
            <p className="flex items-center gap-2 px-5 py-8 text-sm text-cs-soft">
              <ShieldCheck aria-hidden className="size-5 text-cs-cleared" /> Nothing waiting. Everything inside your mandate was paid on its own.
            </p>
          ) : (
            <ul className="divide-y divide-cs-rule">
              {waiting.slice(0, 5).map((p) => (
                <li key={p.payment_id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3.5">
                  <Avatar name={p.vendor_name} />
                  <Link href={`/console/inbox?id=${p.payment_id}`} className="min-w-[9rem] flex-1 hover:underline">
                    <p className="truncate font-semibold">{p.vendor_name}</p>
                    <p className="truncate text-sm text-cs-soft">{p.reasons[0] ? REASON_LABEL[p.reasons[0].code] : 'Needs a look'}</p>
                  </Link>
                  <p className="font-semibold tabular-nums">{money(p.amount_cents, p.currency)}</p>
                  <QuickApprove paymentId={p.payment_id} decisionHash={p.decision_hash} label={`${p.vendor_name} invoice ${p.invoice_number}`} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="What Cosign stopped" aside={<span className="text-cs-faint">All time</span>}>
          <div className="p-5">
            <p className="text-3xl font-bold tabular-nums">{money(protectedCents, cur)}</p>
            <p className="text-sm text-cs-soft">blocked or denied, never paid</p>
            {topReasons.length > 0 ? (
              <ul className="mt-5 space-y-3">
                {topReasons.map(([code, n]) => (
                  <li key={code} className="text-sm">
                    <div className="flex justify-between gap-3">
                      <span className="truncate">{REASON_LABEL[code]}</span>
                      <span className="font-semibold tabular-nums">{n}</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-cs-rule">
                      <div className="h-full rounded-full bg-cs-ink-soft" style={{ width: `${(n / maxReason) * 100}%`, background: 'var(--cs-ink-soft)' }} />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-5 text-sm text-cs-soft">Nothing has been stopped yet.</p>
            )}
          </div>
        </Card>
      </div>

      <Card className="mt-4" title="Recent activity" aside={<Link href="/console/audit" className="font-semibold text-cs-sign hover:underline">Audit log</Link>}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-cs-rule bg-cs-panel px-5 py-2.5 text-xs text-cs-soft">
          <Chip tone={ledger.audit.ok ? 'cleared' : 'blocked'}>{ledger.audit.ok ? 'Audit chain intact' : `Chain broken at entry ${ledger.audit.first_broken_seq}`}</Chip>
          <span>{ledger.audit.entries} sealed entries</span>
        </div>
        <ol className="divide-y divide-cs-rule">
          {[...audit].reverse().slice(0, 8).map((e) => (
            <li key={e.seq} className="flex items-center gap-3 px-5 py-3 text-sm">
              <ToneDot tone={auditTone(e)} />
              <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:gap-3">
                <span className="shrink-0 font-semibold sm:w-44">{AUDIT_KIND[e.kind] ?? e.kind}</span>
                <span className="min-w-0 truncate text-cs-soft">{auditDetail(e)}</span>
              </span>
              <span className="shrink-0 text-xs text-cs-faint">{ago(e.ts)}</span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

const KPI_TONE: Record<Tone, string> = {
  cleared: 'bg-cs-cleared-wash text-cs-cleared',
  held: 'bg-cs-held-wash text-cs-held',
  blocked: 'bg-cs-blocked-wash text-cs-blocked',
  neutral: 'bg-cs-rule text-cs-soft',
  sign: 'bg-cs-sign-wash text-cs-sign',
};

function Kpi({ label, value, icon: Icon, tone, foot, href }: { label: string; value: string; icon: typeof CircleCheck; tone: Tone; foot: ReactNode; href?: string }) {
  const body = (
    <>
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-cs-soft sm:text-sm">{label}</p>
        <span className={`flex size-7 shrink-0 items-center sm:size-8 justify-center rounded-lg ${KPI_TONE[tone]}`}>
          <Icon aria-hidden className="size-4" />
        </span>
      </div>
      <p className="mt-3 text-[1.35rem] leading-none font-bold tracking-tight tabular-nums sm:text-[1.9rem]">{value}</p>
      <p className="mt-2 flex items-start gap-1 text-xs text-cs-soft">
        <span className="line-clamp-2">{foot}</span>
        {href && <ArrowUpRight aria-hidden className="ml-auto size-4 text-cs-faint" />}
      </p>
    </>
  );
  return href ? (
    <Link href={href} className="cs-card block p-4 hover:border-cs-sign sm:p-5">
      {body}
    </Link>
  ) : (
    <div className="cs-card p-4 sm:p-5">{body}</div>
  );
}

const DOT: Record<Tone, string> = { cleared: 'bg-cs-cleared', held: 'bg-cs-held', blocked: 'bg-cs-blocked', neutral: 'bg-cs-faint', sign: 'bg-cs-sign' };
function ToneDot({ tone }: { tone: Tone }) {
  return <span aria-hidden className={`size-2 shrink-0 rounded-full ${DOT[tone]}`} />;
}
