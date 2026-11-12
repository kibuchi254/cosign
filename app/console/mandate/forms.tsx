'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { ChevronRight, Search, ShieldCheck, UserPlus } from 'lucide-react';
import { day, money } from '@/lib/cosign-format';
import type { Mandate, Vendor } from '@/lib/cosign-types';
import { addVendor, saveMandate } from '../actions';
import { Submit, useActionToast } from '../client';
import { Avatar, Card, Chip, ErrorNote, Field, inputClass } from '../ui';

const dollars = (cents: number) => (cents / 100).toFixed(2);
const fmt = (v: string, cur: string) => {
  const n = Number(v.replace(/[,$\s]/g, ''));
  return Number.isFinite(n) ? n.toLocaleString('en-US', { style: 'currency', currency: /^[A-Z]{3}$/.test(cur) ? cur : 'USD' }) : v;
};

export function MandateForm({ mandate, defaultExpiry }: { mandate: Mandate | null; defaultExpiry: string }) {
  const [state, action] = useActionState(saveMandate, null);
  useActionToast(state, 'Mandate signed');
  const r = mandate?.rules;
  const [v, setV] = useState({
    per_invoice: r ? dollars(r.per_invoice_cap_cents) : '2000.00',
    daily: r ? dollars(r.daily_cap_cents) : '5000.00',
    currency: r?.currency ?? 'USD',
    expires: defaultExpiry,
    velocity_max: String(r?.velocity_max_payments ?? 5),
    velocity_window: String(r?.velocity_window_minutes ?? 60),
    past_days: String(r?.due_date_max_past_days ?? 60),
    future_days: String(r?.due_date_max_future_days ?? 120),
  });
  const bind = (k: keyof typeof v) => ({ name: k, value: v[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value }) });
  const cur = v.currency.toUpperCase();

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <form action={action}>
        <Card className="p-6">
          <h2 className="font-bold">Limits</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Per invoice" hint="Larger invoices wait for you">
              <input {...bind('per_invoice')} inputMode="decimal" required className={inputClass} />
            </Field>
            <Field label="Per day" hint="Total Cosign may pay in one day">
              <input {...bind('daily')} inputMode="decimal" required className={inputClass} />
            </Field>
            <Field label="Currency" hint="Invoices in other currencies wait for you">
              <input {...bind('currency')} required maxLength={3} className={`${inputClass} uppercase`} />
            </Field>
            <Field label="Valid until" hint="After this, Cosign pays nothing">
              <input {...bind('expires')} type="date" required className={inputClass} />
            </Field>
          </div>
          <h2 className="mt-7 font-bold">Unusual activity</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Payments allowed per window">
              <input {...bind('velocity_max')} type="number" min={1} required className={inputClass} />
            </Field>
            <Field label="Window, in minutes">
              <input {...bind('velocity_window')} type="number" min={1} required className={inputClass} />
            </Field>
            <Field label="Oldest due date, days ago">
              <input {...bind('past_days')} type="number" min={1} required className={inputClass} />
            </Field>
            <Field label="Furthest due date, days ahead">
              <input {...bind('future_days')} type="number" min={1} required className={inputClass} />
            </Field>
          </div>
          <div className="cs-signline mt-8" aria-hidden />
          <p className="mt-1 text-xs text-cs-faint">Signing replaces your current limits from the next invoice on.</p>
          <div className="mt-4 space-y-3">
            {state && !state.ok && <ErrorNote>{state.message}</ErrorNote>}
            <Submit pending="Signing…">Sign this mandate</Submit>
          </div>
        </Card>
      </form>
      <Card className="p-6 lg:sticky lg:top-24">
        <p className="flex items-center gap-2 font-bold">
          <ShieldCheck aria-hidden className="size-5 text-cs-cleared" /> In plain words
        </p>
        <ul className="mt-4 space-y-3 text-sm leading-relaxed text-cs-soft">
          <li>
            Cosign pays an invoice on its own only if it is from an <span className="font-semibold text-cs-ink">approved vendor</span>, to the <span className="font-semibold text-cs-ink">payout email on file</span>, in{' '}
            <span className="font-semibold text-cs-ink">{cur}</span>, and no more than <span className="font-semibold text-cs-ink">{fmt(v.per_invoice, cur)}</span>.
          </li>
          <li>
            It stops paying for the day once it has paid <span className="font-semibold text-cs-ink">{fmt(v.daily, cur)}</span>, and asks you if more than <span className="font-semibold text-cs-ink">{v.velocity_max}</span> payments arrive within{' '}
            <span className="font-semibold text-cs-ink">{v.velocity_window} minutes</span>.
          </li>
          <li>
            Invoices due more than <span className="font-semibold text-cs-ink">{v.past_days} days ago</span> or more than <span className="font-semibold text-cs-ink">{v.future_days} days ahead</span> wait for you.
          </li>
          <li>
            From <span className="font-semibold text-cs-ink">{v.expires ? day(v.expires) : 'the expiry date'}</span>, it pays nothing until you sign a new mandate.
          </li>
          <li>Changed bank details, duplicates and an expired mandate are always blocked. No limit changes that.</li>
        </ul>
      </Card>
    </div>
  );
}

