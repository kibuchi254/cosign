'use client';

// "Pay yourself": the real-world loop for anyone trying Cosign. Approve your own PayPal sandbox
// account as a vendor, get an invoice addressed to it, then let Cosign decide. In live mode the
// payout lands in that sandbox account, where you can log in and see it.

import { useActionState, useEffect, useRef, useState } from 'react';
import { ChevronDown, ExternalLink, Wallet } from 'lucide-react';
import { approveMe } from '../../actions';
import { Submit } from '../../client';
import { ErrorNote, Field, inputClass } from '../../ui';

const due = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

export function invoiceFor(name: string, email: string, amount: string): string {
  const initials = name.replace(/[^A-Za-z ]/g, '').split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 3).toUpperCase() || 'INV';
  const no = `${initials}-${Math.floor(1000 + Math.random() * 9000)}`;
  const value = Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `INVOICE

From: ${name}
Invoice No: ${no}
Due date: ${due(14)}

Consulting services                   ${value}
Total due: USD ${value}

Pay to (PayPal): ${email}`;
}

export function PayMe({ live, onFill }: { live: boolean; onFill: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(approveMe, null);
  const handled = useRef<typeof state>(null);

  useEffect(() => {
    if (!state || state === handled.current || !state.ok || !state.name || !state.email || !state.amount) return;
    handled.current = state;
    onFill(invoiceFor(state.name, state.email, state.amount));
  }, [state, onFill]);

  return (
    <div className="cs-card overflow-hidden">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-3 px-5 py-4 text-left hover:bg-cs-hover">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#003087] text-white">
          <Wallet aria-hidden className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold">Pay yourself through PayPal</span>
          <span className="block text-xs text-cs-soft">
            {live ? 'Use your own PayPal sandbox account and watch a real sandbox payout arrive.' : 'Approve your own account as a vendor and send it an invoice (payouts are simulated here).'}
          </span>
        </span>
        <ChevronDown aria-hidden className={`size-4 shrink-0 text-cs-faint transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <form action={action} className="space-y-4 border-t border-cs-rule px-5 pt-4 pb-5">
          <ol className="list-decimal space-y-1 pl-5 text-xs text-cs-soft">
            <li>
              In the{' '}
              <a href="https://developer.paypal.com/dashboard/accounts" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-semibold text-cs-sign hover:underline">
                PayPal developer dashboard <ExternalLink aria-hidden className="size-3" />
              </a>
              , copy the email of a <b>personal</b> sandbox account.
            </li>
            <li>Approve it here. That is the same step a business takes before Cosign may pay a new supplier.</li>
            <li>Cosign writes an invoice to you. Press <b>Read and decide</b>, then sign in to sandbox.paypal.com as that account to see the money.</li>
          </ol>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_8rem]">
            <Field label="Your business name">
              <input name="name" required maxLength={60} placeholder="Jane's Studio" className={inputClass} />
            </Field>
            <Field label="PayPal sandbox email">
              <input name="email" type="email" required placeholder="sb-xxxx@personal.example.com" className={inputClass} />
            </Field>
            <Field label="Amount, USD">
              <input name="amount" type="number" min="0.01" max="1000" step="0.01" defaultValue="25.00" required className={inputClass} />
            </Field>
          </div>
          {state && !state.ok && <ErrorNote>{state.message}</ErrorNote>}
          {state?.ok && <p className="text-sm font-semibold text-cs-cleared">{state.message} The invoice is filled in below.</p>}
          <Submit pending="Approving…">Approve me and write the invoice</Submit>
        </form>
      )}
    </div>
  );
}