export function VendorDirectory({ vendors }: { vendors: Vendor[] }) {
  const [state, action] = useActionState(addVendor, null);
  useActionToast(state, 'Vendor approved');
  const [q, setQ] = useState('');
  const shown = vendors.filter((v) => `${v.name} ${v.paypal_email}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-cs-rule px-5 py-3.5">
          <p className="text-sm text-cs-soft">Cosign pays these vendors, and only to the email shown. An invoice asking to be paid anywhere else is blocked.</p>
          <label className="relative w-full sm:w-56">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-cs-faint" />
            <input value={q} onChange={(e) => setQ(e.target.value)} type="search" placeholder="Search vendors" aria-label="Search vendors" className={`${inputClass} pl-9`} />
          </label>
        </div>
        {shown.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-cs-soft">{vendors.length ? 'No vendor matches.' : 'No vendors yet. Every invoice will wait for you until you approve some.'}</p>
        ) : (
          <ul className="divide-y divide-cs-rule">
            {shown.map((v) => (
              <li key={v.id}>
                <Link href={`/console/vendors/${v.id}`} className={`group flex items-center gap-3 px-5 py-3.5 hover:bg-cs-hover ${v.active ? '' : 'opacity-70'}`}>
                  <Avatar name={v.name} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-semibold">{v.name}</span>
                      {!v.active && <Chip tone="neutral" icon={false}>Inactive</Chip>}
                    </span>
                    <span className="block truncate text-sm text-cs-soft">{v.paypal_email}</span>
                    <span className="block text-xs text-cs-faint xl:hidden">
                      {money(v.paid_cents, 'USD')} paid · {v.invoices} invoice{v.invoices === 1 ? '' : 's'}
                    </span>
                  </span>
                  <span className="hidden shrink-0 text-right text-xs text-cs-faint xl:block">
                    <span className="block font-semibold text-cs-ink tabular-nums">{money(v.paid_cents, 'USD')}</span>
                    {v.invoices} invoice{v.invoices === 1 ? '' : 's'} · since {day(v.verified_at)}
                  </span>
                  <ChevronRight aria-hidden className="size-4 shrink-0 text-cs-faint group-hover:text-cs-ink" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <form action={action}>
        <Card className="p-6">
          <p className="flex items-center gap-2 font-bold">
            <UserPlus aria-hidden className="size-5 text-cs-sign" /> Approve a vendor
          </p>
          <p className="mt-1 text-sm text-cs-soft">Check the payout email with the vendor through a channel you already trust before you add it.</p>
          <div className="mt-4 space-y-4">
            <Field label="Vendor name">
              <input name="name" required className={inputClass} placeholder="Tailspin Toys" />
            </Field>
            <Field label="PayPal payout email">
              <input name="email" type="email" required className={inputClass} placeholder="payments@tailspin.example" />
            </Field>
            {state && !state.ok && <ErrorNote>{state.message}</ErrorNote>}
            <Submit pending="Approving…">Approve vendor</Submit>
          </div>
        </Card>
      </form>
    </div>
  );
}
